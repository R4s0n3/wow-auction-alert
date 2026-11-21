import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/api/server.ts";
import type { CompanionConfig } from "../src/companion/config.ts";
import { parseSavedVariables } from "../src/companion/luaParse.ts";
import { Companion } from "../src/companion/sync.ts";
import { extractScans, findGameDir, realmKey } from "../src/companion/wow.ts";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db/database.ts";
import { Repo } from "../src/db/repo.ts";
import { LiveHub } from "../src/live/hub.ts";
import { DAY, EVENT_MS, testKnowledge } from "./fixtures.ts";

// So schreibt WoW SavedVariables: Keys in Klammern, "-- [n]" hinter Array-Einträgen.
const SV = `
WAHP_DB = {
["scans"] = {
{
["faction"] = "Alliance",
["items"] = {
[4] = {
["min"] = 100,
["mkt"] = 3800,
["q"] = 101,
},
[1] = {
["min"] = 950000,
["mkt"] = 950000,
["q"] = 2,
},
[99] = {
["min"] = 0,
},
},
["realm"] = "Everlook",
["region"] = 3,
["scannedAt"] = ${Math.floor((EVENT_MS - 25 * DAY) / 1000) - 600},
}, -- [1]
},
["version"] = 1,
}
`;

const tmpDirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "wahp-"));
  tmpDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("parseSavedVariables", () => {
  test("liest das WoW-Format inklusive Kommentaren", () => {
    const { WAHP_DB } = parseSavedVariables(SV) as { WAHP_DB: any };
    expect(WAHP_DB.version).toBe(1);
    expect(WAHP_DB.scans).toHaveLength(1);
    expect(WAHP_DB.scans[0].items["4"]).toEqual({ min: 100, mkt: 3800, q: 101 });
  });

  test("Strings, Escapes, UTF-8-Bytes, Zahlen, Booleans, nil", () => {
    // Kein String.raw: Bun schreibt Nicht-ASCII darin beim Transpilieren als \u{…} um.
    const src = [
      `A = { "a\\"b", 'c\\\\d', "\\226\\130\\172", "Grünwald 🐉", "x\\ny", -1.5, 2e3, 0x1F, true, false, nil }`,
      `B = { [1] = "eins", [2] = "zwei", foo = "bar" }; C = 42 -- Kommentar`,
      "--[[ Block",
      "Kommentar ]]",
      "D = {}",
    ].join("\n");
    const v = parseSavedVariables(src);
    expect(v.A).toEqual(['a"b', "c\\d", "€", "Grünwald 🐉", "x\ny", -1.5, 2000, 31, true, false, null]);
    expect(v.B).toEqual({ "1": "eins", "2": "zwei", foo: "bar" });
    expect(v.C).toBe(42);
    expect(v.D).toEqual([]);
  });

  test("Fehler nennen die Zeile", () => {
    expect(() => parseSavedVariables("A = {\n1,\n2 3\n}")).toThrow("Zeile 3");
    expect(() => parseSavedVariables('A = "offen')).toThrow("String nicht geschlossen");
  });
});

describe("WoW-Helfer", () => {
  test("realmKey macht aus Region, Realm und Fraktion einen URL-tauglichen Key", () => {
    expect(realmKey({ region: 3, realm: "Everlook", faction: "Alliance" })).toBe("eu-everlook-alliance");
    expect(realmKey({ region: 3, realm: "Zul'jin Grünwald Straße", faction: "Horde" })).toBe("eu-zul-jin-grunwald-strasse-horde");
    expect(realmKey({ region: 42, realm: "X", faction: "" })).toBe("xx-x");
  });

  test("extractScans wirft kaputte Items raus", () => {
    const [scan] = extractScans(parseSavedVariables(SV).WAHP_DB);
    expect(scan!.items.map((i) => i.itemId).sort()).toEqual([1, 4]);
    expect(scan!.items.find((i) => i.itemId === 4)).toEqual({ itemId: 4, minBuyout: 100, marketPrice: 3800, quantity: 101 });
    expect(extractScans(undefined)).toEqual([]);
    expect(extractScans({ scans: [{ realm: "x" }] })).toEqual([]);
  });

  test("findGameDir findet den Flavor-Ordner mit dem Addon, _forever_ zuerst", () => {
    const root = tmp();
    for (const flavor of ["_classic_era_", "_forever_", "_retail_"]) mkdirSync(join(root, flavor), { recursive: true });
    for (const flavor of ["_classic_era_", "_forever_"]) {
      mkdirSync(join(root, flavor, "Interface", "AddOns", "WowAhPrediction"), { recursive: true });
    }
    expect(findGameDir(root)).toBe(join(root, "_forever_"));
    expect(findGameDir(join(root, "_classic_era_"))).toBe(join(root, "_classic_era_"));
    expect(findGameDir(join(root, "_retail_"))).toBeNull();
    expect(findGameDir(join(root, "gibts-nicht"))).toBeNull();
  });
});

describe("Companion gegen echten Server", () => {
  const repo = new Repo(openDatabase(":memory:"));
  const server = startServer(
    { repo, knowledge: testKnowledge, config: loadConfig({ INGEST_TOKEN: "tok" }), hub: new LiveHub(), now: () => EVENT_MS - 25 * DAY },
    0,
  );
  afterAll(() => server.stop(true));

  function setup(token = "tok") {
    const game = join(tmp(), "_forever_");
    const addonDir = join(game, "Interface", "AddOns", "WowAhPrediction");
    const svDir = join(game, "WTF", "Account", "MEINACCOUNT", "SavedVariables");
    mkdirSync(addonDir, { recursive: true });
    mkdirSync(svDir, { recursive: true });
    writeFileSync(join(svDir, "WowAhPrediction.lua"), SV);
    const config: CompanionConfig = {
      wowDir: join(game, ".."),
      serverUrl: server.url.origin,
      token,
      pollSeconds: 15,
      refreshMinutes: 5,
      statePath: join(game, "..", "companion-state.json"),
    };
    const logs: string[] = [];
    return { companion: new Companion(config, (m) => logs.push(m)), addonDir, config, logs };
  }

  test("lädt neue Scans hoch, schreibt Data.lua und merkt sich, was schon oben ist", async () => {
    const { companion, addonDir, config } = setup();
    const first = await companion.syncOnce();
    expect(first).toEqual({ uploaded: 1, dataWritten: true, realm: "eu-everlook-alliance" });

    const stats = repo.priceStats("eu-everlook-alliance", 4, 0, Date.now() + DAY * 365);
    expect(stats).toEqual({ median: 3800, count: 1 }); // Marktpreis statt Mindestpreis

    const lua = readFileSync(join(addonDir, "Data.lua"), "utf8");
    expect(lua).toContain('realm = "eu-everlook-alliance"');
    expect(lua).toContain('name = "Pestblüte"');
    expect(lua).toContain("current = 3800");

    // Zweiter Durchlauf: nichts Neues, Datei bleibt unangetastet
    expect(await companion.syncOnce(true)).toEqual({ uploaded: 0, dataWritten: false, realm: "eu-everlook-alliance" });
    // Auch ein neu gestarteter Companion lädt nicht doppelt hoch
    expect(await new Companion(config, () => {}).uploadNewScans(true)).toBe(0);
  });

  test("falscher Token: Upload wird abgelehnt und geloggt, nicht als erledigt gemerkt", async () => {
    const { companion, logs } = setup("falsch");
    expect(await companion.uploadNewScans()).toBe(0);
    expect(logs.some((l) => l.includes("Upload abgelehnt (401)"))).toBe(true);
  });

  test("ohne installiertes Addon gibt es eine klare Fehlermeldung", async () => {
    const companion = new Companion(
      { wowDir: tmp(), serverUrl: server.url.origin, token: "tok", pollSeconds: 15, refreshMinutes: 5, statePath: join(tmp(), "s.json") },
      () => {},
    );
    expect(companion.syncOnce()).rejects.toThrow("Addon nicht gefunden");
  });
});
