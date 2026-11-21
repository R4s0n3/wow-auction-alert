import type { Prediction } from "./predict.ts";

/**
 * Was eine Empfehlung pro Stück wert ist, in Kupfer und gewichtet mit der Sicherheit:
 * beim Kaufen der erwartete Gewinn, beim Verkaufen der Verlust, den man vermeidet.
 * So landet ein Schwarzer Lotus mit -30 % vor einer Kiste für 97 Kupfer mit -70 %.
 * Ohne Preis zählt nur die relative Änderung, das kommt dann ganz nach hinten.
 */
export function worth(p: Prediction): number {
  const rel = p.action === "buy" ? p.netUpside : Math.abs(p.impact);
  return (p.currentPrice ?? 1) * Math.max(0, rel) * p.confidence;
}

export const byWorth = (a: Prediction, b: Prediction) => worth(b) - worth(a);
