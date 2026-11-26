import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db/database.ts";
import { Repo } from "../src/db/repo.ts";
import { iconsFor, iconUrl, lookupIcon, resolveIcons, wowheadUrl } from "../src/icons.ts";

const NOW = Date.parse("2026-11-21T15:00:00Z");
const DAY = 86_400_000;

/** Nachgebautes Wowhead: 1 hat ein Icon, 2 gibt es nicht, 3 ist nicht erreichbar, 4 liefert Unsinn */
function fakeWowhead(calls: string[]): typeof fetch {
  return (async (url: string) => {
    calls.push(url);
    const id = Number(url.match(/item\/(\d+)/)![1]);
    if (id === 1) return Response.json({ name: "Pestblüte", quality: 1, icon: "INV_Misc_Herb_Plaguebloom", tooltip: "<b>Pestblüte</b><br />Handwerksmaterial<br />Maximaler Stapel: 20" });
    if (id === 2) return new Response(null, { status: 404 });
    if (id === 3) throw new Error("ECONNRESET");
    return Response.json({ name: "x".repeat(500), quality: 99, icon: "../../evil.png" });
  }) as unknown as typeof fetch;
}

describe("Icons von Wowhead", () => {
  test("holt fehlende Icons einmal, merkt sich Fehlschläge, fragt Netzfehler später nochmal", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.insertScan("eu", "t", NOW, [{ itemId: 2, minBuyout: 100, quantity: 1, name: "Aus dem Spiel", quality: 3 }]);
    const calls: string[] = [];
    const found = await resolveIcons(repo, [1, 2, 3, 4, 1], { now: NOW, fetchImpl: fakeWowhead(calls) });
    expect(found).toBe(1);
    expect(calls).toHaveLength(4); // doppelte ID nur einmal
    expect(calls[0]).toBe("https://nether.wowhead.com/forever/tooltip/item/1?locale=3");

    const meta = repo.itemMeta([1, 2, 4]);
    expect(meta.get(1)).toEqual({ icon: "inv_misc_herb_plaguebloom", quality: 1 });
    expect(repo.itemFacts([1]).get(1)).toEqual({ name: "Pestblüte", classId: null, whKind: "trade" }); // aus dem Tooltip
    expect(meta.get(2)).toEqual({ icon: null, quality: 3 }); // Qualität aus dem Spiel bleibt
    expect(meta.get(4)).toEqual({ icon: null, quality: null }); // Unsinn verworfen
    expect(repo.itemNames([1, 2])).toEqual(new Map([[1, "Pestblüte"], [2, "Aus dem Spiel"]]));
    expect(iconsFor(repo, [1, 2, 3])).toEqual(new Map([[1, "inv_misc_herb_plaguebloom"]]));

    // Zweiter Lauf: nur der Netzfehler wird nochmal gefragt, nach einer Woche auch die ohne Icon
    calls.length = 0;
    await resolveIcons(repo, [1, 2, 3, 4], { now: NOW + DAY, fetchImpl: fakeWowhead(calls) });
    expect(calls.map((u) => u.match(/item\/(\d+)/)![1])).toEqual(["3"]);
    calls.length = 0;
    await resolveIcons(repo, [1, 2, 3, 4], { now: NOW + 8 * DAY, fetchImpl: fakeWowhead(calls) });
    expect(calls.map((u) => u.match(/item\/(\d+)/)![1]).sort()).toEqual(["2", "3", "4"]); // 1 hat Icon und Kategorie
  });

  test("Abgefangene Kiste: Inhalt aus dem Tooltip, Verfügungen aus dem Namen, beides als Bedarf", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.insertScan("eu", "t", NOW, [
      { itemId: 248709, minBuyout: 5000, quantity: 3, name: "Abgefangene Kiste: Barren des Experten" },
      { itemId: 264114, minBuyout: 900, quantity: 8, name: "Handwerksverfügung: Aschenstoffrobe" },
      { itemId: 10042, minBuyout: 60000, quantity: 2, name: "Aschenstoffrobe", classId: 4 },
      { itemId: 3860, minBuyout: 3000, quantity: 200, name: "Mithrilbarren", classId: 7 },
      { itemId: 3859, minBuyout: 2000, quantity: 100, name: "Stahlbarren", classId: 7 },
    ]);
    expect(repo.cratesWithoutNeeds()).toEqual([248709]);
    const crate = (async () =>
      Response.json({
        name: "Abgefangene Kiste: Barren des Experten",
        icon: "inv_crate_01",
        tooltip: 'Benutzen: <a href="x">Füllt die Kiste mit einem beliebigen Paket von der folgenden Liste:</a><span><br />- 20 Mithrilbarren<br />- 15 Stahlbarren<br />- 10 Goldbarren</span><br>Handwerksmaterial',
      })) as unknown as typeof fetch;
    await resolveIcons(repo, repo.cratesWithoutNeeds(), { now: NOW, fetchImpl: crate, force: true });
    expect(repo.cratesWithoutNeeds()).toEqual([]);
    expect(repo.itemFacts([248709]).get(248709)!.whKind).toBe("faction");

    const needs = repo.factionNeeds();
    expect(needs.get(3860)).toEqual(["Abgefangene Kiste: Barren des Experten"]);
    expect(needs.get(3859)).toEqual(["Abgefangene Kiste: Barren des Experten"]);
    expect(needs.get(10042)).toEqual(["Handwerksverfügung: Aschenstoffrobe"]);
    expect(needs.has(248709)).toBe(false); // Goldbarren ist nicht im AH, fehlt einfach
  });

  test("Adressen", async () => {
    expect(iconUrl("inv_misc_herb_17")).toBe("https://wow.zamimg.com/images/wow/icons/large/inv_misc_herb_17.jpg");
    expect(iconUrl("inv_misc_herb_17", "small")).toBe("https://wow.zamimg.com/images/wow/icons/small/inv_misc_herb_17.jpg");
    expect(wowheadUrl(251290)).toBe("https://www.wowhead.com/forever/de/item=251290");
    expect(await lookupIcon(3, fakeWowhead([]))).toBeNull();
  });
});
