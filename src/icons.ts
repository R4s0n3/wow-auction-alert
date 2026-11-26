// Item-Infos von Wowhead (Forever-Datenbank, enthält auch die neuen Forever-Items).
// Ein Tooltip-Aufruf pro Item liefert den Icon-Namen, eine Kategorie (aus dem
// Tooltip-Text) und bei Abgefangenen Kisten, womit man sie füllt. Die Bilder kommen
// vom Wowhead-CDN. Ergebnisse landen in der items-Tabelle, gefragt wird nur einmal.
import { htmlToText } from "./ai/sources.ts";
import { CRATE_PREFIX, kindFromTooltip, parseCrateNeeds } from "./categories.ts";
import type { Repo } from "./db/repo.ts";

const TOOLTIP = (itemId: number) => `https://nether.wowhead.com/forever/tooltip/item/${itemId}?locale=3`;
const ICON_RE = /^[a-z0-9_-]{1,100}$/i;
/** Items ohne Icon (unbekannt bei Wowhead) erst nach einer Woche nochmal fragen */
const RECHECK_MS = 7 * 86_400_000;

export type IconSize = "large" | "medium" | "small"; // 56, 36, 18 px

export const iconUrl = (icon: string, size: IconSize = "large") => `https://wow.zamimg.com/images/wow/icons/${size}/${icon}.jpg`;
export const wowheadUrl = (itemId: number) => `https://www.wowhead.com/forever/de/item=${itemId}`;

export interface ItemLookup {
  icon: string | null;
  quality: number | null;
  name: string | null;
  /** Kategorie aus dem Tooltip-Text, null wenn nicht eindeutig */
  kind: string | null;
  /** Nur bei Abgefangenen Kisten: womit man sie füllt */
  crateNeeds: Array<{ count: number; name: string }>;
}

/** Fragt Wowhead nach einem Item. null bei Netzwerkfehler (dann später nochmal), sonst das Ergebnis, auch wenn leer. */
export async function lookupItem(itemId: number, fetchImpl: typeof fetch = fetch): Promise<ItemLookup | null> {
  let res: Response;
  try {
    res = await fetchImpl(TOOLTIP(itemId), { headers: { accept: "application/json", "user-agent": "wahp-server/1.0" } });
  } catch {
    return null;
  }
  if (res.status === 404) return { icon: null, quality: null, name: null, kind: null, crateNeeds: [] };
  if (!res.ok) return null;
  const d = (await res.json().catch(() => null)) as { icon?: unknown; quality?: unknown; name?: unknown; tooltip?: unknown } | null;
  const name = typeof d?.name === "string" && d.name.length > 0 && d.name.length <= 120 ? d.name : null;
  const text = typeof d?.tooltip === "string" ? htmlToText(d.tooltip) : "";
  return {
    icon: typeof d?.icon === "string" && ICON_RE.test(d.icon) ? d.icon.toLowerCase() : null,
    quality: Number.isInteger(d?.quality) && (d!.quality as number) >= 0 && (d!.quality as number) <= 8 ? (d!.quality as number) : null,
    name,
    kind: text ? kindFromTooltip(name ?? "", text) : null,
    crateNeeds: name?.startsWith(CRATE_PREFIX) ? parseCrateNeeds(text) : [],
  };
}

/** Alter Name */
export const lookupIcon = lookupItem;

/**
 * Holt fehlende Icons und Kategorien, höchstens `max` pro Aufruf und wenige Anfragen
 * gleichzeitig, damit Wowhead nicht überrannt wird. `force`: auch wenn schon bekannt
 * (für Kisten, deren Inhalt noch fehlt). Gibt die Anzahl neu gefundener Icons zurück.
 */
export async function resolveItemMeta(
  repo: Repo,
  itemIds: number[],
  opts: { now?: number; fetchImpl?: typeof fetch; concurrency?: number; max?: number; force?: boolean } = {},
): Promise<number> {
  const now = opts.now ?? Date.now();
  const unique = [...new Set(itemIds)];
  const todo = (opts.force ? unique : repo.missingMeta(unique, now - RECHECK_MS)).slice(0, opts.max ?? 300);
  let next = 0;
  let found = 0;
  const workers = Array.from({ length: Math.min(opts.concurrency ?? 4, todo.length) }, async () => {
    while (next < todo.length) {
      const itemId = todo[next++]!;
      const info = await lookupItem(itemId, opts.fetchImpl);
      if (!info) continue; // Netz weg: beim nächsten Durchlauf nochmal
      repo.setItemMeta(itemId, { icon: info.icon, quality: info.quality, name: info.name, kind: info.kind }, now);
      if (info.crateNeeds.length > 0) repo.setCrateNeeds(itemId, info.crateNeeds);
      if (info.icon) found += 1;
    }
  });
  await Promise.all(workers);
  return found;
}

/** Alter Name */
export const resolveIcons = resolveItemMeta;

/** Icons für eine Liste von Items, nur die bekannten */
export function iconsFor(repo: Repo, itemIds: number[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const [id, meta] of repo.itemMeta(itemIds)) if (meta.icon) out.set(id, meta.icon);
  return out;
}
