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

/** Was eine Ansicht braucht: Kategorie und ob die Handwerks-Fraktion das Item verlangt */
export interface Categorized {
  category?: CategoryKey;
  uses?: string[];
}

export type ViewKey = "focus" | "trade" | "faction" | "consumable" | "recipe" | "all";

/**
 * Ansichten für Website, Discord und Addon. Fokus = Handwerkswaren und Ausrüstung,
 * die eine Verfügung verlangt. Die Verfügungen und Kisten selbst stehen nur unter
 * Handwerks-Fraktion, zusammen mit allem, was sie verlangen.
 */
export const VIEWS: Array<{ key: ViewKey; label: string; emoji: string; test: (x: Categorized) => boolean }> = [
  { key: "focus", label: "Fokus", emoji: "🎯", test: (x) => x.category === "trade" || (x.category === "gear" && !!x.uses?.length) },
  { key: "trade", label: "Handwerkswaren", emoji: "🧱", test: (x) => x.category === "trade" },
  { key: "faction", label: "Handwerks-Fraktion", emoji: "📦", test: (x) => x.category === "faction" || !!x.uses?.length },
  { key: "consumable", label: "Verbrauchbares", emoji: "🧪", test: (x) => x.category === "consumable" },
  { key: "recipe", label: "Rezepte", emoji: "📜", test: (x) => x.category === "recipe" },
  { key: "all", label: "Alle", emoji: "", test: () => true },
];

/** Standardansicht, Alerts und Wochenrückblick */
export const inFocus = VIEWS[0]!.test;

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
 * Was das Item ist. "faction" sind die Verfügungen und Kisten selbst. Ob die Fraktion
 * ein Item verlangt, steht getrennt in `uses`. Ausrüstung ohne `uses` wird ausgeblendet.
 */
export function categorize(item: ItemFacts): CategoryKey {
  const name = item.name ?? "";
  if (FACTION_RE.test(name)) return "faction";
  if (item.classId !== null) return kindFromClass(item.classId);
  if (item.whKind && item.whKind in CATEGORIES) return item.whKind as CategoryKey;
  if (RECIPE_RE.test(name)) return "recipe";
  return "unknown";
}

/** BoE-Ausrüstung, die niemand bei der Fraktion verlangt: ein anderer Markt, fliegt raus */
export const dropped = (x: Categorized) => x.category === "gear" && !x.uses?.length;

/** Kisten-Tooltip: "- 20 Mithrilbarren" pro Zeile → [{ count: 20, name: "Mithrilbarren" }] */
export function parseCrateNeeds(text: string): Array<{ count: number; name: string }> {
  const out: Array<{ count: number; name: string }> = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^[-–•]\s*(\d+)\s*[x×]?\s+(.{2,80})$/);
    if (m) out.push({ count: Number(m[1]), name: m[2]!.trim() });
  }
  return out;
}
