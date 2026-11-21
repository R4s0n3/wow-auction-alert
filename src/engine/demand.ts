import type { ItemId, Knowledge, Recipe } from "../knowledge/types.ts";

/** Wie viel vom Aufschlag eines Produkts bei seinen Reagenzien ankommt */
export const DEFAULT_PASS_THROUGH = 0.8;
/** Abschlag auf die Sicherheit pro ungeprüftem Rezept auf dem Pfad */
export const UNVERIFIED_RECIPE_FACTOR = 0.85;

export interface Driver {
  ruleId: string;
  reason: string;
  impact: number;
  confidence: number;
  /** Vom Regel-Ziel bis zu diesem Item, z. B. [Elixier des Mungos, Pestblüte] */
  path: ItemId[];
}

export interface Demand {
  itemId: ItemId;
  impact: number;
  confidence: number;
  /** Stärkster Treiber zuerst */
  drivers: Driver[];
}

/**
 * Mehrere Treiber summieren sich mit abnehmendem Gewicht (1, 1/2, 1/4, ...).
 * Ein Kraut, das in fünf Raid-Tränken steckt, steigt also stärker als eins mit
 * nur einem Abnehmer, aber nicht fünfmal so stark.
 */
export function combine(drivers: Driver[]): { impact: number; confidence: number } {
  const sorted = [...drivers].sort((a, b) => b.impact - a.impact);
  let impact = 0;
  let weighted = 0;
  let total = 0;
  sorted.forEach((d, i) => {
    impact += d.impact * 0.5 ** i;
    weighted += d.impact * d.confidence;
    total += d.impact;
  });
  return { impact, confidence: total > 0 ? weighted / total : 0 };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Erwartete Nachfrage pro Item für ein Event, über den Rezeptgraph propagiert. */
export function computeDemand(k: Knowledge, eventId: string): Map<ItemId, Demand> {
  const direct = new Map<ItemId, Driver[]>();
  for (const rule of k.rules) {
    if (rule.event !== eventId) continue;
    const target = rule.target;
    const ids = "item" in target ? [target.item] : k.items.filter((i) => i.tags?.includes(target.tag)).map((i) => i.id);
    for (const id of ids) {
      push(direct, id, { ruleId: rule.id, reason: rule.reason, impact: rule.impact, confidence: rule.confidence, path: [id] });
    }
  }

  const consumers = new Map<ItemId, Recipe[]>();
  for (const recipe of k.recipes) {
    for (const [id] of recipe.reagents) push(consumers, id, recipe);
  }

  const memo = new Map<ItemId, Demand | null>();
  const visiting = new Set<ItemId>();

  // Ein Reagenz erbt die Nachfrage von allem, was daraus gecraftet wird.
  const resolve = (id: ItemId): Demand | null => {
    if (memo.has(id)) return memo.get(id) ?? null;
    if (visiting.has(id)) return null; // Zyklus im Rezeptgraph
    visiting.add(id);

    const drivers = [...(direct.get(id) ?? [])];
    for (const recipe of consumers.get(id) ?? []) {
      const parent = resolve(recipe.output);
      const top = parent?.drivers[0];
      if (!parent || !top) continue;
      drivers.push({
        ruleId: top.ruleId,
        reason: top.reason,
        impact: parent.impact * (recipe.passThrough ?? DEFAULT_PASS_THROUGH),
        confidence: parent.confidence * (recipe.verified ? 1 : UNVERIFIED_RECIPE_FACTOR),
        path: [...top.path, id],
      });
    }

    visiting.delete(id);
    const result =
      drivers.length > 0
        ? { itemId: id, ...combine(drivers), drivers: drivers.sort((a, b) => b.impact - a.impact) }
        : null;
    memo.set(id, result);
    return result;
  };

  const out = new Map<ItemId, Demand>();
  for (const item of k.items) {
    const demand = resolve(item.id);
    if (demand) out.set(item.id, demand);
  }
  return out;
}
