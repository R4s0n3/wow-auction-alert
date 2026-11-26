import { describe, expect, test } from "bun:test";
import { selectItems } from "../src/ai/analyze.ts";
import { itemsPrompt } from "../src/ai/prompts.ts";
import { htmlToText } from "../src/ai/sources.ts";
import type { MarketItem } from "../src/ai/types.ts";
import { categorize, kindFromClass, kindFromTooltip, parseCrateNeeds } from "../src/categories.ts";
import { extractScans } from "../src/companion/wow.ts";
import type { Prediction } from "../src/engine/predict.ts";
import { usesHint } from "../src/live/discord.ts";

// Tooltip-Texte wie Wowhead sie für Forever liefert (gekürzt)
const TIP = {
  armor: "Sturmschleierrüstung<br>Gegenstandsstufe 57<br>Wird beim Anlegen gebunden<br>Brust Leder<br>163 Rüstung<br>Haltbarkeit 100 / 100",
  herb: "Pestblüte<br>Gegenstandsstufe 57<br>Handwerksmaterial<br>Maximaler Stapel: 20",
  potion: "Großer Feuerschutztrank<br>Benutzen: Absorbiert 1950 bis 3250 Feuerschaden.<br>Maximaler Stapel: 5",
  bag: "Runenstofftasche<br>Tasche mit 14 Plätzen",
  writ: "Handwerksverfügung: Manatrank<br>Experte<br>Dieser Gegenstand startet eine Quest.",
};

describe("Kategorien", () => {
  test("aus der Itemklasse des Clients", () => {
    expect([7, 0, 9, 2, 4, 1, 12, 15].map(kindFromClass)).toEqual(["trade", "consumable", "recipe", "gear", "gear", "other", "other", "other"]);
  });

  test("aus dem Wowhead-Tooltip", () => {
    expect(kindFromTooltip("Sturmschleierrüstung", htmlToText(TIP.armor))).toBe("gear");
    expect(kindFromTooltip("Pestblüte", htmlToText(TIP.herb))).toBe("trade");
    expect(kindFromTooltip("Großer Feuerschutztrank", htmlToText(TIP.potion))).toBe("consumable");
    expect(kindFromTooltip("Runenstofftasche", htmlToText(TIP.bag))).toBe("other");
    expect(kindFromTooltip("Handwerksverfügung: Manatrank", htmlToText(TIP.writ))).toBe("faction");
    expect(kindFromTooltip("Muster: Runenstofftasche", "Benutzen: Lehrt Euch …")).toBe("recipe");
    expect(kindFromTooltip("Irgendwas", "nur Text")).toBeNull();
  });

  test("Reihenfolge: Fraktion vor Klasse vor Tooltip vor Name, Ausrüstung nur mit Verwendung", () => {
    expect(categorize({ name: "Abgefangene Kiste: Erz des Experten", classId: 7, whKind: null }, false)).toBe("faction");
    expect(categorize({ name: "Arkanitbarren", classId: 7, whKind: "gear" }, false)).toBe("trade"); // Klasse schlägt Tooltip
    expect(categorize({ name: "Löwenherzhelm", classId: 4, whKind: null }, false)).toBe("gear");
    expect(categorize({ name: "Aschenstoffrobe", classId: 4, whKind: null }, true)).toBe("faction"); // eine Verfügung verlangt sie
    expect(categorize({ name: "Pestblüte", classId: null, whKind: "trade" }, false)).toBe("trade");
    expect(categorize({ name: "Rezept: Manatrank", classId: null, whKind: null }, false)).toBe("recipe");
    expect(categorize({ name: "Unbekanntes", classId: null, whKind: null }, false)).toBe("unknown");
  });

  test("Kisten-Inhalt aus dem Tooltip", () => {
    expect(parseCrateNeeds("Benutzen: Füllt die Kiste …:\n- 20 Mithrilbarren\n- 15 Stahlbarren\nHandwerksmaterial")).toEqual([
      { count: 20, name: "Mithrilbarren" },
      { count: 15, name: "Stahlbarren" },
    ]);
    expect(parseCrateNeeds("keine Liste")).toEqual([]);
  });
});

describe("Kategorien in Analyse, Prompt und Discord", () => {
  const item = (over: Partial<MarketItem>): MarketItem => ({ itemId: 1, name: "X", quality: 1, category: null, price: 10_000, priceWeekBefore: null, quantity: 10, ...over });

  test("BoE-Ausrüstung kostet keine KI-Tokens mehr, Ausrüstung für Verfügungen schon", () => {
    const list = [
      item({ itemId: 1, name: "Löwenherzhelm", kind: "gear", price: 6_890_000 }),
      item({ itemId: 2, name: "Aschenstoffrobe", kind: "faction", uses: ["Handwerksverfügung: Aschenstoffrobe"] }),
      item({ itemId: 3, name: "Mithrilbarren", kind: "trade" }),
    ];
    const picked = selectItems(list, new Map(), { reassessHours: 72, now: 0 }).map((i) => i.itemId).sort();
    expect(picked).toEqual([2, 3]);
  });

  test("der Prompt nennt Kategorie und die Nachfrage der Handwerks-Fraktion", () => {
    const prompt = itemsPrompt([
      item({ itemId: 3860, name: "Mithrilbarren", kind: "trade", uses: ["Abgefangene Kiste: Barren des Experten"] }),
      item({ itemId: 10042, name: "Aschenstoffrobe", kind: "faction", uses: ["Handwerksverfügung: Aschenstoffrobe"] }),
      item({ itemId: 5, name: "Alt", kind: "unknown", category: "Handwerkswaren/Kräuter" }),
    ]);
    expect(prompt).toContain("3860 | Mithrilbarren | Gewöhnlich | Handwerkswaren, für Abgefangene Kisten |");
    expect(prompt).toContain("10042 | Aschenstoffrobe | Gewöhnlich | Handwerks-Fraktion, für Handwerksverfügung |");
    expect(prompt).toContain("5 | Alt | Gewöhnlich | Handwerkswaren/Kräuter |"); // ohne Kategorie: Text aus dem Client
  });

  test("Discord-Hinweis, wenn die Fraktion das Item verlangt", () => {
    const p = (uses?: string[]) => ({ uses }) as Prediction;
    expect(usesHint(p(["Abgefangene Kiste: Barren des Experten"]))).toBe("📦 für Kisten");
    expect(usesHint(p(["Handwerksverfügung: Aschenstoffrobe"]))).toBe("📜 für Verfügung");
    expect(usesHint(p(["Handwerksverfügung: X", "Abgefangene Kiste: Y"]))).toBe("📜📦 für Verfügung & Kisten");
    expect(usesHint(p())).toBeNull();
  });

  test("Companion reicht Itemklasse und Unterklasse aus dem Addon weiter", () => {
    const [scan] = extractScans({
      scans: [{ realm: "", faction: "Alliance", region: 3, scannedAt: 1_795_000_000, items: { 13466: { min: 3500, mkt: 4000, q: 200 } } }],
      itemInfo: { 13466: { n: "Pestblüte", ql: 1, cls: 7, sub: 9 }, 99: { cls: 99 } },
    });
    expect(scan!.items[0]).toMatchObject({ itemId: 13466, name: "Pestblüte", classId: 7, subclassId: 9 });
  });
});
