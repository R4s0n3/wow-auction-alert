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
    if (id === 1) return Response.json({ name: "Pestblüte", quality: 1, icon: "INV_Misc_Herb_Plaguebloom" });
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
    expect(calls.map((u) => u.match(/item\/(\d+)/)![1]).sort()).toEqual(["2", "3", "4"]);
  });

  test("Adressen", async () => {
    expect(iconUrl("inv_misc_herb_17")).toBe("https://wow.zamimg.com/images/wow/icons/large/inv_misc_herb_17.jpg");
    expect(iconUrl("inv_misc_herb_17", "small")).toBe("https://wow.zamimg.com/images/wow/icons/small/inv_misc_herb_17.jpg");
    expect(wowheadUrl(251290)).toBe("https://www.wowhead.com/forever/de/item=251290");
    expect(await lookupIcon(3, fakeWowhead([]))).toBeNull();
  });
});
