import type { Prediction } from "../engine/predict.ts";

function luaString(s: string): string {
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/[\x00-\x1f]/g, (ch) => `\\${ch.charCodeAt(0)}`);
  return `"${escaped}"`;
}

function luaField(key: string, value: string | number | null): string | null {
  if (value === null) return null;
  return `${key} = ${typeof value === "number" ? String(value) : luaString(value)}`;
}

function why(p: Prediction): string | null {
  const top = p.drivers[0];
  if (!top) return null;
  // Bei der KI steht der Treiber schon als Event-Zeile im Tooltip
  return p.source === "ai" ? top.reason : `${top.chain}: ${top.reason}`;
}

/**
 * Erzeugt die Data.lua fürs Addon. Der Companion legt sie in den Addon-Ordner,
 * das Addon liest danach die globale Tabelle WAHP_DATA.
 */
export function toAddonLua(predictions: Prediction[], meta: { realm: string; generatedAt: number }): string {
  const byItem = new Map<number, Prediction[]>();
  for (const p of predictions) {
    const list = byItem.get(p.itemId);
    if (list) list.push(p);
    else byItem.set(p.itemId, [p]);
  }

  const lines = [
    "-- Automatisch generiert vom wow-ah-prediction Server. Nicht von Hand bearbeiten.",
    "WAHP_DATA = {",
    "  version = 1,",
    `  realm = ${luaString(meta.realm)},`,
    `  generatedAt = ${Math.floor(meta.generatedAt / 1000)},`,
    "  items = {",
  ];
  for (const [itemId, preds] of byItem) {
    lines.push(`    [${itemId}] = {`);
    for (const p of preds) {
      const fields = [
        luaField("action", p.action),
        luaField("name", p.itemName),
        luaField("event", p.eventName),
        luaField("eventDate", p.eventDate),
        luaField("impact", p.impact),
        luaField("confidence", p.confidence),
        luaField("netUpside", p.netUpside),
        luaField("current", p.currentPrice),
        luaField("peak", p.expectedPeakPrice),
        luaField("buyUntil", p.buyUntil),
        luaField("sellFrom", p.sellFrom),
        luaField("sellTo", p.sellTo),
        luaField("src", p.source),
        luaField("why", why(p)),
      ].filter((f): f is string => f !== null);
      lines.push(`      { ${fields.join(", ")} },`);
    }
    lines.push("    },");
  }
  lines.push("  },", "}", "");
  return lines.join("\n");
}
