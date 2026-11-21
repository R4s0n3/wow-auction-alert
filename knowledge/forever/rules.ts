import type { DemandRule } from "../../src/knowledge/types.ts";

// Eine Regel sagt: "Event X treibt die Nachfrage nach Item/Tag Y um impact".
// Auf die Reagenzien rechnet die Engine das über die Rezepte selbst runter.
export const rules: DemandRule[] = [
  {
    id: "wave1-raid-consumables",
    event: "forever-raids-wave1",
    target: { tag: "raid-consumable" },
    impact: 0.6,
    confidence: 0.6,
    reason: "Erste Raid-Welle: Gilden decken sich mit Flasks, Elixieren und Tränken ein",
  },
  {
    id: "wave1-onyxia-fire",
    event: "forever-raids-wave1",
    target: { item: 13457 },
    impact: 0.5,
    confidence: 0.4,
    reason: "Onyxia macht Feuerschaden (Tiefer Atem), Feuerschutztränke für Ony-Raids",
  },
  // TODO Barrow Deeps / Hyjal Summit: Boss-Mechaniken sind noch unbekannt.
  // Regeln ergänzen, sobald Bossinfos (z. B. Schatten-/Naturschaden) bekannt sind.
];
