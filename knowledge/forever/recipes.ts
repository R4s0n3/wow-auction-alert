import type { Recipe } from "../../src/knowledge/types.ts";

// Rezepte aus Classic 1.12, Vendor-Reagenzien (Phiolen) weggelassen.
// verified: true erst setzen, wenn das Rezept in Forever geprüft ist.
export const recipes: Recipe[] = [
  { id: "flask-titans", output: 13510, profession: "alchemy", reagents: [[13468, 1], [8846, 30], [13423, 10]] },
  { id: "flask-wisdom", output: 13511, profession: "alchemy", reagents: [[13468, 1], [13463, 30], [13467, 10]] },
  { id: "flask-supreme-power", output: 13512, profession: "alchemy", reagents: [[13468, 1], [13463, 30], [13465, 10]] },
  { id: "elixir-mongoose", output: 13452, profession: "alchemy", reagents: [[13465, 2], [13466, 2]] },
  { id: "greater-arcane-elixir", output: 13454, profession: "alchemy", reagents: [[13463, 3], [13465, 1]] },
  { id: "major-mana-potion", output: 13444, profession: "alchemy", reagents: [[13463, 3], [13467, 2]] },
  { id: "major-healing-potion", output: 13446, profession: "alchemy", reagents: [[13464, 2], [13465, 1]] },
  { id: "greater-fire-protection", output: 13457, profession: "alchemy", reagents: [[7068, 1], [13463, 1]] },
  { id: "stonescale-oil", output: 13423, profession: "alchemy", reagents: [[13422, 1]] },
];
