import type { Item } from "../../src/knowledge/types.ts";

// Item-IDs aus Classic 1.12. Forever baut auf Classic auf, neue oder geänderte
// Items müssen aber gegen die Forever-Datenbank geprüft werden.
export const items: Item[] = [
  // Kräuter
  { id: 13468, name: "Schwarzer Lotus", nameEn: "Black Lotus", tags: ["herb"] },
  { id: 13463, name: "Traumblatt", nameEn: "Dreamfoil", tags: ["herb"] },
  { id: 13464, name: "Goldener Sansam", nameEn: "Golden Sansam", tags: ["herb"] },
  { id: 13465, name: "Bergsilbersalbei", nameEn: "Mountain Silversage", tags: ["herb"] },
  { id: 13466, name: "Pestblüte", nameEn: "Plaguebloom", tags: ["herb"] },
  { id: 13467, name: "Eiskappe", nameEn: "Icecap", tags: ["herb"] },
  { id: 8846, name: "Gromsblut", nameEn: "Gromsblood", tags: ["herb"] },

  // Sonstige Mats
  { id: 7068, name: "Elementarfeuer", nameEn: "Elemental Fire", tags: ["reagent"] },
  { id: 13422, name: "Steinschuppenaal", nameEn: "Stonescale Eel", tags: ["fish"] },
  { id: 13423, name: "Steinschuppenöl", nameEn: "Stonescale Oil", tags: ["reagent"] },

  // Raid-Consumables
  { id: 13510, name: "Fläschchen der Titanen", nameEn: "Flask of the Titans", tags: ["raid-consumable", "flask"] },
  { id: 13511, name: "Fläschchen der destillierten Weisheit", nameEn: "Flask of Distilled Wisdom", tags: ["raid-consumable", "flask"] },
  { id: 13512, name: "Fläschchen der obersten Macht", nameEn: "Flask of Supreme Power", tags: ["raid-consumable", "flask"] },
  { id: 13452, name: "Elixier des Mungos", nameEn: "Elixir of the Mongoose", tags: ["raid-consumable"] },
  { id: 13454, name: "Großes Arkanelixier", nameEn: "Greater Arcane Elixir", tags: ["raid-consumable"] },
  { id: 13444, name: "Erheblicher Manatrank", nameEn: "Major Mana Potion", tags: ["raid-consumable"] },
  { id: 13446, name: "Erheblicher Heiltrank", nameEn: "Major Healing Potion", tags: ["raid-consumable"] },

  // Schutztränke
  { id: 13457, name: "Großer Feuerschutztrank", nameEn: "Greater Fire Protection Potion", tags: ["resist-fire"] },
];
