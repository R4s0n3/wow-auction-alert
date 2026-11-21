// Quellen für den Lagebericht, kostenlos und ohne KI gesammelt: RSS-Feeds der
// großen Forever-Seiten. Das ersetzt die bezahlte Websuche (die kostet pro Suche
// Gebühren und viele Tokens für Suchergebnisse). Ein einziger Modellaufruf macht
// daraus danach den Bericht.

export interface SourceDoc {
  site: string;
  title: string;
  url: string;
  /** Unix-Millisekunden, null wenn der Feed kein Datum hat */
  publishedAt: number | null;
  text: string;
}

export const FEEDS = [
  { site: "Wowhead", url: "https://www.wowhead.com/news/rss/forever" },
  { site: "Warcraft Tavern", url: "https://www.warcrafttavern.com/forever/feed/" },
];

const MAX_DOC_CHARS = 4_000;
const MAX_TOTAL_CHARS = 120_000; // ~30k Tokens, mit DeepSeek unter einem Cent
const MAX_AGE_DAYS = 21;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

function field(item: string, tag: string): string | null {
  const m = item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return null;
  return m[1]!.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
}

/** HTML → lesbarer Text: Skripte raus, Tags raus, Entities auflösen, Leerraum zusammenfassen */
export function htmlToText(s: string): string {
  return decode(
    decode(s) // Feeds escapen das HTML oft einmal extra
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function parseFeed(xml: string, site: string): SourceDoc[] {
  const docs: SourceDoc[] = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const item = m[0];
    const title = htmlToText(field(item, "title") ?? "");
    const url = decode(field(item, "link") ?? "").trim();
    if (!title || !/^https:\/\//.test(url)) continue;
    const body = field(item, "content:encoded") ?? field(item, "description") ?? "";
    const date = Date.parse(field(item, "pubDate") ?? "");
    docs.push({ site, title, url, publishedAt: Number.isFinite(date) ? date : null, text: htmlToText(body).slice(0, MAX_DOC_CHARS) });
  }
  return docs;
}

/**
 * Holt alle Feeds, nimmt nur Artikel der letzten Wochen, Neueste zuerst, ohne
 * Duplikate, und begrenzt die Gesamtlänge. Ein Feed, der nicht antwortet, fehlt eben.
 */
export async function fetchSources(opts: { now?: number; fetchImpl?: typeof fetch; log?: (m: string) => void } = {}): Promise<SourceDoc[]> {
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const results = await Promise.all(
    FEEDS.map(async (feed) => {
      try {
        const res = await fetchImpl(feed.url, { headers: { "user-agent": "Mozilla/5.0 (compatible; wahp-server/1.0)", accept: "application/rss+xml, application/xml" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parseFeed(await res.text(), feed.site);
      } catch (err) {
        opts.log?.(`Feed ${feed.site} nicht erreichbar: ${err instanceof Error ? err.message : err}`);
        return [];
      }
    }),
  );
  const cutoff = now - MAX_AGE_DAYS * 86_400_000;
  const seen = new Set<string>();
  const docs = results
    .flat()
    .filter((d) => (d.publishedAt === null || d.publishedAt >= cutoff) && !seen.has(d.url) && seen.add(d.url))
    .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
  const out: SourceDoc[] = [];
  let total = 0;
  for (const d of docs) {
    if (total + d.text.length > MAX_TOTAL_CHARS) break;
    out.push(d);
    total += d.text.length;
  }
  return out;
}
