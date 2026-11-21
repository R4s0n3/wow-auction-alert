import type { MarketItem } from "../ai/types.ts";
import type { Prediction } from "./predict.ts";
import { byWorth } from "./rank.ts";

export const TOP_N = 10;

/**
 * Gewinner und Verlierer der Woche aus den Prognosen: was am meisten steigen soll
 * (jetzt kaufen) und was am meisten fallen soll (jetzt verkaufen). Sortiert nach
 * Gold pro Stück, damit oben echte Werte stehen statt Kleinkram mit großen Prozenten.
 */
export function weeklyTop(predictions: Prediction[], n = TOP_N): { winners: Prediction[]; losers: Prediction[] } {
  return {
    winners: predictions.filter((p) => p.action === "buy").sort(byWorth).slice(0, n),
    losers: predictions.filter((p) => p.action === "sell").sort(byWorth).slice(0, n),
  };
}

export interface Mover {
  itemId: number;
  name: string;
  price: number;
  before: number;
  change: number;
  quantity: number;
}

/**
 * Was sich in den eigenen Scans seit der Vorwoche tatsächlich bewegt hat. Nur Items
 * mit Umsatz (Preis × Menge ab 10g) und mindestens 20 % Bewegung, sonst ist es Rauschen.
 */
export function movers(market: MarketItem[], n = TOP_N): { up: Mover[]; down: Mover[] } {
  const moved = market
    .filter((i) => i.priceWeekBefore !== null && i.priceWeekBefore > 0 && i.quantity >= 5 && i.price * i.quantity >= 100_000)
    .map((i) => ({
      itemId: i.itemId,
      name: i.name ?? `Item ${i.itemId}`,
      price: i.price,
      before: i.priceWeekBefore!,
      change: i.price / i.priceWeekBefore! - 1,
      quantity: i.quantity,
    }))
    .filter((m) => Math.abs(m.change) >= 0.2);
  return {
    up: moved.filter((m) => m.change > 0).sort((a, b) => b.change - a.change).slice(0, n),
    down: moved.filter((m) => m.change < 0).sort((a, b) => a.change - b.change).slice(0, n),
  };
}
