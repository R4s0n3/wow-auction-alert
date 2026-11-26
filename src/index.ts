import { forever } from "../knowledge/forever/index.ts";
import { runAnalysis } from "./ai/analyze.ts";
import { createClient } from "./ai/provider.ts";
import { maybeSendWeeklyDigest } from "./digest.ts";
import { iconsFor, resolveIcons } from "./icons.ts";
import { startServer } from "./api/server.ts";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { Repo } from "./db/repo.ts";
import { focusAlerts, runEngine } from "./engine/run.ts";
import { assertValidKnowledge } from "./knowledge/validate.ts";
import { sendDiscord } from "./live/discord.ts";
import { LiveHub } from "./live/hub.ts";

const config = loadConfig();
const knowledge = assertValidKnowledge(forever);
const repo = new Repo(openDatabase(config.dbPath));
const hub = new LiveHub();

// Icons für alle Items mit Signal nach und nach im Hintergrund holen (Wowhead schonen)
let fetchingIcons = false;
async function warmIcons(itemIds: number[]): Promise<void> {
  if (fetchingIcons || itemIds.length === 0) return;
  fetchingIcons = true;
  try {
    // Abgefangene Kisten: Inhalt aus dem Tooltip (deutsch und englisch), damit klar ist, welche Waren sie verlangen.
    // Einmalig alle neu lesen, die nur den deutschen Inhalt haben (vor der zweisprachigen Version).
    const rereadAll = repo.getMeta("crate_needs_version") !== "2";
    const crates = rereadAll ? repo.allCrates() : repo.cratesWithoutNeeds();
    if (crates.length > 0) await resolveIcons(repo, crates, { max: 60, force: true });
    if (rereadAll) repo.setMeta("crate_needs_version", "2");
    const found = await resolveIcons(repo, itemIds, { max: 300 });
    if (found > 0) console.log(`[icons] ${found} Icons von Wowhead geholt`);
  } catch (err) {
    console.warn("[icons] fehlgeschlagen:", err instanceof Error ? err.message : err);
  } finally {
    fetchingIcons = false;
  }
}

async function tick(): Promise<void> {
  try {
    const { predictions, alerts, signalItemIds } = runEngine({ repo, knowledge, config });
    if (alerts.length > 0) {
      hub.broadcast(alerts);
      if (config.discordWebhookUrl) {
        // Icons und Kategorien der Items vorher holen (höchstens ~20 s), dann nur den Fokus schicken
        const ids = alerts.map((a) => a.itemId);
        await Promise.race([resolveIcons(repo, ids, { max: 60, concurrency: 6 }), Bun.sleep(20_000)]).catch(() => {});
        const focus = focusAlerts(repo, alerts);
        if (focus.length > 0) {
          await sendDiscord(config.discordWebhookUrl, focus, fetch, undefined, { icons: iconsFor(repo, ids), publicUrl: config.publicUrl });
        }
      }
    }
    console.log(`[engine] ${predictions} Prognosen, ${alerts.length} neue Alerts`);
    void warmIcons(signalItemIds);
    if (config.discordWebhookUrl) {
      const sent = await maybeSendWeeklyDigest({ repo, knowledge, config });
      if (sent) console.log("[discord] Wochenrückblick verschickt");
    }
  } catch (err) {
    console.error("[engine] Durchlauf fehlgeschlagen:", err);
  }
}

const server = startServer({ repo, knowledge, config, hub, onScan: tick });
console.log(`AH-Prognose-Server läuft auf ${server.url}`);
if (!config.ingestToken) console.warn("INGEST_TOKEN ist nicht gesetzt, POST /scans ist deaktiviert.");
if (!config.readToken) console.log("READ_TOKEN ist nicht gesetzt, alle GET-Routen sind ohne Token lesbar.");
if (!config.discordWebhookUrl) console.log("Kein DISCORD_WEBHOOK_URL gesetzt, Alerts gehen nur über /stream raus.");

// KI-Analyse automatisch, wenn AI_INTERVAL_HOURS gesetzt ist. Bewertet nur, was
// fällig ist (neue Items, alte Bewertungen, starke Preissprünge), deshalb ist
// auch ein Lauf direkt nach dem Start billig, wenn kurz vorher schon einer lief.
let analyzing = false;
async function analyze(): Promise<void> {
  if (analyzing) return;
  analyzing = true;
  try {
    for (const realm of repo.realms(Date.now() - 7 * 86_400_000)) {
      const r = await runAnalysis(
        { repo, knowledge, config, log: (m) => console.log(`[ki] ${m}`), client: () => createClient(config) },
        { realm },
      );
      console.log(`[ki] ${realm}: ${r.assessed} Items bewertet, Kosten ~$${r.costUsd?.toFixed(2) ?? "?"}`);
    }
    await tick();
  } catch (err) {
    console.error("[ki] Analyse fehlgeschlagen:", err instanceof Error ? err.message : err);
  } finally {
    analyzing = false;
  }
}

await tick();
setInterval(tick, config.engineIntervalMin * 60_000);
if (config.aiIntervalHours > 0) {
  console.log(`KI-Analyse läuft alle ${config.aiIntervalHours} h (Budget $${config.aiBudgetUsd} pro Lauf und Realm).`);
  setTimeout(analyze, 30_000);
  setInterval(analyze, config.aiIntervalHours * 3_600_000);
}
