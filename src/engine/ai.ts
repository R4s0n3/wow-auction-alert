import type { StoredAssessment } from "../ai/types.ts";
import { DAY_MS } from "./curve.ts";
import { isoDate, round, type Action, type PredictOptions, type Prediction, type PriceProvider } from "./predict.ts";

const CURRENT_WINDOW_MS = 2 * DAY_MS;

/**
 * Macht aus den KI-Bewertungen Prognosen im selben Format wie die Handregeln,
 * damit Addon, Alerts und Discord nichts davon wissen müssen.
 * "flat" wird nicht zur Prognose: kein Treiber, keine Tooltip-Zeile.
 */
export function aiPredictions(
  assessments: StoredAssessment[],
  prices: PriceProvider,
  names: Map<number, string>,
  opts: PredictOptions,
): Prediction[] {
  const today = isoDate(opts.now);
  const out: Prediction[] = [];

  for (const a of assessments) {
    if (a.direction === "flat") continue;
    const current = prices.stats(a.itemId, opts.now - CURRENT_WINDOW_MS, opts.now)?.median ?? a.priceAt;
    const change = a.changePct / 100;
    // Ziel bezieht sich auf den Preis bei der Bewertung. Ist der Preis seitdem
    // schon gestiegen, schrumpft der verbleibende Gewinn.
    const reference = a.priceAt ?? current;
    const target = reference === null ? null : reference * (1 + change);
    const netUpside =
      target !== null && current ? (target * (1 - opts.ahCut)) / current - 1 : (1 + change) * (1 - opts.ahCut) - 1;
    const confident = a.confidence >= opts.minConfidence;

    let action: Action;
    if (a.direction === "up") {
      if (a.sellBy && today > a.sellBy) action = "avoid";
      else if (a.sellFrom && today >= a.sellFrom) action = "sell";
      else if (a.buyBy && today > a.buyBy) action = "hold";
      else action = netUpside >= opts.minUpside && confident ? "buy" : "watch";
    } else {
      // Erwarteter Preisverfall: vorher verkaufen, sonst zumindest nicht kaufen
      if (a.sellBy && today > a.sellBy) action = "watch";
      else action = -change >= opts.minUpside && confident ? "sell" : "avoid";
    }

    out.push({
      source: "ai",
      realm: opts.realm,
      itemId: a.itemId,
      itemName: names.get(a.itemId) ?? `Item ${a.itemId}`,
      eventId: "ai",
      eventName: a.driver,
      eventDate: a.direction === "up" ? (a.sellFrom ?? a.buyBy) : a.sellBy,
      action,
      impact: round(change),
      confidence: a.confidence,
      netUpside: round(netUpside),
      currentPrice: current === null ? null : Math.round(current),
      baselinePrice: a.priceAt,
      expectedPeakPrice: target === null ? null : Math.round(target),
      priceBasis: current === null ? "none" : "current",
      buyUntil: a.direction === "up" ? a.buyBy : null,
      sellFrom: a.sellFrom,
      sellTo: a.sellBy,
      drivers: [{ chain: a.driver, reason: a.reason, impact: round(change), confidence: a.confidence }],
    });
  }
  return out;
}

/**
 * KI-Prognosen ersetzen die Handregeln für jedes Item, das die KI bewertet hat,
 * auch wenn sie "flat" gesagt hat: Die KI kennt die Regeln aus dem Lagebericht
 * und hat das letzte Wort. Items ohne KI-Bewertung behalten die Regel-Prognose.
 */
export function mergePredictions(rules: Prediction[], ai: Prediction[], assessed: Set<number>): Prediction[] {
  return [...ai, ...rules.filter((p) => !assessed.has(p.itemId))];
}
