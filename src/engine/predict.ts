import type { Knowledge } from "../knowledge/types.ts";
import { curveAt, curveFor, DAY_MS, eventStartMs, windowsFor } from "./curve.ts";
import { computeDemand } from "./demand.ts";

export type Action = "buy" | "hold" | "sell" | "avoid" | "watch";

export interface PriceStats {
  /** Median des Mindest-Buyouts in Kupfer */
  median: number;
  count: number;
}

export interface PriceProvider {
  stats(itemId: number, fromMs: number, toMs: number): PriceStats | null;
}

export interface PredictOptions {
  realm: string;
  now: number;
  /** Mindest-Gewinn nach AH-Gebühr für "kaufen", z. B. 0.15 */
  minUpside: number;
  minConfidence: number;
  /** AH-Gebühr beim Verkauf, Classic: 0.05 */
  ahCut: number;
}

export interface Prediction {
  /** rules = Handregeln aus knowledge/, ai = KI-Analyse mit Websuche */
  source: "rules" | "ai";
  realm: string;
  itemId: number;
  itemName: string;
  /** Bei KI-Prognosen "ai" */
  eventId: string;
  /** Bei KI-Prognosen der Treiber, z. B. "Onyxia 9.12. → Feuerschutz" */
  eventName: string;
  eventDate: string | null;
  action: Action;
  /** Erwarteter Aufschlag zum Peak gegenüber dem Normalpreis, negativ = erwarteter Preisverfall */
  impact: number;
  confidence: number;
  /** Erwarteter Gewinn, wenn man jetzt kauft und am Peak verkauft (nach AH-Gebühr) */
  netUpside: number;
  currentPrice: number | null;
  baselinePrice: number | null;
  expectedPeakPrice: number | null;
  /** history = Normalpreis aus Scans vor dem Run-up, current = aus aktuellem Preis zurückgerechnet */
  priceBasis: "history" | "current" | "none";
  buyUntil: string | null;
  sellFrom: string | null;
  sellTo: string | null;
  drivers: Array<{ chain: string; reason: string; impact: number; confidence: number }>;
}

const CURRENT_WINDOW_MS = 2 * DAY_MS;
const BASELINE_WINDOW_MS = 7 * DAY_MS;
const MIN_BASELINE_SAMPLES = 3;
const MAX_DRIVERS = 3;

const ACTION_ORDER: Record<Action, number> = { sell: 0, buy: 1, hold: 2, avoid: 3, watch: 4 };

export const byActionThenUpside = (a: Prediction, b: Prediction): number =>
  ACTION_ORDER[a.action] - ACTION_ORDER[b.action] || b.netUpside - a.netUpside;

export const round = (x: number, digits = 3): number => Number(x.toFixed(digits));
export const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function predict(k: Knowledge, prices: PriceProvider, opts: PredictOptions): Prediction[] {
  const names = new Map(k.items.map((i) => [i.id, i.name]));
  const nameOf = (id: number) => names.get(id) ?? `Item ${id}`;
  const out: Prediction[] = [];

  for (const event of k.events) {
    const curve = curveFor(event);
    const w = windowsFor(event, curve);
    if (opts.now >= w.expires) continue;

    const c = curveAt((opts.now - eventStartMs(event)) / DAY_MS, curve);

    for (const d of computeDemand(k, event.id).values()) {
      const current = prices.stats(d.itemId, opts.now - CURRENT_WINDOW_MS, opts.now)?.median ?? null;

      // Normalpreis: am liebsten aus Scans vor dem Run-up. Sonst aus dem
      // aktuellen Preis zurückrechnen, abzüglich des Anteils, den die Kurve
      // schon erwartet.
      const anchor = Math.min(opts.now, w.runUpStart);
      const history = prices.stats(d.itemId, anchor - BASELINE_WINDOW_MS, anchor);
      let baseline: number | null = null;
      let priceBasis: Prediction["priceBasis"] = "none";
      if (history && history.count >= MIN_BASELINE_SAMPLES) {
        baseline = history.median;
        priceBasis = "history";
      } else if (current !== null) {
        baseline = current / (1 + d.impact * c);
        priceBasis = "current";
      }

      const expectedPeak = baseline === null ? null : baseline * (1 + d.impact);
      const netUpside =
        expectedPeak !== null && current !== null
          ? (expectedPeak * (1 - opts.ahCut)) / current - 1
          : ((1 + d.impact) / (1 + d.impact * c)) * (1 - opts.ahCut) - 1;

      let action: Action;
      if (opts.now >= w.sellTo) action = "avoid";
      else if (opts.now >= w.sellFrom) action = "sell";
      else if (opts.now >= w.buyUntil) action = "hold";
      else action = netUpside >= opts.minUpside && d.confidence >= opts.minConfidence ? "buy" : "watch";

      out.push({
        source: "rules",
        realm: opts.realm,
        itemId: d.itemId,
        itemName: nameOf(d.itemId),
        eventId: event.id,
        eventName: event.name,
        eventDate: event.date,
        action,
        impact: round(d.impact),
        confidence: round(d.confidence),
        netUpside: round(netUpside),
        currentPrice: current === null ? null : Math.round(current),
        baselinePrice: baseline === null ? null : Math.round(baseline),
        expectedPeakPrice: expectedPeak === null ? null : Math.round(expectedPeak),
        priceBasis,
        buyUntil: isoDate(w.buyUntil),
        sellFrom: isoDate(w.sellFrom),
        sellTo: isoDate(w.sellTo),
        drivers: d.drivers.slice(0, MAX_DRIVERS).map((dr) => ({
          chain: [event.name, ...dr.path.map(nameOf)].join(" → "),
          reason: dr.reason,
          impact: round(dr.impact),
          confidence: round(dr.confidence),
        })),
      });
    }
  }

  return out.sort(byActionThenUpside);
}
