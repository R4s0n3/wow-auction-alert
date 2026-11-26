import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ScanItem } from "../db/repo.ts";
import type { LuaValue } from "./luaParse.ts";

export const ADDON_NAME = "WowAhPrediction";

const REGIONS: Record<number, string> = { 1: "us", 2: "kr", 3: "eu", 4: "tw", 5: "cn" };

export interface AddonScan {
  realm: string;
  faction: string;
  region: number;
  scannedAt: number;
  items: ScanItem[];
}

const hasAddon = (dir: string) => existsSync(join(dir, "Interface", "AddOns", ADDON_NAME));

/**
 * Findet den Spielordner mit dem installierten Addon. `wowDir` darf der
 * Flavor-Ordner selbst sein (mit Interface/ und WTF/) oder der WoW-Hauptordner,
 * dann werden Unterordner wie _forever_ oder _classic_era_ durchsucht.
 */
export function findGameDir(wowDir: string): string | null {
  if (hasAddon(wowDir)) return wowDir;
  if (!existsSync(wowDir)) return null;
  const flavors = readdirSync(wowDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^_.+_$/.test(e.name))
    .map((e) => join(wowDir, e.name))
    .filter(hasAddon);
  // _forever_ zuerst, falls mehrere Flavors das Addon haben
  flavors.sort((a, b) => Number(b.includes("forever")) - Number(a.includes("forever")));
  return flavors[0] ?? null;
}

/** Alle SavedVariables-Dateien des Addons, über alle Accounts. */
export function savedVariablesFiles(gameDir: string): string[] {
  const accountsDir = join(gameDir, "WTF", "Account");
  if (!existsSync(accountsDir)) return [];
  return readdirSync(accountsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(accountsDir, e.name, "SavedVariables", `${ADDON_NAME}.lua`))
    .filter((p) => existsSync(p) && statSync(p).isFile());
}

export const dataLuaPath = (gameDir: string) => join(gameDir, "Interface", "AddOns", ADDON_NAME, "Data.lua");

function slug(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** "EU" + "Everlook" + "Alliance" → "eu-everlook-alliance" (jede Fraktion hat ihr eigenes AH) */
export function realmKey(scan: Pick<AddonScan, "region" | "realm" | "faction">): string {
  return [REGIONS[scan.region] ?? "xx", scan.realm, scan.faction].map(slug).filter(Boolean).join("-").slice(0, 64);
}

const isObject = (v: LuaValue | undefined): v is { [key: string]: LuaValue } =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const positiveInt = (v: LuaValue | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.round(v) : null;

type Info = Pick<ScanItem, "name" | "quality" | "category" | "classId" | "subclassId">;
const intIn = (v: LuaValue | undefined, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;

/** Name, Qualität, Kategorie, Itemklasse aus WAHP_DB.itemInfo, nur was plausibel ist */
function itemInfo(v: LuaValue | undefined): Info {
  if (!isObject(v)) return {};
  const out: Info = {};
  if (typeof v.n === "string" && v.n.length > 0 && v.n.length <= 120) out.name = v.n;
  if (intIn(v.ql, 8)) out.quality = v.ql;
  if (typeof v.c === "string" && v.c.length > 0 && v.c.length <= 80) out.category = v.c;
  if (intIn(v.cls, 30)) out.classId = v.cls;
  if (intIn(v.sub, 60)) out.subclassId = v.sub;
  return out;
}

/** Holt die Scans aus WAHP_DB und wirft kaputte Einträge raus. */
export function extractScans(db: LuaValue | undefined): AddonScan[] {
  if (!isObject(db)) return [];
  const info = isObject(db.itemInfo) ? db.itemInfo : {};
  const raw = db.scans;
  const list = Array.isArray(raw) ? raw : isObject(raw) ? Object.values(raw) : [];
  const scans: AddonScan[] = [];
  for (const s of list) {
    if (!isObject(s) || typeof s.realm !== "string" || !isObject(s.items)) continue;
    const scannedAt = positiveInt(s.scannedAt);
    if (scannedAt === null) continue;
    const items: ScanItem[] = [];
    for (const [id, entry] of Object.entries(s.items)) {
      const itemId = Number(id);
      if (!Number.isInteger(itemId) || itemId <= 0 || !isObject(entry)) continue;
      const minBuyout = positiveInt(entry.min);
      if (minBuyout === null) continue;
      items.push({
        itemId,
        minBuyout,
        marketPrice: positiveInt(entry.mkt) ?? undefined,
        quantity: positiveInt(entry.q) ?? 0,
        ...itemInfo(info[id]),
      });
    }
    if (items.length === 0) continue;
    scans.push({
      realm: s.realm,
      faction: typeof s.faction === "string" ? s.faction : "",
      region: typeof s.region === "number" ? s.region : 0,
      scannedAt,
      items,
    });
  }
  return scans;
}
