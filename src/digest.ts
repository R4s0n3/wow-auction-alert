// Wochenrückblick in Discord: jeden Montag um 9 Uhr (Berlin) die 10 Gewinner und
// die 10 Verlierer der Woche. Der Server prüft das bei jedem Engine-Durchlauf.
import { FOCUS } from "./categories.ts";
import type { Config } from "./config.ts";
import type { Repo } from "./db/repo.ts";
import { predictionsFor } from "./engine/run.ts";
import { weeklyTop } from "./engine/weekly.ts";
import { iconsFor, resolveIcons } from "./icons.ts";
import type { Knowledge } from "./knowledge/types.ts";
import { postDiscord, weeklyMessages } from "./live/discord.ts";

const META_KEY = "weekly_digest_sent_at";
const WEEKDAY = 1; // Montag
const HOUR = 9;

/** Wochentag (0 = Sonntag) und Stunde in Berlin */
function berlin(now: number): { weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.find((p) => p.type === "weekday")!.value);
  return { weekday, hour: Number(parts.find((p) => p.type === "hour")!.value) };
}

/** Fällig, wenn Montag ab 9 Uhr ist und der letzte Rückblick mindestens 6 Tage her ist */
export function digestDue(now: number, lastSentAt: number | null): boolean {
  const { weekday, hour } = berlin(now);
  if (weekday !== WEEKDAY || hour < HOUR) return false;
  return lastSentAt === null || now - lastSentAt >= 6 * 86_400_000;
}

export interface DigestDeps {
  repo: Repo;
  knowledge: Knowledge;
  config: Config;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Baut den Rückblick für den Realm mit dem neuesten Scan und schickt ihn. Gibt die Anzahl
 * der Items zurück. record=false (von Hand verschickt) zählt nicht als Rückblick der Woche.
 */
export async function sendWeeklyDigest(deps: DigestDeps, now = Date.now(), record = true): Promise<number> {
  const realm = deps.repo.overview()[0]?.realm;
  if (!realm || !deps.config.discordWebhookUrl) return 0;
  // Nur der Fokus: Handwerkswaren und Handwerks-Fraktion
  const top = weeklyTop(predictionsFor(deps, realm, now).filter((p) => FOCUS.includes(p.category ?? "unknown")));
  const ids = [...top.winners, ...top.losers].map((p) => p.itemId);
  if (ids.length === 0) return 0;
  await Promise.race([resolveIcons(deps.repo, ids, { max: 20, fetchImpl: deps.fetchImpl }), Bun.sleep(15_000)]).catch(() => {});
  const messages = weeklyMessages(realm, top, { icons: iconsFor(deps.repo, ids), publicUrl: deps.config.publicUrl }, now);
  await postDiscord(deps.config.discordWebhookUrl, messages, deps.fetchImpl, deps.sleep);
  if (record) deps.repo.setMeta(META_KEY, String(now));
  return ids.length;
}

/** Bei jedem Engine-Durchlauf aufrufen: schickt den Rückblick, wenn er fällig ist */
export async function maybeSendWeeklyDigest(deps: DigestDeps, now = Date.now()): Promise<boolean> {
  const last = deps.repo.getMeta(META_KEY);
  if (!digestDue(now, last === null ? null : Number(last))) return false;
  await sendWeeklyDigest(deps, now);
  return true;
}
