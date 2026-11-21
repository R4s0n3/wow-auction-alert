// Wochenrückblick von Hand:
//   bun run digest --dry-run    nur anzeigen, was gepostet würde
//   bun run digest              jetzt zusätzlich nach Discord schicken (der Montag kommt trotzdem)
import { parseArgs } from "node:util";
import { forever } from "../knowledge/forever/index.ts";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { Repo } from "./db/repo.ts";
import { sendWeeklyDigest } from "./digest.ts";
import { predictionsFor } from "./engine/run.ts";
import { weeklyTop } from "./engine/weekly.ts";
import { assertValidKnowledge } from "./knowledge/validate.ts";
import { itemLines } from "./live/discord.ts";

const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });
const config = loadConfig();
const knowledge = assertValidKnowledge(forever);
const repo = new Repo(openDatabase(config.dbPath));
const realm = repo.overview()[0]?.realm;
if (!realm) {
  console.error("Noch kein Scan in der Datenbank.");
  process.exit(1);
}

const top = weeklyTop(predictionsFor({ repo, knowledge, config }, realm, Date.now()));
for (const [title, list] of [["📈 Gewinner der Woche", top.winners], ["📉 Verlierer der Woche", top.losers]] as const) {
  console.log(`\n${title} (${realm})`);
  list.forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)}. ${p.itemName.padEnd(36)} ${itemLines(p).join("  ").replace(/\*\*/g, "")}`));
}
if (values["dry-run"]) process.exit(0);
if (!config.discordWebhookUrl) {
  console.error("\nDISCORD_WEBHOOK_URL ist nicht gesetzt.");
  process.exit(1);
}
// Von Hand verschickt zählt nicht als Rückblick der Woche, der Montag kommt trotzdem
const n = await sendWeeklyDigest({ repo, knowledge, config }, Date.now(), false);
console.log(`\n${n} Items nach Discord geschickt.`);
