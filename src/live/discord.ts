import type { Alert } from "../db/repo.ts";
import { ACTION_LABEL, formatDate, formatGold, formatPct } from "../format.ts";

const MAX_CONTENT = 1900; // Discord-Limit ist 2000 Zeichen

export function formatAlert(alert: Alert): string {
  const p = alert.prediction;
  const icon = p.action === "buy" ? "🟢" : "🔴";
  const falling = p.impact < 0;
  const when = p.eventDate ? `, ${formatDate(p.eventDate)}` : "";
  const by = p.source === "ai" ? " · KI-Analyse" : "";
  const lines = [
    `${icon} **${ACTION_LABEL[p.action]}: ${p.itemName}** (${p.realm}) · ${p.eventName}${when}${by}`,
    falling
      ? `Erwartet ${formatPct(p.impact)} Preisverfall · Sicherheit ${Math.round(p.confidence * 100)} %`
      : `Erwartet ${formatPct(p.netUpside)} nach AH-Gebühr · Sicherheit ${Math.round(p.confidence * 100)} %`,
  ];
  if (p.currentPrice !== null) {
    lines.push(`Jetzt ${formatGold(p.currentPrice)} → ${falling ? "Tief" : "Peak"} ~${formatGold(p.expectedPeakPrice)}`);
  }
  const window =
    p.action === "buy"
      ? [p.buyUntil && `Kaufen bis ${formatDate(p.buyUntil)}`, p.sellFrom && p.sellTo && `verkaufen ${formatDate(p.sellFrom)}–${formatDate(p.sellTo)}`]
      : [p.sellTo ? `Verkaufsfenster bis ${formatDate(p.sellTo)}` : falling ? "Bestände jetzt verkaufen" : null];
  const windowText = window.filter(Boolean).join(", ");
  if (windowText) lines.push(windowText);
  const top = p.drivers[0];
  if (top) lines.push(p.source === "ai" ? `Warum: ${top.reason}` : `Warum: ${top.chain}. ${top.reason}`);
  return lines.join("\n");
}

/** Packt Alerts in möglichst wenige Discord-Nachrichten unter dem Zeichenlimit. */
export function chunkMessages(blocks: string[]): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    const text = block.length > MAX_CONTENT ? `${block.slice(0, MAX_CONTENT - 1)}…` : block;
    if (current && current.length + 2 + text.length > MAX_CONTENT) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${text}` : text;
  }
  if (current) chunks.push(current);
  return chunks;
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
  for (const content of chunkMessages(alerts.map(formatAlert))) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetchImpl(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "AH-Prognose", content, allowed_mentions: { parse: [] } }),
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
