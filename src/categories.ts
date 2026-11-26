// Kategorien für die Prognosen. Der Fokus liegt auf Handwerkswaren (schwanken am
// stärksten) und der Handwerks-Fraktion. BoE-Ausrüstung fliegt raus, außer eine
// Handwerksverfügung verlangt genau dieses Teil.
//
// Woher die Kategorie kommt, in dieser Reihenfolge:
//   1. Item-Klasse aus dem Client (classID über C_Item.GetItemInfoInstant, sprachunabhängig)
//   2. Wowhead-Tooltip (z. B. "Handwerksmaterial", "Wird beim Anlegen gebunden", "Haltbarkeit")
//   3. Name (Rezept-Präfixe, Verfügungen, Kisten)

export type CategoryKey = "trade" | "consumable" | "recipe" | "faction" | "gear" | "other" | "unknown";

export const CATEGORIES: Record<CategoryKey, { label: string; emoji: string }> = {
  trade: { label: "Handwerkswaren", emoji: "🧱" },
  faction: { label: "Handwerks-Fraktion", emoji: "📦" },
  consumable: { label: "Verbrauchbares", emoji: "🧪" },
  recipe: { label: "Rezepte", emoji: "📜" },
  other: { label: "Sonstiges", emoji: "🎒" },
  gear: { label: "Ausrüstung", emoji: "⚔️" },
  unknown: { label: "Noch ohne Kategorie", emoji: "❔" },
};

/** Standardansicht und Wochenrückblick */
export const FOCUS: CategoryKey[] = ["trade", "faction"];

// Namen kommen aus dem Client, also in dessen Sprache. Deutsch und Englisch werden erkannt.
export const WRIT_PREFIXES = ["Handwerksverfügung: ", "Craftsman's Writ: "];
export const CRATE_PREFIXES = ["Abgefangene Kiste: ", "Waylaid Crate: "];
/** Alte Namen, falls jemand sie importiert */
export const WRIT_PREFIX = WRIT_PREFIXES[0]!;
export const CRATE_PREFIX = CRATE_PREFIXES[0]!;
const FACTION_RE = /^(Handwerksverfügung|Abgefangene Kiste|Versiegelte Verfügung|Craftsman's Writ|Waylaid Crate|Sealed Craftsman's Writ)/;
const RECIPE_RE =
  /^((Muster|Rezept|Bauplan|Pläne|Formel|Handbuch|Kodex|Schema|Pattern|Recipe|Plans|Formula|Schematic|Blueprint|Manual|Design):|(Obere|Untere) Hälfte von|(Top|Bottom) Half of)/;

export const isWrit = (name: string) => WRIT_PREFIXES.some((p) => name.startsWith(p));
export const isCrate = (name: string) => CRATE_PREFIXES.some((p) => name.startsWith(p));

/** "Craftsman's Writ: Cindercloth Robe" → "Cindercloth Robe": das Item, das die Verfügung verlangt */
export function writTarget(name: string): string | null {
  const prefix = WRIT_PREFIXES.find((p) => name.startsWith(p));
  return prefix ? name.slice(prefix.length) : null;
}

/** WoW-Itemklassen (classID), gleich in allen Sprachen */
export function kindFromClass(classId: number): CategoryKey {
  switch (classId) {
    case 7: // Handwerkswaren (Tradeskill)
      return "trade";
    case 0: // Verbrauchbar
      return "consumable";
    case 9: // Rezept
      return "recipe";
    case 2: // Waffe
    case 4: // Rüstung
      return "gear";
    default: // Behälter, Reagenz, Projektil, Köcher, Quest, Schlüssel, Verschiedenes …
      return "other";
  }
}

/** Kategorie aus dem Wowhead-Tooltip-Text (deutsch oder englisch), null wenn nichts Eindeutiges drinsteht */
export function kindFromTooltip(name: string, text: string): CategoryKey | null {
  if (FACTION_RE.test(name)) return "faction";
  if (RECIPE_RE.test(name)) return "recipe";
  if ((/Pl(ä|a)tz/.test(text) && /Tasche|Behälter|Köcher|Beutel/.test(text)) || /\d+ Slot (Bag|Container|Quiver|Ammo Pouch)/.test(text)) return "other";
  if (/Haltbarkeit \d+ ?\/ ?\d+|Durability \d+ ?\/ ?\d+|Wird beim Anlegen gebunden|Binds when equipped/.test(text)) return "gear";
  if (/Handwerksmaterial|Crafting Reagent/.test(text)) return "trade";
  if (/Benutzen:|Use:/.test(text)) return "consumable";
  if (/Dieser Gegenstand startet eine Quest|This Item Begins a Quest/.test(text)) return "other";
  return null;
}

export interface ItemFacts {
  name: string | null;
  classId: number | null;
  whKind: string | null;
}

/**
 * Endgültige Kategorie. `needed`: eine Verfügung oder Kiste verlangt das Item. Ausrüstung
 * zählt dann zur Handwerks-Fraktion, sonst bleibt sie "gear" und wird ausgeblendet.
 */
export function categorize(item: ItemFacts, needed: boolean): CategoryKey {
  const name = item.name ?? "";
  let kind: CategoryKey;
  if (FACTION_RE.test(name)) kind = "faction";
  else if (item.classId !== null) kind = kindFromClass(item.classId);
  else if (item.whKind && item.whKind in CATEGORIES) kind = item.whKind as CategoryKey;
  else if (RECIPE_RE.test(name)) kind = "recipe";
  else kind = "unknown";
  if (kind === "gear" && needed) return "faction";
  return kind;
}

/** Kisten-Tooltip: "- 20 Mithrilbarren" pro Zeile → [{ count: 20, name: "Mithrilbarren" }] */
export function parseCrateNeeds(text: string): Array<{ count: number; name: string }> {
  const out: Array<{ count: number; name: string }> = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^[-–•]\s*(\d+)\s*[x×]?\s+(.{2,80})$/);
    if (m) out.push({ count: Number(m[1]), name: m[2]!.trim() });
  }
  return out;
}
