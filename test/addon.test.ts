// Addon-Tests laufen mit lua5.1 (wie im WoW-Client). Ohne lua5.1 werden sie übersprungen.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forever } from "../knowledge/forever/index.ts";
import { startServer } from "../src/api/server.ts";
import { Companion } from "../src/companion/sync.ts";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db/database.ts";
import { Repo } from "../src/db/repo.ts";
import { LiveHub } from "../src/live/hub.ts";
import { DAY } from "./fixtures.ts";

const LUA = Bun.which("lua5.1");
const ROOT = join(import.meta.dir, "..");
const RUN = join(ROOT, "addon", "tests", "run.lua");

function lua(...args: string[]): string {
  const proc = Bun.spawnSync([LUA!, RUN, ...args], { cwd: ROOT });
  const out = proc.stdout.toString() + proc.stderr.toString();
  if (proc.exitCode !== 0) throw new Error(`lua5.1 ${args.join(" ")} fehlgeschlagen:\n${out}`);
  return out;
}

describe.skipIf(!LUA)("Addon (lua5.1)", () => {
  test("Lua-Unit-Tests", () => {
    expect(lua("test")).toContain("Lua-Tests ok");
  });

  describe("kompletter Kreislauf: Scan → SavedVariables → Companion → Server → Data.lua → Tooltip", () => {
    const dir = mkdtempSync(join(tmpdir(), "wahp-e2e-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    test("Pestblüte zeigt im Tooltip eine Kaufempfehlung mit echtem Preis", async () => {
      // Echte Forever-Wissensbasis, Event 25 Tage in der Zukunft, damit der Test nicht altert
      const eventDate = new Date(Date.now() + 25 * DAY).toISOString().slice(0, 10);
      const knowledge = { ...forever, events: forever.events.map((e) => ({ ...e, date: eventDate })) };
      const repo = new Repo(openDatabase(":memory:"));
      const server = startServer({ repo, knowledge, config: loadConfig({ INGEST_TOKEN: "tok" }), hub: new LiveHub() }, 0);

      try {
        const game = join(dir, "_forever_");
        const addonDir = join(game, "Interface", "AddOns", "WowAhPrediction");
        const svDir = join(game, "WTF", "Account", "ACC", "SavedVariables");
        mkdirSync(svDir, { recursive: true });
        cpSync(join(ROOT, "addon", "WowAhPrediction"), addonDir, { recursive: true });

        // 1. Addon scannt (Lua) und schreibt SavedVariables wie WoW beim /reload
        lua("scan", join(svDir, "WowAhPrediction.lua"));

        // 2. Companion lädt hoch und holt Data.lua
        const companion = new Companion(
          { wowDir: dir, serverUrl: server.url.origin, token: "tok", pollSeconds: 15, refreshMinutes: 5, statePath: join(dir, "state.json") },
          () => {},
        );
        const result = await companion.syncOnce();
        expect(result).toEqual({ uploaded: 1, dataWritten: true, realm: "eu-everlook-alliance" });
        // Item-Namen aus dem Scan kommen beim Server an (Grundlage für die KI-Analyse)
        expect(repo.itemNames([13466, 13468])).toEqual(new Map([[13466, "Pestblüte"], [13468, "Schwarzer Lotus"]]));

        // 3. Addon lädt die neue Data.lua und zeigt den Tooltip
        const tooltip = lua("tooltip", join(addonDir, "Data.lua"), "13466");
        expect(tooltip).toContain("KAUFEN");
        expect(tooltip).toContain("Peak +48 %");
        // Marktpreis aus dem Scan: (1 × 1c + 14,15 × 40s) / 15,15 Stück ≈ 37s 43c, Peak = × 1,48
        expect(tooltip).toContain("Jetzt 0g 37s 43c, Peak ~0g 55s 40c");
        expect(tooltip).toContain("Raid-Welle 1");
      } finally {
        server.stop(true);
      }
    });
  });
});
