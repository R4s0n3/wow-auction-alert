import type { Knowledge } from "./types.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === date;
}

/** Liefert alle Fehler in der Wissensbasis (leer = alles ok). */
export function validateKnowledge(k: Knowledge): string[] {
  const errors: string[] = [];

  const itemIds = new Set<number>();
  for (const item of k.items) {
    if (!Number.isInteger(item.id) || item.id <= 0) errors.push(`Item "${item.name}": ungültige ID ${item.id}`);
    if (itemIds.has(item.id)) errors.push(`Item ${item.id} ist doppelt`);
    itemIds.add(item.id);
  }
  const tags = new Set(k.items.flatMap((i) => i.tags ?? []));

  const recipeIds = new Set<string>();
  for (const r of k.recipes) {
    if (recipeIds.has(r.id)) errors.push(`Rezept ${r.id} ist doppelt`);
    recipeIds.add(r.id);
    if (!itemIds.has(r.output)) errors.push(`Rezept ${r.id}: unbekanntes Produkt ${r.output}`);
    if (r.reagents.length === 0) errors.push(`Rezept ${r.id}: keine Reagenzien`);
    for (const [id, qty] of r.reagents) {
      if (!itemIds.has(id)) errors.push(`Rezept ${r.id}: unbekanntes Reagenz ${id}`);
      if (!(qty > 0)) errors.push(`Rezept ${r.id}: Menge für ${id} muss > 0 sein`);
      if (id === r.output) errors.push(`Rezept ${r.id}: Produkt ist sein eigenes Reagenz`);
    }
    if (r.passThrough !== undefined && !(r.passThrough >= 0 && r.passThrough <= 1)) {
      errors.push(`Rezept ${r.id}: passThrough muss zwischen 0 und 1 liegen`);
    }
  }

  const eventIds = new Set<string>();
  for (const e of k.events) {
    if (eventIds.has(e.id)) errors.push(`Event ${e.id} ist doppelt`);
    eventIds.add(e.id);
    if (!isValidDate(e.date)) errors.push(`Event ${e.id}: ungültiges Datum "${e.date}" (erwartet YYYY-MM-DD)`);
  }

  const ruleIds = new Set<string>();
  for (const rule of k.rules) {
    if (ruleIds.has(rule.id)) errors.push(`Regel ${rule.id} ist doppelt`);
    ruleIds.add(rule.id);
    if (!eventIds.has(rule.event)) errors.push(`Regel ${rule.id}: unbekanntes Event ${rule.event}`);
    if ("item" in rule.target) {
      if (!itemIds.has(rule.target.item)) errors.push(`Regel ${rule.id}: unbekanntes Item ${rule.target.item}`);
    } else if (!tags.has(rule.target.tag)) {
      errors.push(`Regel ${rule.id}: kein Item hat den Tag "${rule.target.tag}"`);
    }
    if (!(rule.impact > 0 && rule.impact <= 3)) errors.push(`Regel ${rule.id}: impact muss in (0, 3] liegen`);
    if (!(rule.confidence >= 0 && rule.confidence <= 1)) errors.push(`Regel ${rule.id}: confidence muss in [0, 1] liegen`);
  }

  return errors;
}

export function assertValidKnowledge(k: Knowledge): Knowledge {
  const errors = validateKnowledge(k);
  if (errors.length > 0) throw new Error(`Wissensbasis ungültig:\n- ${errors.join("\n- ")}`);
  return k;
}
