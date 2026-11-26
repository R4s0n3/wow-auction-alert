import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { startServer, type AppContext } from "../src/api/server.ts";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db/database.ts";
import { Repo } from "../src/db/repo.ts";
import { predictionsFor, runEngine } from "../src/engine/run.ts";
import { toAddonLua } from "../src/export/lua.ts";
import { discordMessages, dots, itemLines, sendDiscord, shortGold, weeklyMessages } from "../src/live/discord.ts";
import { digestDue, sendWeeklyDigest } from "../src/digest.ts";
import type { Alert } from "../src/db/repo.ts";
import type { Prediction } from "../src/engine/predict.ts";
import { LiveHub } from "../src/live/hub.ts";
import { DAY, EVENT_MS, testKnowledge } from "./fixtures.ts";

const NOW = EVENT_MS - 25 * DAY;
const TOKEN = "test-token";

function makeContext(): AppContext {
  return {
    repo: new Repo(openDatabase(":memory:")),
    knowledge: testKnowledge,
    config: loadConfig({ INGEST_TOKEN: TOKEN, DEFAULT_REALM: "eu" }),
    hub: new LiveHub(),
    now: () => NOW,
    // Keine echten Anfragen an Wowhead aus den Tests
    iconFetch: (async () => new Response(null, { status: 404 })) as unknown as typeof fetch,
  };
}

let ctx = makeContext();
const server = startServer(
  new Proxy({} as AppContext, { get: (_, key) => ctx[key as keyof AppContext] }),
  0,
);
const url = (path: string) => new URL(path, server.url).toString();
const json = (res: Response): Promise<any> => res.json();

const postScan = (body: unknown, token = TOKEN) =>
  fetch(url("/scans"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

const scan = (minBuyout: number, scannedAt = Math.floor(NOW / 1000) - 3600) => ({
  realm: "eu",
  source: "test",
  scannedAt,
  items: [{ itemId: 4, minBuyout, quantity: 20 }],
});

beforeEach(() => {
  ctx.hub.close();
  ctx = makeContext();
});

afterAll(() => {
  ctx.hub.close();
  server.stop(true);
});

describe("POST /scans", () => {
  test("ohne oder mit falschem Token: 401", async () => {
    expect((await postScan(scan(100), "falsch")).status).toBe(401);
    const res = await fetch(url("/scans"), { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  test("ohne konfigurierten Token sind Uploads aus", async () => {
    ctx.config = loadConfig({});
    expect((await postScan(scan(100))).status).toBe(503);
  });

  test("ungültige Daten: 400 mit Grund", async () => {
    const res = await postScan({ ...scan(100), items: [{ itemId: 4, minBuyout: -1 }] });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain("items[0]");
  });

  test("speichert und fließt in die Prognose ein", async () => {
    const res = await postScan(scan(12_345));
    expect(await json(res)).toEqual({ stored: 1 });

    const body = await json(await fetch(url("/items/4/predictions?realm=eu")));
    expect(body.predictions).toHaveLength(1);
    expect(body.predictions[0].currentPrice).toBe(12_345);
    expect(body.predictions[0].action).toBe("buy");
  });
});

describe("GET-Endpoints", () => {
  test("/predictions filtert nach action", async () => {
    const all = await json(await fetch(url("/predictions")));
    expect(all.predictions.length).toBeGreaterThan(0);
    const holds = await json(await fetch(url("/predictions?action=hold")));
    expect(holds.predictions).toHaveLength(0);
    expect((await fetch(url("/predictions?action=quatsch"))).status).toBe(400);
  });

  test("/events liefert Status und Fenster", async () => {
    const [event] = await json(await fetch(url("/events")));
    expect(event.status).toBe("upcoming");
    expect(event.buyUntil).toBe("2026-12-05");
    expect(event.sellFrom).toBe("2026-12-08");
  });

  test("/export/addon.lua liefert eine Lua-Tabelle", async () => {
    const res = await fetch(url("/export/addon.lua"));
    expect(res.headers.get("content-type")).toContain("lua");
    const lua = await res.text();
    expect(lua).toContain("WAHP_DATA = {");
    expect(lua).toContain("[4] = {");
    expect(lua).toContain('action = "buy"');
    expect(lua).toContain('why = "Raids → Mungo → Pestblüte: Raid-Release"');
  });

  test("ungültiger Realm: 400", async () => {
    expect((await fetch(url("/predictions?realm=../../etc"))).status).toBe(400);
  });

  test("unbekannte Route: 404", async () => {
    expect((await fetch(url("/gibts-nicht"))).status).toBe(404);
  });
});

describe("Engine + Live", () => {
  test("Alerts nur bei Wechsel auf kaufen/verkaufen, nicht bei jedem Durchlauf", () => {
    const first = runEngine(ctx, NOW);
    expect(first.alerts.length).toBe(first.predictions);
    expect(runEngine(ctx, NOW).alerts).toHaveLength(0);

    // Zwei Tage vor Release: alles springt auf "halten", das ist kein Alert
    expect(runEngine(ctx, EVENT_MS - 2 * DAY).alerts).toHaveLength(0);
    // Release: Verkaufsfenster, Alerts gehen raus
    const sell = runEngine(ctx, EVENT_MS + 1 * DAY);
    expect(sell.alerts.length).toBe(sell.predictions);
    expect(sell.alerts.every((a) => a.action === "sell" && a.previousAction === "hold")).toBe(true);
    expect(ctx.repo.recentAlerts("eu", 500)).toHaveLength(first.alerts.length + sell.alerts.length);
  });

  test("/stream schickt neue Alerts live raus", async () => {
    const res = await fetch(url("/stream?realm=eu"));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toContain("verbunden");

    const { alerts } = runEngine(ctx, NOW);
    ctx.hub.broadcast(alerts);

    let received = "";
    while (!received.includes("Pestblüte")) received += decoder.decode((await reader.read()).value);
    expect(received).toContain("event: alert");
    await reader.cancel();
  });
});

describe("Gewinner und Verlierer der Woche", () => {
  test("Startseite: zwei Top-10-Listen oben, alle Signale hinter einem Knopf, ohne Vorwoche keine echte Bewegung", async () => {
    ctx = makeContext();
    await postScan(scan(3000));
    ctx.repo.setItemMeta(4, { icon: null, quality: null, name: null, kind: "trade" }, NOW); // Pestblüte: Handwerkswaren
    const html = await (await fetch(url("/"))).text();
    const focus = html.split('data-view="focus"')[2]!.split('<div class="catview"')[0]!; // [1] ist der Knopf
    const winners = focus.split("📈 Gewinner der Woche")[1]!.split("</section>")[0]!;
    expect(winners).toContain("jetzt kaufen");
    expect(winners).toContain('<span class="pos">1</span>');
    expect(winners).toContain('<span class="name">Pestblüte</span>');
    expect(winners.match(/<li class="rank">/g)!.length).toBe(1); // im Fokus nur Pestblüte, der Rest hat noch keine Kategorie
    expect(winners).toContain('<span class="cat" title="Handwerkswaren">🧱</span>');
    expect(focus.split("📉 Verlierer der Woche")[1]!.split("</section>")[0]).toContain("Gerade nichts.");
    const all = html.split('<div class="catview" data-view="all" hidden>')[1]!.split('<div class="catview"')[0]!;
    expect(all.split("</section>")[0]!.match(/<li class="rank">/g)!.length).toBeGreaterThan(1); // "Alle" zeigt auch die ohne Kategorie
    expect(html).toContain('<button class="catbtn" type="button" data-view="focus" aria-pressed="true">🎯 Fokus<span class="n">1</span></button>');
    expect(html).toContain('<div class="all" hidden>');
    expect(html.indexOf("Gewinner der Woche")).toBeLessThan(html.indexOf('<div class="all" hidden>'));
    expect(html).not.toContain("Echte Bewegung");
  });

  test("BoE-Ausrüstung fliegt raus, außer eine Handwerksverfügung verlangt sie", async () => {
    ctx = makeContext();
    // Rüstung ohne und mit Verfügung, dazu die Verfügung selbst
    ctx.repo.insertScan("eu", "t", NOW - 3_600_000, [
      { itemId: 4, minBuyout: 3000, quantity: 20, classId: 7 },
      { itemId: 20, minBuyout: 50000, quantity: 3, name: "Feuerschutz", classId: 4 },
      { itemId: 10, minBuyout: 40000, quantity: 3, name: "Flask A", classId: 2 },
      { itemId: 999, minBuyout: 900, quantity: 5, name: "Handwerksverfügung: Flask A" },
    ]);
    const preds = predictionsFor(ctx, "eu", NOW);
    const by = new Map(preds.map((p) => [p.itemId, p]));
    expect(by.get(4)?.category).toBe("trade");
    expect(by.has(20)).toBe(false); // Rüstung ohne Verwendung: raus
    expect(by.get(10)).toMatchObject({ category: "gear", uses: ["Handwerksverfügung: Flask A"] }); // bleibt, weil verlangt
    const lua = toAddonLua(preds, { realm: "eu", generatedAt: NOW });
    expect(lua).toContain('cat = "gear", uses = "Handwerksverfügung: Flask A"');
    expect(lua).not.toContain("[20] =");
  });

  test("Startseite: mit Scans aus der Vorwoche erscheint, was wirklich gestiegen ist", async () => {
    ctx = makeContext();
    await postScan(scan(3000, Math.floor((NOW - 8 * DAY) / 1000)));
    await postScan(scan(6000));
    const html = await (await fetch(url("/"))).text();
    const moved = html.split("Echte Bewegung seit letzter Woche")[1]!;
    expect(moved.split("🔻 Gefallen")[0]).toContain('<span class="name">Pestblüte</span>');
    expect(moved.split("🔻 Gefallen")[0]).toContain('<span class="chg">+100 %</span>');
    expect(moved.split("🔻 Gefallen")[1]).toContain("Nichts Auffälliges.");
  });

  test("Discord-Rückblick: nummerierte Karten, Gewinner und Verlierer getrennt", () => {
    const p = (i: number, action: "buy" | "sell"): Prediction => ({
      source: "ai", realm: "eu", itemId: i, itemName: `Item ${i}`, eventId: "ai", eventName: "x", eventDate: null, action,
      impact: action === "buy" ? 0.5 : -0.4, confidence: 0.6, netUpside: action === "buy" ? 0.4 : -0.45, currentPrice: 10_000 * i,
      baselinePrice: null, expectedPeakPrice: 12_000 * i, priceBasis: "current", buyUntil: "2026-12-05", sellFrom: null, sellTo: "2026-12-01", drivers: [],
    });
    const top = { winners: [1, 2, 3].map((i) => p(i, "buy")), losers: [4, 5].map((i) => p(i, "sell")) };
    const [win, lose] = weeklyMessages("eu-alliance", top, { publicUrl: "https://wahp.example.com" }, NOW);
    expect(win!.embeds.map((e) => e.title)).toEqual(["1. Item 1", "2. Item 2", "3. Item 3"]);
    expect(win!.embeds[0]!.author!.name).toBe("📈 GEWINNER DER WOCHE · jetzt kaufen");
    expect(lose!.embeds[0]!.author!.name).toBe("📉 VERLIERER DER WOCHE · jetzt verkaufen");
    expect(lose!.embeds[0]!.color).toBe(0xe74c3c);
    expect(lose!.embeds.at(-1)!.footer!.text).toBe("eu-alliance · alle Signale auf wahp.example.com");
    expect(weeklyMessages("eu", { winners: top.winners, losers: [] })).toHaveLength(1);
  });

  test("Rückblick nur montags ab 9 Uhr Berlin, höchstens einmal pro Woche, und wird verschickt", async () => {
    const monday9 = Date.parse("2026-11-23T08:00:00Z"); // 09:00 MEZ
    expect(digestDue(monday9, null)).toBe(true);
    expect(digestDue(monday9 - 60_000, null)).toBe(false); // 08:59
    expect(digestDue(Date.parse("2026-11-22T12:00:00Z"), null)).toBe(false); // Sonntag
    expect(digestDue(monday9 + 3_600_000, monday9)).toBe(false); // schon verschickt
    expect(digestDue(monday9 + 7 * DAY, monday9 + 15 * 60_000)).toBe(true); // nächste Woche
    expect(digestDue(Date.parse("2026-06-01T07:00:00Z"), null)).toBe(true); // Sommerzeit: 09:00 MESZ

    ctx = makeContext();
    await postScan(scan(3000));
    ctx.repo.setItemMeta(4, { icon: null, quality: null, name: null, kind: "trade" }, NOW); // Pestblüte: Handwerkswaren
    const posted: any[] = [];
    const fakeFetch = (async (target: string, init?: RequestInit) => {
      if (String(target).includes("wowhead")) return new Response(null, { status: 404 });
      posted.push(JSON.parse(init!.body as string));
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const config = { ...ctx.config, discordWebhookUrl: "https://discord.test/hook", publicUrl: "https://wahp.example.com" };
    const n = await sendWeeklyDigest({ repo: ctx.repo, knowledge: ctx.knowledge, config, fetchImpl: fakeFetch, sleep: async () => {} }, NOW);
    expect(n).toBeGreaterThan(0);
    expect(posted).toHaveLength(1); // vor dem Raid nur Gewinner
    expect(posted[0].embeds[0].author.name).toBe("📈 GEWINNER DER WOCHE · jetzt kaufen");
    expect(posted[0].embeds.length).toBeLessThanOrEqual(10);
    expect(ctx.repo.getMeta("weekly_digest_sent_at")).toBe(String(NOW));
  });
});

describe("Startseite", () => {
  test("ohne READ_TOKEN: Karten mit Wowhead-Link, Icon sobald bekannt, Verkaufen-Tab zuerst", async () => {
    ctx = makeContext();
    await postScan(scan(3000));
    const res = await fetch(url("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    let html = await res.text();
    expect(html).toContain("<h1><span class=\"live\"></span>AH-Prognose</h1>");
    expect(html).toContain("🌍 <b>eu</b>");
    expect(html.indexOf('data-panel="sell"')).toBeLessThan(html.indexOf('data-panel="buy"'));
    const sell = html.split('id="sell"')[1]!.split('id="buy"')[0]!;
    expect(sell).toContain("Gerade nichts."); // vor dem Raid nur Kaufen
    const buy = html.split('id="buy"')[1]!;
    expect(buy).toContain('<article class="card buy" data-name="pestblüte" data-views="all">'); // ohne Kategorie nur unter Alle
    expect(buy).toContain('href="https://www.wowhead.com/forever/de/item=4"');
    expect(buy).toContain('<span class="icon none">P</span>'); // noch kein Icon
    expect(buy).toMatch(/<span class="badge">\+\d+ %<\/span>/);
    expect(html).toContain("wow.zamimg.com/js/tooltips.js");

    ctx.repo.setIcon(4, "inv_misc_herb_17", 1, null, NOW);
    html = await (await fetch(url("/"))).text();
    expect(html).toContain('src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_herb_17.jpg"');
    expect((await fetch(url("/favicon.ico"))).status).toBe(204);
  });

  test("mit READ_TOKEN: ohne Token nur das Formular, mit Token Daten und Links mit Token", async () => {
    ctx = { ...makeContext(), config: loadConfig({ INGEST_TOKEN: TOKEN, READ_TOKEN: "le<s>en", DEFAULT_REALM: "eu" }) };
    await postScan(scan(3000));
    const locked = await (await fetch(url("/"))).text();
    expect(locked).toContain('name="token"');
    expect(locked).not.toContain("pestblüte");
    expect(await (await fetch(url("/?token=falsch"))).text()).toContain("Der Token stimmt nicht");

    const open = await (await fetch(url(`/?token=${encodeURIComponent("le<s>en")}`))).text();
    expect(open).toContain('data-name="pestblüte"');
    expect(open).not.toContain("le<s>en");
  });
});

describe("READ_TOKEN fürs Netz", () => {
  test("ohne Token offen, mit Token nur mit READ_TOKEN oder INGEST_TOKEN lesbar, /health immer", async () => {
    expect((await fetch(url("/predictions"))).status).toBe(200);

    ctx = { ...makeContext(), config: loadConfig({ INGEST_TOKEN: TOKEN, READ_TOKEN: "lesen", DEFAULT_REALM: "eu" }) };
    const get = (path: string, token?: string) =>
      fetch(url(path), token ? { headers: { authorization: `Bearer ${token}` } } : undefined).then((r) => r.status);

    for (const path of ["/predictions", "/events", "/brief", "/assessments", "/alerts", "/items/4/predictions", "/export/addon.lua", "/stream"]) {
      expect(await get(path)).toBe(401);
      expect(await get(path, "falsch")).toBe(401);
    }
    expect(await get("/predictions", "lesen")).toBe(200);
    expect(await get("/predictions", TOKEN)).toBe(200); // Companion schickt den INGEST_TOKEN
    expect(await get("/predictions?token=lesen")).toBe(200); // Browser
    expect(await get("/predictions?token=lese")).toBe(401);
    expect(await get("/health")).toBe(200);
    expect((await postScan(scan(3000))).status).toBe(200); // Hochladen weiter mit INGEST_TOKEN
  });
});

describe("Discord", () => {
  const ai = (over: Partial<Prediction> = {}): Prediction => ({
    source: "ai", realm: "eu-alliance", itemId: 13468, itemName: "Schwarzer Lotus", eventId: "ai", eventName: "Mehr Spieler auf 60",
    eventDate: null, action: "sell", impact: -0.3, confidence: 0.7, netUpside: -0.33, currentPrice: 950_000, baselinePrice: null,
    expectedPeakPrice: 665_000, priceBasis: "current", buyUntil: null, sellFrom: null, sellTo: "2026-12-05",
    drivers: [{ chain: "", reason: "Mehr Lotus-Farmer.", impact: -0.3, confidence: 0.7 }], ...over,
  });
  const alertOf = (p: Prediction, realm = p.realm): Alert => ({ id: 1, ts: NOW, realm, itemId: p.itemId, eventId: p.eventId, action: p.action, previousAction: null, prediction: { ...p, realm } });

  test("eine Karte pro Item: Wowhead-Link, Icon, zwei kurze Zeilen, Zähler im Footer", () => {
    const { alerts } = runEngine(ctx, NOW);
    const icons = new Map([[4, "inv_misc_herb_17"]]);
    const [msg, ...rest] = discordMessages(alerts, { icons, publicUrl: "https://wahp.example.com/" });
    expect(rest).toHaveLength(0); // ein Realm, eine Nachricht
    expect(msg!.embeds[0]!.author!.name).toMatch(/^🟢 KAUFEN · \d+$/);
    const pest = msg!.embeds.find((e) => e.title === "Pestblüte")!;
    expect(pest).toMatchObject({ url: "https://www.wowhead.com/forever/de/item=4", color: 0x2ecc71, thumbnail: { url: "https://wow.zamimg.com/images/wow/icons/large/inv_misc_herb_17.jpg" } });
    const [first, second] = pest.description.split("\n");
    expect(first).toMatch(/^📈 \*\*\+\d+ %\*\*/);
    expect(second).toMatch(/^⏳ 05\.12\. · [●○]{5}$/);
    expect(msg!.embeds.filter((e) => e.thumbnail)).toHaveLength(1); // nur wo ein Icon bekannt ist
    const last = msg!.embeds.at(-1)!;
    expect(last.timestamp).toBe(new Date(NOW).toISOString());
    const hidden = alerts.length - msg!.embeds.length;
    expect(last.footer!.text).toBe(`eu · ${hidden > 0 ? `+${hidden} weitere auf wahp.example.com · ` : ""}●●●○○ Sicherheit`);
    expect(msg!.embeds.every((e) => !e.description.includes("Warum"))).toBe(true);
  });

  test("Zeilen: fallender Preis, ohne Preis, Peak-Verkauf, Kurzformen", () => {
    expect(itemLines(ai())).toEqual(["📉 **−30 %** · 95g → 66g 50s", "⏳ 05.12. · ●●●●○ 🤖"]);
    expect(itemLines(ai({ sellTo: null, currentPrice: null }))).toEqual(["📉 **−30 %**", "⏳ jetzt · ●●●●○ 🤖"]);
    expect(itemLines(ai({ source: "rules", impact: 0.6, currentPrice: 22_000, sellTo: "2026-12-19", confidence: 0.1 }))).toEqual(["💰 **Peak** · 2g 20s", "⏳ 19.12. · ●○○○○"]);
    expect([1_234_567, 10_000, 4_000, 35].map(shortGold)).toEqual(["123g", "1g", "40s", "35c"]);
    expect(dots(0)).toBe("●○○○○");
    expect(dots(1)).toBe("●●●●●");
  });

  test("Verkaufen zuerst: höchstens 6 Verkaufs- und 4 Kaufkarten, nach Gold sortiert", () => {
    const sells = Array.from({ length: 9 }, (_, i) => alertOf(ai({ itemId: 100 + i, itemName: `Verkauf ${i}`, currentPrice: 10_000 * (i + 1) })));
    const buys = Array.from({ length: 5 }, (_, i) => alertOf(ai({ action: "buy", itemId: 200 + i, itemName: `Kauf ${i}`, impact: 0.5, netUpside: 0.4, buyUntil: "2026-12-05" })));
    const [msg] = discordMessages([...buys, ...sells]);
    expect(msg!.embeds).toHaveLength(10);
    expect(msg!.embeds.map((e) => e.title).slice(0, 6)).toEqual(["Verkauf 8", "Verkauf 7", "Verkauf 6", "Verkauf 5", "Verkauf 4", "Verkauf 3"]);
    expect(msg!.embeds[0]!.author!.name).toBe("🔴 VERKAUFEN · 9");
    expect(msg!.embeds[6]!.author!.name).toBe("🟢 KAUFEN · 5");
    expect(msg!.embeds[6]!.color).toBe(0x2ecc71);
    expect(msg!.embeds.at(-1)!.footer!.text).toBe("eu-alliance · +4 weitere · ●●●○○ Sicherheit");
  });

  test("sortiert nach Gold pro Stück: Lotus mit -30 % vor der Kiste für 97c mit -70 %", () => {
    const crate = ai({ itemId: 3, itemName: "Abgefangene Kiste", impact: -0.7, currentPrice: 97, expectedPeakPrice: 29, confidence: 0.65, eventName: "x" });
    const [msg] = discordMessages([alertOf(crate), alertOf(ai())]);
    expect(msg!.embeds.map((e) => e.title)).toEqual(["Schwarzer Lotus", "Abgefangene Kiste"]);
  });

  test("schickt Embeds ohne Erwähnungen, eine Nachricht pro Realm", async () => {
    const { alerts } = runEngine(ctx, NOW);
    const calls: Array<{ embeds: unknown[]; allowed_mentions: unknown; username: string }> = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(init.body as string));
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const twoRealms = [...alerts, ...alerts.map((a) => ({ ...a, realm: "eu-alliance" }))];
    await sendDiscord("https://discord.test/webhook", twoRealms, fakeFetch);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.allowed_mentions).toEqual({ parse: [] });
    expect(calls[0]!.username).toBe("AH-Prognose");
    expect(calls[0]!.embeds.length).toBeGreaterThan(0);
  });

  const perRealm = (n: number) => Array.from({ length: n }, (_, i) => alertOf(ai(), `realm-${i}`));

  test("Rate-Limit: wartet bei leerem Kontingent und bei 429, nichts geht verloren", async () => {
    const many = perRealm(12);
    const sent: string[] = [];
    const waits: number[] = [];
    let n = 0;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      n += 1;
      // Zweite Anfrage wird gebremst, nach jeder fünften ist das Kontingent leer
      if (n === 2) return Response.json({ message: "You are being rate limited.", retry_after: 0.25, global: false }, { status: 429 });
      sent.push(JSON.parse(init.body as string).embeds[0].footer.text);
      const headers = sent.length % 5 === 0 ? { "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "1.5" } : undefined;
      return new Response(null, { status: 204, headers });
    }) as unknown as typeof fetch;
    await sendDiscord("https://discord.test/webhook", many, fakeFetch, async (ms) => void waits.push(ms));

    expect(sent).toHaveLength(12);
    expect(new Set(sent).size).toBe(12);
    expect(waits[0]).toBe(250);
    expect(waits.filter((w) => w === 1500)).toHaveLength(2);
  });

  test("gelöschter Webhook: abbrechen statt jede Nachricht einzeln scheitern lassen", async () => {
    let n = 0;
    const fakeFetch = (async () => {
      n += 1;
      return Response.json({ message: "Unknown Webhook", code: 10015 }, { status: 404 });
    }) as unknown as typeof fetch;
    await sendDiscord("https://discord.test/webhook", perRealm(12), fakeFetch, async () => {});
    expect(n).toBe(1);
  });
});
