import type { PriceProvider } from "../src/engine/predict.ts";
import type { Knowledge } from "../src/knowledge/types.ts";

export const DAY = 86_400_000;
export const EVENT_DATE = "2026-12-09";
export const EVENT_MS = Date.parse(`${EVENT_DATE}T00:00:00Z`);

/** Klein und übersichtlich: zwei Flasks mit gemeinsamem Lotus, ein Elixier, ein Schutztrank. */
export const testKnowledge: Knowledge = {
  items: [
    { id: 1, name: "Lotus" },
    { id: 2, name: "Blatt" },
    { id: 3, name: "Salbei" },
    { id: 4, name: "Pestblüte" },
    { id: 10, name: "Flask A", tags: ["raid-consumable"] },
    { id: 11, name: "Flask B", tags: ["raid-consumable"] },
    { id: 12, name: "Mungo", tags: ["raid-consumable"] },
    { id: 20, name: "Feuerschutz" },
  ],
  recipes: [
    { id: "a", output: 10, profession: "alchemy", reagents: [[1, 1], [2, 30]] },
    { id: "b", output: 11, profession: "alchemy", reagents: [[1, 1], [3, 30]], verified: true },
    { id: "m", output: 12, profession: "alchemy", reagents: [[3, 2], [4, 2]] },
    { id: "f", output: 20, profession: "alchemy", reagents: [[2, 1]] },
  ],
  events: [{ id: "raids", name: "Raids", date: EVENT_DATE, kind: "raid-release" }],
  rules: [
    { id: "consumables", event: "raids", target: { tag: "raid-consumable" }, impact: 0.6, confidence: 0.6, reason: "Raid-Release" },
    { id: "fire", event: "raids", target: { item: 20 }, impact: 0.5, confidence: 0.4, reason: "Feuerboss" },
  ],
};

/** PriceProvider aus einer Liste von [itemId, ts, preis] Punkten */
export function fakePrices(points: Array<[number, number, number]>): PriceProvider {
  return {
    stats(itemId, fromMs, toMs) {
      const ps = points
        .filter(([id, ts]) => id === itemId && ts >= fromMs && ts <= toMs)
        .map(([, , p]) => p)
        .sort((a, b) => a - b);
      if (ps.length === 0) return null;
      const mid = Math.floor(ps.length / 2);
      const median = ps.length % 2 ? ps[mid]! : (ps[mid - 1]! + ps[mid]!) / 2;
      return { median, count: ps.length };
    },
  };
}

export const noPrices: PriceProvider = { stats: () => null };
