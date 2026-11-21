import { describe, expect, test } from "bun:test";
import { forever } from "../knowledge/forever/index.ts";
import { validateKnowledge } from "../src/knowledge/validate.ts";
import { testKnowledge } from "./fixtures.ts";

describe("Wissensbasis", () => {
  test("die mitgelieferte Forever-Wissensbasis ist gültig", () => {
    expect(validateKnowledge(forever)).toEqual([]);
  });

  test("findet kaputte Referenzen und Werte", () => {
    const errors = validateKnowledge({
      ...testKnowledge,
      recipes: [...testKnowledge.recipes, { id: "kaputt", output: 999, profession: "alchemy", reagents: [[1, 0]] }],
      events: [...testKnowledge.events, { id: "falsch", name: "x", date: "2026-02-31", kind: "other" }],
      rules: [
        ...testKnowledge.rules,
        { id: "r", event: "nope", target: { tag: "gibts-nicht" }, impact: 5, confidence: 2, reason: "" },
      ],
    });
    expect(errors).toContain("Rezept kaputt: unbekanntes Produkt 999");
    expect(errors).toContain("Rezept kaputt: Menge für 1 muss > 0 sein");
    expect(errors).toContain('Event falsch: ungültiges Datum "2026-02-31" (erwartet YYYY-MM-DD)');
    expect(errors).toContain("Regel r: unbekanntes Event nope");
    expect(errors).toContain('Regel r: kein Item hat den Tag "gibts-nicht"');
    expect(errors).toContain("Regel r: impact muss in (0, 3] liegen");
    expect(errors).toContain("Regel r: confidence muss in [0, 1] liegen");
  });
});
