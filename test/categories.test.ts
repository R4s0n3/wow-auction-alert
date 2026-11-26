import { describe, expect, test } from "bun:test";
import { selectItems } from "../src/ai/analyze.ts";
import { itemsPrompt } from "../src/ai/prompts.ts";
import { htmlToText } from "../src/ai/sources.ts";
import type { MarketItem } from "../src/ai/types.ts";
import { categorize, dropped, inFocus, isCrate, kindFromClass, kindFromTooltip, parseCrateNeeds, VIEWS, writTarget, type CategoryKey } from "../src/categories.ts";
import { openDatabase } from "../src/db/database.ts";
import { Repo } from "../src/db/repo.ts";
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
    expect(categorize({ name: "Abgefangene Kiste: Erz des Experten", classId: 7, whKind: null })).toBe("faction");
    expect(categorize({ name: "Arkanitbarren", classId: 7, whKind: "gear" })).toBe("trade"); // Klasse schlägt Tooltip
    expect(categorize({ name: "Löwenherzhelm", classId: 4, whKind: null })).toBe("gear");
    expect(categorize({ name: "Aschenstoffrobe", classId: 4, whKind: null })).toBe("gear"); // was sie ist, verlangt wird extra
    expect(dropped({ category: "gear" })).toBe(true);
    expect(dropped({ category: "gear", uses: ["Craftsman's Writ: Cindercloth Robe"] })).toBe(false);
    expect(categorize({ name: "Pestblüte", classId: null, whKind: "trade" })).toBe("trade");
    expect(categorize({ name: "Rezept: Manatrank", classId: null, whKind: null })).toBe("recipe");
    expect(categorize({ name: "Unbekanntes", classId: null, whKind: null })).toBe("unknown");
  });

  test("Ansichten: Verfügungen nur unter Handwerks-Fraktion, verlangte Ausrüstung im Fokus", () => {
    const views = (x: { category: CategoryKey; uses?: string[] }) => VIEWS.filter((v) => v.test(x)).map((v) => v.key);
    expect(views({ category: "trade" })).toEqual(["focus", "trade", "all"]);
    expect(views({ category: "trade", uses: ["Waylaid Crate: Expert Ingots"] })).toEqual(["focus", "trade", "faction", "all"]);
    expect(views({ category: "faction" })).toEqual(["faction", "all"]); // die Verfügung selbst
    expect(views({ category: "gear", uses: ["Craftsman's Writ: Cindercloth Robe"] })).toEqual(["focus", "faction", "all"]);
    expect(views({ category: "consumable", uses: ["Craftsman's Writ: Elixir of Defense"] })).toEqual(["faction", "consumable", "all"]);
    expect(views({ category: "recipe" })).toEqual(["recipe", "all"]);
    expect(inFocus({ category: "faction" })).toBe(false);
  });

  test("englischer Client: Verfügungen, Kisten, Rezepte und Tooltip-Regeln", () => {
    expect(writTarget("Craftsman's Writ: Cindercloth Robe")).toBe("Cindercloth Robe");
    expect(writTarget("Handwerksverfügung: Aschenstoffrobe")).toBe("Aschenstoffrobe");
    expect(writTarget("Cindercloth Robe")).toBeNull();
    expect(isCrate("Waylaid Crate: Expert Ingots")).toBe(true);
    expect(categorize({ name: "Waylaid Crate: Expert Ingots", classId: null, whKind: null })).toBe("faction");
    expect(categorize({ name: "Sealed Craftsman's Writ", classId: null, whKind: null })).toBe("faction");
    expect(categorize({ name: "Blueprint: Molten Foundry", classId: null, whKind: null })).toBe("recipe");
    expect(kindFromTooltip("Stormshroud Armor", "Binds when equipped\nChest Leather\nDurability 100 / 100")).toBe("gear");
    expect(kindFromTooltip("Plaguebloom", "Crafting Reagent\nMax Stack: 20")).toBe("trade");
    expect(kindFromTooltip("Runecloth Bag", "14 Slot Bag")).toBe("other");
    expect(kindFromTooltip("Mana Potion", "Use: Restores 700 mana.")).toBe("consumable");
  });

  test("englischer Client: die Fraktion findet ihre Items über die englischen Namen", () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.insertScan("eu", "t", 1_795_000_000_000, [
      { itemId: 264114, minBuyout: 900, quantity: 8, name: "Craftsman's Writ: Cindercloth Robe" },
      { itemId: 10042, minBuyout: 60000, quantity: 2, name: "Cindercloth Robe", classId: 4 },
      { itemId: 248709, minBuyout: 5000, quantity: 3, name: "Waylaid Crate: Expert Ingots" },
      { itemId: 3860, minBuyout: 3000, quantity: 200, name: "Mithril Bar", classId: 7 },
    ]);
    // Kisteninhalt kam deutsch und englisch von Wowhead
    repo.setCrateNeeds(248709, [{ count: 20, name: "Mithrilbarren" }, { count: 20, name: "Mithril Bar" }]);
    const needs = repo.factionNeeds();
    expect(needs.get(10042)).toEqual(["Craftsman's Writ: Cindercloth Robe"]);
    expect(needs.get(3860)).toEqual(["Waylaid Crate: Expert Ingots"]);
    expect(usesHint({ uses: needs.get(3860) } as Prediction)).toBe("📦 für Kisten");
    expect(usesHint({ uses: needs.get(10042) } as Prediction)).toBe("📜 für Verfügung");
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
      item({ itemId: 2, name: "Aschenstoffrobe", kind: "gear", uses: ["Handwerksverfügung: Aschenstoffrobe"] }),
      item({ itemId: 3, name: "Mithrilbarren", kind: "trade" }),
    ];
    const picked = selectItems(list, new Map(), { reassessHours: 72, now: 0 }).map((i) => i.itemId).sort();
    expect(picked).toEqual([2, 3]);
  });

  test("der Prompt nennt Kategorie und die Nachfrage der Handwerks-Fraktion", () => {
    const prompt = itemsPrompt([
      item({ itemId: 3860, name: "Mithrilbarren", kind: "trade", uses: ["Abgefangene Kiste: Barren des Experten"] }),
      item({ itemId: 10042, name: "Aschenstoffrobe", kind: "gear", uses: ["Handwerksverfügung: Aschenstoffrobe"] }),
      item({ itemId: 5, name: "Alt", kind: "unknown", category: "Handwerkswaren/Kräuter" }),
    ]);
    expect(prompt).toContain("3860 | Mithrilbarren | Gewöhnlich | Handwerkswaren, für Abgefangene Kisten |");
    expect(prompt).toContain("10042 | Aschenstoffrobe | Gewöhnlich | Ausrüstung, für Handwerksverfügung |");
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
