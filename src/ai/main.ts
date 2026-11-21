// KI-Analyse von Hand starten:
//   bun run analyze                 alle Realms mit Scans aus den letzten 7 Tagen
//   bun run analyze --dry-run       nur zählen und Kosten schätzen
//   bun run analyze --realm eu-everlook-alliance --limit 200 --new-brief --all
import Anthropic from "@anthropic-ai/sdk";
import { parseArgs } from "node:util";
import { forever } from "../../knowledge/forever/index.ts";
import { loadConfig } from "../config.ts";
import { openDatabase } from "../db/database.ts";
import { Repo } from "../db/repo.ts";
import { formatGold } from "../format.ts";
import { assertValidKnowledge } from "../knowledge/validate.ts";
import { runAnalysis } from "./analyze.ts";
import { AiError } from "./claude.ts";
import { apiModel, createClient, PROVIDER_NAME } from "./provider.ts";

const { values } = parseArgs({
  options: {
    realm: { type: "string" },
    limit: { type: "string" },
    all: { type: "boolean", default: false },
    "new-brief": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const config = loadConfig();
const knowledge = assertValidKnowledge(forever);
const repo = new Repo(openDatabase(config.dbPath));
const log = (msg: string) => console.log(`[${new Date().toLocaleTimeString("de-DE")}] ${msg}`);

const limit = values.limit === undefined ? undefined : Number(values.limit);
if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
  console.error("--limit muss eine ganze Zahl sein");
  process.exit(1);
}

const realms = values.realm ? [values.realm] : repo.realms(Date.now() - 7 * 86_400_000);
if (realms.length === 0) {
  console.error("Noch keine Scans in der Datenbank. Erst im Spiel /wahp scan, dann den Companion laufen lassen.");
  process.exit(1);
}

let exitCode = 0;
for (const realm of realms) {
  try {
    const r = await runAnalysis(
      { repo, knowledge, config, log, client: () => createClient(config) },
      { realm, limit, all: values.all, newBrief: values["new-brief"], dryRun: values["dry-run"] },
    );
    const cost = r.costUsd === null ? "unbekannt (Modell nicht in der Preistabelle)" : `~$${r.costUsd.toFixed(2)}`;
    if (values["dry-run"]) {
      log(
        `${realm}: ${r.candidates} Items würden bewertet (Modell ${apiModel(config)} über ${PROVIDER_NAME[config.aiProvider]}, ` +
          `Aufwand ${config.aiEffort})` +
          `${r.newBrief ? ", plus neue Recherche" : ""}. Geschätzte Kosten: ${cost}, Budget pro Lauf: $${config.aiBudgetUsd}`,
      );
      continue;
    }
    log(
      `${realm}: ${r.assessed} bewertet, ${r.missing} ohne Antwort, ${r.failedChunks} Blöcke fehlgeschlagen. ` +
        `${r.usage.requests} Anfragen, Kosten ${cost}`,
    );

    const top = repo.assessments(realm).filter((a) => a.direction !== "flat" && a.confidence >= config.minConfidence);
    const names = repo.itemNames(top.map((a) => a.itemId));
    top.sort((a, b) => Math.abs(b.changePct) * b.confidence - Math.abs(a.changePct) * a.confidence);
    if (top.length > 0) log("Stärkste Signale:");
    for (const a of top.slice(0, 15)) {
      const arrow = a.direction === "up" ? "↑" : "↓";
      const price = a.priceAt === null ? "" : ` (jetzt ${formatGold(a.priceAt)})`;
      console.log(
        `  ${arrow} ${(names.get(a.itemId) ?? `Item ${a.itemId}`).padEnd(28)} ${a.changePct > 0 ? "+" : ""}${a.changePct} %, ` +
          `${Math.round(a.confidence * 100)} % sicher${price}\n      ${a.driver}: ${a.reason}`,
      );
    }
  } catch (err) {
    exitCode = 1;
    const viaOpenRouter = config.aiProvider === "openrouter";
    if (err instanceof Anthropic.AuthenticationError) {
      console.error(
        viaOpenRouter
          ? "OpenRouter lehnt den Key ab. OPENROUTER_API_KEY in der .env prüfen."
          : "API-Key fehlt oder ist ungültig. ANTHROPIC_API_KEY (oder OPENROUTER_API_KEY) in der .env setzen.",
      );
    } else if (err instanceof Anthropic.APIError && err.status === 402) {
      console.error(`${realm}: Guthaben reicht nicht${viaOpenRouter ? ", OpenRouter-Konto aufladen" : ""} (${err.message})`);
    } else if (err instanceof AiError || err instanceof Anthropic.APIError) {
      console.error(`${realm}: ${err.message}`);
    } else {
      console.error(`${realm}:`, err instanceof Error ? err.message : err);
      if (!viaOpenRouter && !process.env.ANTHROPIC_API_KEY) {
        console.error("Tipp: ANTHROPIC_API_KEY oder OPENROUTER_API_KEY in die .env eintragen.");
      }
    }
  }
}
if (exitCode === 0 && !values["dry-run"]) {
  log("Der Server übernimmt die neuen Bewertungen beim nächsten Engine-Durchlauf (alle ENGINE_INTERVAL_MIN Minuten).");
}
process.exit(exitCode);
