import type { Alert } from "../db/repo.ts";
import type { Prediction } from "../engine/predict.ts";
import { byWorth } from "../engine/rank.ts";
import { iconUrl, wowheadUrl } from "../icons.ts";

// Eine Nachricht pro Realm und Durchlauf. Darin eine Karte pro Item, mit Icon als
// Vorschaubild und dem Namen als Wowhead-Link. Pro Karte zwei kurze Zeilen mit
// Symbolen: was passiert, Preis jetzt → Ziel, bis wann, wie sicher. Verkaufen zuerst.
// Die Begründung steht im Spiel im Tooltip und auf der Website.

const MAX_EMBEDS = 10; // Discord-Limit pro Nachricht
const MAX_SELLS = 6;
const MAX_BUYS_WITH_SELLS = 4;
const RED = 0xe74c3c;
const GREEN = 0x2ecc71;

interface Embed {
  author?: { name: string };
  title: string;
  url?: string;
  description: string;
  color: number;
  thumbnail?: { url: string };
  footer?: { text: string };
  timestamp?: string;
}
export interface DiscordMessage {
  embeds: Embed[];
}
export interface DiscordExtras {
  /** Wowhead-Icon-Namen pro Item */
  icons?: Map<number, string>;
  /** Adresse der Website für den Hinweis auf weitere Signale */
  publicUrl?: string;
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

/** Zwei Zeilen pro Item: "📉 **−30 %** · 95g → 66g 50s" und "⏳ 05.12. · ●●●●○ 🤖" */
export function itemLines(p: Prediction): [string, string] {
  const prices = p.currentPrice !== null && p.expectedPeakPrice !== null ? ` · ${shortGold(p.currentPrice)} → ${shortGold(p.expectedPeakPrice)}` : "";
  let first: string;
  let deadline: string | null;
  if (p.action === "buy") {
    first = `📈 **${pct(p.netUpside)}**${prices}`;
    deadline = p.buyUntil ? shortDate(p.buyUntil) : null;
  } else if (p.impact < 0) {
    // Preis wird fallen: vorher loswerden
    first = `📉 **${pct(p.impact)}**${prices}`;
    deadline = p.sellTo ? shortDate(p.sellTo) : "jetzt";
  } else {
    // Peak ist da: jetzt teuer verkaufen
    first = `💰 **Peak**${p.currentPrice !== null ? ` · ${shortGold(p.currentPrice)}` : ""}`;
    deadline = p.sellTo ? shortDate(p.sellTo) : null;
  }
  const second = [deadline ? `⏳ ${deadline}` : null, dots(p.confidence) + (p.source === "ai" ? " 🤖" : "")].filter(Boolean).join(" · ");
  return [first, second];
}

function card(p: Prediction, extras: DiscordExtras, header?: string): Embed {
  const icon = extras.icons?.get(p.itemId);
  return {
    ...(header ? { author: { name: header } } : {}),
    title: p.itemName.slice(0, 256),
    url: wowheadUrl(p.itemId),
    description: itemLines(p).join("\n"),
    color: p.action === "buy" ? GREEN : RED,
    ...(icon ? { thumbnail: { url: iconUrl(icon, "large") } } : {}),
  };
}

export function discordMessages(alerts: Alert[], extras: DiscordExtras = {}): DiscordMessage[] {
  const realms = new Map<string, Alert[]>();
  for (const a of alerts) realms.set(a.realm, [...(realms.get(a.realm) ?? []), a]);

  const messages: DiscordMessage[] = [];
  for (const [realm, list] of realms) {
    // Nach Gold pro Stück, nicht nach Prozent: -30 % auf 95g schlagen -70 % auf 97c
    const sells = list.map((a) => a.prediction).filter((p) => p.action === "sell").sort(byWorth);
    const buys = list.map((a) => a.prediction).filter((p) => p.action === "buy").sort(byWorth);
    if (sells.length + buys.length === 0) continue;
    const shownSells = sells.slice(0, MAX_SELLS);
    const shownBuys = buys.slice(0, shownSells.length > 0 ? MAX_BUYS_WITH_SELLS : MAX_EMBEDS - 2);
    const embeds = [
      ...shownSells.map((p, i) => card(p, extras, i === 0 ? `🔴 VERKAUFEN · ${sells.length}` : undefined)),
      ...shownBuys.map((p, i) => card(p, extras, i === 0 ? `🟢 KAUFEN · ${buys.length}` : undefined)),
    ];
    const hidden = sells.length + buys.length - embeds.length;
    const host = extras.publicUrl?.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const more = hidden > 0 ? `+${hidden} weitere${host ? ` auf ${host}` : ""}` : null;
    const last = embeds[embeds.length - 1]!;
    last.footer = { text: [realm, more, "●●●○○ Sicherheit"].filter(Boolean).join(" · ") };
    last.timestamp = new Date(Math.max(...list.map((a) => a.ts))).toISOString();
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
  extras: DiscordExtras = {},
): Promise<void> {
  await postDiscord(webhookUrl, discordMessages(alerts, extras), fetchImpl, sleep);
}

/**
 * Wochenrückblick: eine Nachricht mit den 10 Gewinnern (jetzt kaufen), eine mit den
 * 10 Verlierern (jetzt verkaufen). Platz vor dem Namen, sonst wie die Alert-Karten.
 */
export function weeklyMessages(
  realm: string,
  top: { winners: Prediction[]; losers: Prediction[] },
  extras: DiscordExtras = {},
  now = Date.now(),
): DiscordMessage[] {
  const host = extras.publicUrl?.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const block = (list: Prediction[], header: string): DiscordMessage | null => {
    if (list.length === 0) return null;
    const embeds = list.map((p, i) => {
      const c = card(p, extras, i === 0 ? header : undefined);
      return { ...c, title: `${i + 1}. ${c.title}`.slice(0, 256) };
    });
    const last = embeds[embeds.length - 1]!;
    last.footer = { text: [realm, host ? `alle Signale auf ${host}` : null].filter(Boolean).join(" · ") };
    last.timestamp = new Date(now).toISOString();
    return { embeds };
  };
  return [block(top.winners, "📈 GEWINNER DER WOCHE · jetzt kaufen"), block(top.losers, "📉 VERLIERER DER WOCHE · jetzt verkaufen")].filter(
    (m): m is DiscordMessage => m !== null,
  );
}

/** Schickt fertige Nachrichten, mit Rücksicht auf Discords Rate-Limit */
export async function postDiscord(
  webhookUrl: string,
  messages: DiscordMessage[],
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  for (const { embeds } of messages) {
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
