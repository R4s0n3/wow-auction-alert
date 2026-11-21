import type { Action } from "./engine/predict.ts";

export const ACTION_LABEL: Record<Action, string> = {
  buy: "KAUFEN",
  hold: "HALTEN",
  sell: "VERKAUFEN",
  avoid: "MEIDEN",
  watch: "BEOBACHTEN",
};

export function formatGold(copper: number | null): string {
  if (copper === null) return "–";
  const c = Math.round(copper);
  const g = Math.floor(c / 10_000);
  const s = Math.floor((c % 10_000) / 100);
  const cu = c % 100;
  const parts: string[] = [];
  if (g) parts.push(`${g}g`);
  if (s) parts.push(`${s}s`);
  if (cu || parts.length === 0) parts.push(`${cu}c`);
  return parts.join(" ");
}

export function formatPct(x: number): string {
  const pct = Math.round(x * 100);
  return `${pct >= 0 ? "+" : ""}${pct} %`;
}

/** 2026-12-09 → 09.12.2026 */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}
