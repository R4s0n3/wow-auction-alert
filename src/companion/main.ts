// Companion: läuft neben dem Spiel, lädt AH-Scans hoch und holt die Prognosen.
//   wahp-companion            läuft dauerhaft
//   wahp-companion --once     ein Durchlauf, dann Ende
//   wahp-companion --config pfad/zur/companion.json
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, EXAMPLE_CONFIG, findConfigPath, loadCompanionConfig } from "./config.ts";
import { Companion } from "./sync.ts";

const argv = process.argv.slice(2);
const log = (msg: string) => console.log(`[${new Date().toLocaleTimeString("de-DE")}] ${msg}`);

const configPath = findConfigPath(argv);
if (!configPath) {
  const path = join(process.cwd(), CONFIG_FILE);
  writeFileSync(path, `${JSON.stringify(EXAMPLE_CONFIG, null, 2)}\n`);
  console.log(`Keine ${CONFIG_FILE} gefunden. Ich habe eine Vorlage angelegt:\n  ${path}\nTrag deinen WoW-Ordner, die Server-URL und den Token ein und starte nochmal.`);
  process.exit(1);
}

const config = loadCompanionConfig(configPath);
const companion = new Companion(config, log);

async function run(force: boolean): Promise<void> {
  try {
    await companion.syncOnce(force);
  } catch (err) {
    log(`Fehler: ${(err as Error).message}`);
  }
}

if (argv.includes("--once")) {
  await run(true);
  process.exit(0);
}

log(`Companion läuft. Server: ${config.serverUrl}, WoW: ${config.wowDir}`);
log("Ablauf: im Spiel am AH /wahp scan, dann /reload. Ich lade den Scan hoch und hole neue Prognosen.");
await run(true);

let lastRefresh = Date.now();
let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const uploaded = await companion.uploadNewScans();
    if (uploaded > 0 || Date.now() - lastRefresh >= config.refreshMinutes * 60_000) {
      await companion.refreshData();
      lastRefresh = Date.now();
    }
  } catch (err) {
    log(`Fehler: ${(err as Error).message}`);
  } finally {
    busy = false;
  }
}, config.pollSeconds * 1000);
