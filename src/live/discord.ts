import type { Alert } from "../db/repo.ts";
import type { Action, Prediction } from "../engine/predict.ts";
import { byWorth } from "../engine/rank.ts";

// Eine Nachricht pro Realm und Durchlauf, darin eine Karte (Embed) pro Aktion,
// pro Item eine Zeile mit Symbolen statt Sätzen. Die Begründung steht im Spiel
// im Tooltip (Shift), hier nur das, was man zum Handeln braucht.

const MAX_LINES = 10;
// Verkaufen zuerst: was man jetzt loswerden sollte, ist für die meisten wichtiger
const CARDS: Array<{ action: Action; title: string; color: number; deadline: string }> = [
  { action: "sell", title: "🔴 VERKAUFEN", color: 0xe74c3c, deadline: "verkaufen bis" },
  { action: "buy", title: "🟢 KAUFEN", color: 0x2ecc71, deadline: "kaufen bis" },
];

interface Embed {
  title: string;
  description: string;
  color: number;
  footer: { text: string };
  timestamp?: string;
}
export interface DiscordMessage {
  embeds: Embed[];
}

/** Kurz und ohne Kupfer: 123g · 1g 20s · 40s · 35c */
export function shortGold(copper: number): string {
  const c = Math.round(copper);
  const g = Math.floor(c / 10_000);
  const s = Math.floor((c % 10_000) / 100);
  if (g >= 100 || (g >= 1 && s === 0)) return `${g}g`;
  if (g >= 1) return `${g}g ${s}s`;
  if (s >= 1) return `${s}s`;
  return `${c}c`;
}

/** 2026-12-05 → 05.12. */
const shortDate = (iso: string) => {
  const [, m, d] = iso.split("-");
  return `${d}.${m}.`;
};

const pct = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x * 100))} %`;

/** Sicherheit als fünf Punkte: 0.62 → ●●●○○ */
export function dots(confidence: number): string {
  const n = Math.min(5, Math.max(1, Math.round(confidence * 5)));
  return "●".repeat(n) + "○".repeat(5 - n);
}

/** Pestblüte · 📈 +50 % · 40s → 60s · ⏳ 05.12. · ●●●○○ */
export function alertLine(p: Prediction): string {
  const parts = [`**${p.itemName}**`];
  const prices = p.currentPrice !== null && p.expectedPeakPrice !== null ? `${shortGold(p.currentPrice)} → ${shortGold(p.expectedPeakPrice)}` : null;
  if (p.action === "buy") {
    parts.push(`📈 ${pct(p.netUpside)}`);
    if (prices) parts.push(prices);
    if (p.buyUntil) parts.push(`⏳ ${shortDate(p.buyUntil)}`);
  } else if (p.impact < 0) {
    // Preis wird fallen: vorher loswerden
    parts.push(`📉 ${pct(p.impact)}`);
    if (prices) parts.push(prices);
    parts.push(`⏳ ${p.sellTo ? shortDate(p.sellTo) : "jetzt"}`);
  } else {
    // Peak ist da: jetzt teuer verkaufen
    parts.push("💰 Peak");
    if (p.currentPrice !== null) parts.push(shortGold(p.currentPrice));
    if (p.sellTo) parts.push(`⏳ ${shortDate(p.sellTo)}`);
  }
  parts.push(dots(p.confidence) + (p.source === "ai" ? " 🤖" : ""));
  return parts.join(" · ");
}


export function discordMessages(alerts: Alert[]): DiscordMessage[] {
  const realms = new Map<string, Alert[]>();
  for (const a of alerts) realms.set(a.realm, [...(realms.get(a.realm) ?? []), a]);

  const messages: DiscordMessage[] = [];
  for (const [realm, list] of realms) {
    const embeds: Embed[] = [];
    for (const card of CARDS) {
      const group = list.map((a) => a.prediction).filter((p) => p.action === card.action);
      if (group.length === 0) continue;
      // Nach Gold pro Stück, nicht nach Prozent: -30 % auf 95g schlagen -70 % auf 97c
      group.sort(byWorth);
      const lines: string[] = [];
      // Haben alle denselben Anlass (typisch bei den Handregeln), steht er einmal oben
      if (new Set(group.map((p) => p.eventName)).size === 1) {
        const p = group[0]!;
        lines.push(`🗓️ ${p.eventName.split(" (")[0]}${p.eventDate ? ` · ${shortDate(p.eventDate)}` : ""}`);
      }
      lines.push(...group.slice(0, MAX_LINES).map(alertLine));
      if (group.length > MAX_LINES) lines.push(`➕ ${group.length - MAX_LINES} weitere · im Spiel \`/wahp list\``);
      const legend = [realm, `⏳ ${card.deadline}`, "●●●○○ Sicherheit", ...(group.some((p) => p.source === "ai") ? ["🤖 KI"] : [])];
      embeds.push({ title: `${card.title} · ${group.length}`, description: lines.join("\n"), color: card.color, footer: { text: legend.join(" · ") } });
    }
    if (embeds.length === 0) continue;
    embeds[embeds.length - 1]!.timestamp = new Date(Math.max(...list.map((a) => a.ts))).toISOString();
    messages.push({ embeds });
  }
  return messages;
}

const MAX_RETRIES = 5;
const MAX_WAIT_MS = 60_000;

/** Wartezeit aus Discords 429-Antwort: retry_after (Sekunden) im Body, sonst Retry-After-Header */
async function retryAfterMs(res: Response): Promise<number> {
  try {
    const body = (await res.json()) as { retry_after?: unknown };
    if (typeof body.retry_after === "number" && body.retry_after >= 0) return Math.ceil(body.retry_after * 1000);
  } catch {
    // kein JSON, dann eben der Header
  }
  const header = Number(res.headers.get("retry-after"));
  return Number.isFinite(header) && header > 0 ? header * 1000 : 1000;
}

/**
 * Schickt Alerts an einen Discord-Webhook. Discord lässt pro Webhook nur wenige
 * Nachrichten pro Sekunde durch: Ist das Kontingent laut Header leer, wartet der
 * Server vor der nächsten Nachricht. Kommt trotzdem ein 429, wartet er so lange
 * wie verlangt und schickt nochmal.
 */
export async function sendDiscord(
  webhookUrl: string,
  alerts: Alert[],
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  for (const { embeds } of discordMessages(alerts)) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetchImpl(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "AH-Prognose", embeds, allowed_mentions: { parse: [] } }),
        });
        if (res.status === 429 && attempt < MAX_RETRIES) {
          await sleep(Math.min(await retryAfterMs(res), MAX_WAIT_MS));
          continue;
        }
        if (res.status === 401 || res.status === 404) {
          console.warn(`[discord] Webhook gelöscht oder URL falsch (${res.status}), DISCORD_WEBHOOK_URL prüfen`);
          return;
        }
        if (!res.ok) console.warn(`[discord] Webhook antwortet mit ${res.status}`);
        if (res.headers.get("x-ratelimit-remaining") === "0") {
          const resetAfter = Number(res.headers.get("x-ratelimit-reset-after"));
          if (Number.isFinite(resetAfter) && resetAfter > 0) await sleep(Math.min(Math.ceil(resetAfter * 1000), MAX_WAIT_MS));
        }
      } catch (err) {
        console.warn("[discord] Senden fehlgeschlagen:", err);
      }
      break;
    }
  }
}
