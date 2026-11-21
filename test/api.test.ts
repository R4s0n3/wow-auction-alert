import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { startServer, type AppContext } from "../src/api/server.ts";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db/database.ts";
import { Repo } from "../src/db/repo.ts";
import { runEngine } from "../src/engine/run.ts";
import { chunkMessages, formatAlert, sendDiscord } from "../src/live/discord.ts";
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

describe("Startseite", () => {
  test("ohne READ_TOKEN: Überblick mit Realm, Links ohne Token", async () => {
    ctx = makeContext();
    await postScan(scan(3000));
    const res = await fetch(url("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("AH-Prognose-Server läuft");
    expect(html).toContain("<td>eu</td>");
    expect(html).toContain('href="/predictions?realm=eu"');
    expect(html).toContain("Noch keiner"); // kein Lagebericht
    expect((await fetch(url("/favicon.ico"))).status).toBe(204);
  });

  test("mit READ_TOKEN: ohne Token nur das Formular, mit Token Daten und Links mit Token", async () => {
    ctx = { ...makeContext(), config: loadConfig({ INGEST_TOKEN: TOKEN, READ_TOKEN: "le<s>en", DEFAULT_REALM: "eu" }) };
    await postScan(scan(3000));
    const locked = await (await fetch(url("/"))).text();
    expect(locked).toContain('name="token"');
    expect(locked).not.toContain("<td>eu</td>");
    expect(await (await fetch(url("/?token=falsch"))).text()).toContain("Der Token stimmt nicht");

    const open = await (await fetch(url(`/?token=${encodeURIComponent("le<s>en")}`))).text();
    expect(open).toContain("<td>eu</td>");
    expect(open).toContain(`href="/predictions?realm=eu&amp;token=le%3Cs%3Een"`);
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
  test("formatiert Alerts lesbar und schickt sie gebündelt", async () => {
    const { alerts } = runEngine(ctx, NOW);
    const text = formatAlert(alerts.find((a) => a.itemId === 4)!);
    expect(text).toContain("🟢 **KAUFEN: Pestblüte** (eu)");
    expect(text).toContain("Kaufen bis 05.12.2026, verkaufen 08.12.2026–19.12.2026");
    expect(text).toContain("Warum: Raids → Mungo → Pestblüte. Raid-Release");

    const calls: Array<{ content: string; allowed_mentions: unknown }> = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(init.body as string));
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await sendDiscord("https://discord.test/webhook", alerts, fakeFetch);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.content.length <= 2000)).toBe(true);
    expect(calls[0]!.allowed_mentions).toEqual({ parse: [] });
  });

  test("Rate-Limit: wartet bei leerem Kontingent und bei 429, nichts geht verloren", async () => {
    const alerts = runEngine(ctx, NOW).alerts;
    const many = Array.from({ length: 12 }, () => alerts).flat(); // mehrere Nachrichten
    const expected = chunkMessages(many.map(formatAlert)).length;
    expect(expected).toBeGreaterThan(2);

    const sent: string[] = [];
    const waits: number[] = [];
    let n = 0;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      n += 1;
      // Zweite Anfrage wird gebremst, nach jeder fünften ist das Kontingent leer
      if (n === 2) return Response.json({ message: "You are being rate limited.", retry_after: 0.25, global: false }, { status: 429 });
      sent.push(JSON.parse(init.body as string).content);
      const headers = sent.length % 5 === 0 ? { "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "1.5" } : undefined;
      return new Response(null, { status: 204, headers });
    }) as unknown as typeof fetch;
    await sendDiscord("https://discord.test/webhook", many, fakeFetch, async (ms) => void waits.push(ms));

    expect(sent).toHaveLength(expected);
    expect(new Set(sent).size).toBe(new Set(chunkMessages(many.map(formatAlert))).size);
    expect(waits[0]).toBe(250);
    expect(waits.filter((w) => w === 1500)).toHaveLength(Math.floor(expected / 5));
  });

  test("gelöschter Webhook: abbrechen statt jede Nachricht einzeln scheitern lassen", async () => {
    const alerts = Array.from({ length: 12 }, () => runEngine(ctx, NOW).alerts).flat();
    let n = 0;
    const fakeFetch = (async () => {
      n += 1;
      return Response.json({ message: "Unknown Webhook", code: 10015 }, { status: 404 });
    }) as unknown as typeof fetch;
    await sendDiscord("https://discord.test/webhook", alerts, fakeFetch, async () => {});
    expect(n).toBe(1);
  });

  test("chunkMessages bleibt unter dem Limit", () => {
    const chunks = chunkMessages(Array.from({ length: 40 }, () => "x".repeat(300)));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 1900)).toBe(true);
  });
});
