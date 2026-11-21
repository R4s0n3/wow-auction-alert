import { describe, expect, test } from "bun:test";
import { marketMovers } from "../src/ai/analyze.ts";
import { FEEDS, fetchSources, htmlToText, parseFeed } from "../src/ai/sources.ts";

const NOW = Date.parse("2026-11-21T15:00:00Z");

const rss = (items: string) => `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>${items}</channel></rss>`;
const item = (title: string, url: string, date: string, body: string) =>
  `<item><title><![CDATA[${title}]]></title><link>${url}</link><pubDate>${date}</pubDate><content:encoded><![CDATA[${body}]]></content:encoded></item>`;

describe("Quellen aus RSS-Feeds", () => {
  test("parseFeed: CDATA, HTML und Entities werden zu Text, Einträge ohne https-Link fallen weg", () => {
    const xml = rss(
      item("Crafted Tier Sets &amp; Hotfixes", "https://www.wowhead.com/news/a-1", "Fri, 20 Nov 2026 18:00:00 -0600", "<p>Der erste Raid öffnet am <b>9. Dezember</b>.</p><script>evil()</script><ul><li>Feuerschutz &gt; alles</li></ul>") +
        item("Ohne Link", "javascript:alert(1)", "Fri, 20 Nov 2026 18:00:00 -0600", "x"),
    );
    const docs = parseFeed(xml, "Wowhead");
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ site: "Wowhead", title: "Crafted Tier Sets & Hotfixes", url: "https://www.wowhead.com/news/a-1" });
    expect(docs[0]!.text).toBe("Der erste Raid öffnet am 9. Dezember .\nFeuerschutz > alles");
    expect(docs[0]!.publishedAt).toBe(Date.parse("2026-11-21T00:00:00Z"));
    expect(htmlToText("&lt;p&gt;doppelt &amp;amp; escaped&lt;/p&gt;")).toBe("doppelt & escaped");
  });

  test("fetchSources: neueste zuerst, ohne alte und doppelte Artikel, ein kaputter Feed fehlt eben", async () => {
    const logs: string[] = [];
    const fakeFetch = (async (url: string) => {
      if (url === FEEDS[0]!.url) {
        return new Response(
          rss(
            item("Neu", "https://w.example/neu", "Sat, 21 Nov 2026 10:00:00 GMT", "neu") +
              item("Älter", "https://w.example/alt", "Tue, 10 Nov 2026 10:00:00 GMT", "alt") +
              item("Uralt", "https://w.example/uralt", "Thu, 01 Oct 2026 10:00:00 GMT", "uralt") +
              item("Neu doppelt", "https://w.example/neu", "Sat, 21 Nov 2026 10:00:00 GMT", "neu"),
          ),
        );
      }
      return new Response("kaputt", { status: 500 });
    }) as unknown as typeof fetch;
    const docs = await fetchSources({ now: NOW, fetchImpl: fakeFetch, log: (m) => logs.push(m) });
    expect(docs.map((d) => d.title)).toEqual(["Neu", "Älter"]);
    expect(logs).toEqual([`Feed ${FEEDS[1]!.site} nicht erreichbar: HTTP 500`]);
  });

  test("marketMovers: nur deutliche Bewegungen mit Umsatz, Steiger und Fallende getrennt", () => {
    const m = (itemId: number, name: string, price: number, before: number | null, quantity = 50) => ({ itemId, name, quality: 1, category: null, price, priceWeekBefore: before, quantity });
    const lines = marketMovers([
      m(1, "Arkanitbarren", 520_000, 400_000),
      m(2, "Writ", 9_000, 30_000),
      m(3, "Leinenstoff", 60, 30, 1000), // zu wenig Umsatz
      m(4, "Mithrilerz", 10_500, 10_000), // zu wenig Bewegung
      m(5, "Neu", 5_000, null),
    ]);
    expect(lines).toEqual(["- Arkanitbarren: +30 % (4000s → 5200s, 50 im AH)", "- Writ: -70 % (300s → 90s, 50 im AH)"]);
  });
});
