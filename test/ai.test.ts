import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { forever } from "../knowledge/forever/index.ts";
import { estimateCostUsd, runAnalysis, selectItems, type AnalyzeDeps } from "../src/ai/analyze.ts";
import { AiError, collectSources, finalText, priceFor, UsageTally } from "../src/ai/claude.ts";
import { apiModel, createClient } from "../src/ai/provider.ts";
import { sanitizeAssessment, type MarketItem, type StoredAssessment } from "../src/ai/types.ts";
import { startServer } from "../src/api/server.ts";
import { extractScans } from "../src/companion/wow.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { openDatabase } from "../src/db/database.ts";
import { Repo } from "../src/db/repo.ts";
import { aiPredictions, mergePredictions } from "../src/engine/ai.ts";
import type { Prediction } from "../src/engine/predict.ts";
import { predictionsFor } from "../src/engine/run.ts";
import { toAddonLua } from "../src/export/lua.ts";
import { LiveHub } from "../src/live/hub.ts";
import { DAY, fakePrices } from "./fixtures.ts";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const HOUR = 3_600_000;
const REALM = "eu-everlook-alliance";
const json = (res: Response): Promise<any> => res.json();

const opts = { realm: REALM, now: NOW, minUpside: 0.15, minConfidence: 0.25, ahCut: 0.05 };

function assessment(over: Partial<StoredAssessment> = {}): StoredAssessment {
  return {
    realm: REALM,
    itemId: 13466,
    briefId: 1,
    createdAt: NOW - HOUR,
    priceAt: 4000,
    direction: "up",
    changePct: 50,
    confidence: 0.6,
    buyBy: "2026-12-01",
    sellFrom: "2026-12-08",
    sellBy: "2026-12-20",
    driver: "Onyxia → Feuerschutz",
    reason: "Gilden stocken ein.",
    ...over,
  };
}

describe("sanitizeAssessment", () => {
  test("begrenzt Zahlen, verwirft kaputte Daten, das Vorzeichen folgt der Richtung", () => {
    const a = sanitizeAssessment({
      itemId: 1,
      direction: "down",
      changePct: 900,
      confidence: 1.7,
      buyBy: "2026-02-31",
      sellFrom: "morgen",
      sellBy: "2026-12-20",
      driver: "  x  ",
      reason: "y".repeat(400),
    });
    expect(a.direction).toBe("down");
    expect(a.changePct).toBe(-95);
    expect(a.confidence).toBe(1);
    expect(a.buyBy).toBeNull();
    expect(a.sellFrom).toBeNull();
    expect(a.sellBy).toBe("2026-12-20");
    expect(a.driver).toBe("x");
    expect(a.reason).toHaveLength(300);
    expect(sanitizeAssessment({ ...a, direction: "up", changePct: 0 }).direction).toBe("flat");
    // DeepSeek am 2026-11-21: "bricht ein" mit +70 → bleibt down, Zahl wird negativ
    expect(sanitizeAssessment({ ...a, direction: "down", changePct: 70 })).toMatchObject({ direction: "down", changePct: -70 });
    expect(sanitizeAssessment({ ...a, direction: "up", changePct: -40 })).toMatchObject({ direction: "up", changePct: 40 });
    expect(sanitizeAssessment({ ...a, direction: "flat", changePct: 25 })).toMatchObject({ direction: "flat", changePct: 0 });
  });
});

describe("selectItems", () => {
  const item = (itemId: number, price: number, quantity: number, quality: number | null = 1): MarketItem => ({
    itemId,
    name: `Item ${itemId}`,
    quality,
    category: null,
    price,
    priceWeekBefore: null,
    quantity,
  });
  const items = [item(1, 100, 10), item(2, 5000, 10), item(3, 100, 1, 0), item(4, 1000, 10), item(5, 9000, 1)];

  test("ohne graue Items, Umsatzstärkstes zuerst, Limit", () => {
    const ids = selectItems(items, new Map(), { reassessHours: 72, now: NOW }).map((i) => i.itemId);
    expect(ids).toEqual([2, 4, 5, 1]);
    expect(selectItems(items, new Map(), { reassessHours: 72, now: NOW, limit: 2 }).map((i) => i.itemId)).toEqual([2, 4]);
  });

  test("frische Bewertungen werden übersprungen, außer bei Preissprung, Ablauf oder --all", () => {
    const existing = new Map([
      [2, assessment({ itemId: 2, priceAt: 5000 })], // frisch, Preis gleich: überspringen
      [4, assessment({ itemId: 4, priceAt: 500 })], // Preis verdoppelt: neu bewerten
      [5, assessment({ itemId: 5, priceAt: 9000, createdAt: NOW - 80 * HOUR })], // zu alt: neu bewerten
    ]);
    expect(selectItems(items, existing, { reassessHours: 72, now: NOW }).map((i) => i.itemId)).toEqual([4, 5, 1]);
    expect(selectItems(items, existing, { reassessHours: 72, now: NOW, all: true })).toHaveLength(4);
  });
});

describe("aiPredictions", () => {
  const names = new Map([[13466, "Pestblüte"]]);
  const prices = (p: number) => fakePrices([[13466, NOW - HOUR, p]]);
  const one = (a: StoredAssessment, price = 4000, now = NOW): Prediction => aiPredictions([a], prices(price), names, { ...opts, now })[0]!;

  test("steigend: kaufen bis buyBy, dann halten, im Fenster verkaufen, danach meiden", () => {
    const buy = one(assessment());
    expect(buy).toMatchObject({ source: "ai", action: "buy", impact: 0.5, netUpside: 0.425, expectedPeakPrice: 6000 });
    expect(buy.itemName).toBe("Pestblüte");
    expect(buy.eventName).toBe("Onyxia → Feuerschutz");
    expect(one(assessment(), 4000, Date.parse("2026-12-03T12:00:00Z")).action).toBe("hold");
    expect(one(assessment(), 4000, Date.parse("2026-12-10T12:00:00Z")).action).toBe("sell");
    expect(one(assessment(), 4000, Date.parse("2026-12-21T12:00:00Z")).action).toBe("avoid");
  });

  test("Preis schon gestiegen: der Rest-Gewinn zählt, nicht die ursprüngliche Prognose", () => {
    const p = one(assessment(), 5600);
    expect(p.netUpside).toBeCloseTo((6000 * 0.95) / 5600 - 1, 3);
    expect(p.action).toBe("watch");
  });

  test("fallend: verkaufen bei klarem Signal, sonst meiden; flat ergibt keine Prognose", () => {
    const down = assessment({ direction: "down", changePct: -30, confidence: 0.7, buyBy: null, sellFrom: null, sellBy: "2026-12-05" });
    expect(one(down)).toMatchObject({ action: "sell", impact: -0.3, expectedPeakPrice: 2800, buyUntil: null });
    expect(one({ ...down, changePct: -10 }).action).toBe("avoid");
    expect(one({ ...down, confidence: 0.1 }).action).toBe("avoid");
    expect(aiPredictions([assessment({ direction: "flat", changePct: 0 })], prices(4000), names, opts)).toEqual([]);
  });

  test("KI hat das letzte Wort, auch mit flat; Items ohne KI-Bewertung behalten die Regel", () => {
    const rule = (itemId: number) => ({ ...one(assessment()), itemId, source: "rules" }) as Prediction;
    const merged = mergePredictions([rule(13466), rule(1), rule(2)], [one(assessment())], new Set([13466, 2]));
    expect(merged.map((p) => [p.itemId, p.source])).toEqual([
      [13466, "ai"],
      [1, "rules"],
    ]);
  });
});

describe("Antworten der Recherche auswerten", () => {
  const blocks = [
    { type: "text", text: "Ich suche …" },
    { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "wow forever" } },
    {
      type: "web_search_tool_result",
      tool_use_id: "s1",
      content: [
        { type: "web_search_result", url: "https://a.example", title: "A", encrypted_content: "", page_age: null },
        { type: "web_search_result", url: "https://b.example", title: "B", encrypted_content: "", page_age: null },
      ],
    },
    {
      type: "text",
      text: "Onyxia öffnet am 2026-12-09.",
      citations: [{ type: "web_search_result_location", url: "https://b.example", title: "B", cited_text: "", encrypted_index: "" }],
    },
    { type: "text", text: " Weiter so." },
  ] as any[];

  test("Bericht ist der Text nach dem letzten Werkzeug, zitierte Quellen kommen zuerst", () => {
    expect(finalText(blocks)).toBe("Onyxia öffnet am 2026-12-09. Weiter so.");
    expect(collectSources(blocks).map((s) => s.url)).toEqual(["https://b.example", "https://a.example"]);
  });
});

// ---------------------------------------------------------------------------
// Ende-zu-Ende gegen eine nachgebaute Claude-API: echter SDK-Code, keine Kosten

type Reply = { content: any[]; stop_reason: string; usage?: Record<string, unknown> } | { status: number; error: string };
interface Call {
  body: any;
  beta: string;
  auth: string;
  path: string;
}

const calls: Call[] = [];
let handler: (body: any) => Reply = () => ({ status: 500, error: "kein Handler" });

function sse(model: string, r: Extract<Reply, { content: any[] }>): Response {
  const usage = { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...r.usage };
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage },
      },
    ],
  ];
  r.content.forEach((block, index) => {
    events.push(["content_block_start", { type: "content_block_start", index, content_block: block }]);
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: r.stop_reason, stop_sequence: null }, usage }]);
  events.push(["message_stop", { type: "message_stop" }]);
  const body = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const mock = Bun.serve({
  port: 0,
  async fetch(req) {
    const body: any = await req.json();
    calls.push({
      body,
      beta: req.headers.get("anthropic-beta") ?? "",
      auth: req.headers.get("authorization") ?? "",
      path: new URL(req.url).pathname,
    });
    const r = handler(body);
    if ("status" in r) {
      return Response.json({ type: "error", error: { type: "api_error", message: r.error } }, { status: r.status });
    }
    if (body.stream) return sse(body.model, r);
    return Response.json({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: body.model,
      content: r.content,
      stop_reason: r.stop_reason,
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 2000, output_tokens: 3000, cache_creation_input_tokens: 0, cache_read_input_tokens: 6000, ...r.usage },
    });
  },
});
afterAll(() => mock.stop(true));

const BRIEF = "Onyxia öffnet am 2026-12-09, Feuerschutz wird gebraucht.";

/** Recherche: erst eine Suche mit pause_turn, dann der Bericht mit Zitat */
function research(body: any): Reply {
  const continued = body.messages.length > 1;
  if (!continued) {
    return {
      stop_reason: "pause_turn",
      usage: { server_tool_use: { web_search_requests: 3, web_fetch_requests: 0 } },
      content: [
        { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "wow forever onyxia" } },
        {
          type: "web_search_tool_result",
          tool_use_id: "srv_1",
          content: [{ type: "web_search_result", url: "https://news.example/onyxia", title: "Onyxia", encrypted_content: "x", page_age: null }],
        },
      ],
    };
  }
  return {
    stop_reason: "end_turn",
    content: [
      {
        type: "text",
        text: BRIEF,
        citations: [{ type: "web_search_result_location", url: "https://news.example/onyxia", title: "Onyxia", cited_text: "", encrypted_index: "x" }],
      },
    ],
  };
}

const VERDICT: Record<number, object> = {
  13466: { direction: "up", changePct: 50, confidence: 0.6, buyBy: "2026-12-01", sellFrom: "2026-12-08", sellBy: "2026-12-20", driver: "Onyxia 2026-12-09 → Mungo", reason: "Gilden stocken ein." },
  13468: { direction: "down", changePct: -30, confidence: 0.7, buyBy: null, sellFrom: null, sellBy: "2026-12-05", driver: "Mehr Spieler auf 60", reason: "Mehr Lotus-Farmer." },
};

/** Bewertung: bei mehr als `maxItems` Items läuft sie in max_tokens */
function assess(body: any, maxItems = 2): Reply {
  const prompt: string = body.messages[0].content;
  const ids = [...prompt.matchAll(/^(\d+) \| /gm)].map((m) => Number(m[1]));
  if (ids.length > maxItems) return { stop_reason: "max_tokens", content: [{ type: "text", text: '{"assessments":[{"itemId' }] };
  const list = ids.map((itemId) => ({
    itemId,
    ...(VERDICT[itemId] ?? { direction: "flat", changePct: 0, confidence: 0.3, buyBy: null, sellFrom: null, sellBy: null, driver: "kein Treiber", reason: "Nichts in Sicht." }),
  }));
  // Fremde und doppelte Items muss der Server aussortieren
  list.push({ ...list[0]!, itemId: 99999 }, { ...list[0]! });
  return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ assessments: list }) }] };
}

function setup(over: Partial<Config> = {}) {
  const repo = new Repo(openDatabase(":memory:"));
  const config = { ...loadConfig({}), aiChunkSize: 3, aiConcurrency: 2, ...over };
  const scan = (ts: number, factor: number) =>
    repo.insertScan(REALM, "companion", ts, [
      { itemId: 13466, minBuyout: 3500, marketPrice: Math.round(4000 * factor), quantity: 300, name: "Pestblüte", quality: 1, category: "Handwerkswaren/Kräuter" },
      { itemId: 13468, minBuyout: 900000, marketPrice: Math.round(950000 * factor), quantity: 5, name: "Schwarzer Lotus", quality: 1 },
      { itemId: 8846, minBuyout: 1000, marketPrice: 1200, quantity: 200, name: "Gromsblut", quality: 1 },
      { itemId: 13457, minBuyout: 20000, marketPrice: 22000, quantity: 30, name: "Großer Feuerschutztrank", quality: 1 },
      { itemId: 2589, minBuyout: 50, marketPrice: 60, quantity: 1000, name: "Leinenstoff", quality: 0 },
    ]);
  scan(NOW - 5 * DAY, 0.8);
  scan(NOW - HOUR, 1);
  const logs: string[] = [];
  const deps: AnalyzeDeps = {
    repo,
    knowledge: forever,
    config,
    log: (m) => logs.push(m),
    now: () => NOW,
    client: () => new Anthropic({ apiKey: "test", baseURL: mock.url.origin, maxRetries: 0 }),
  };
  return { repo, config, deps, logs };
}

const researchCalls = () => calls.filter((c) => c.body.tools?.length);
const assessCalls = () => calls.filter((c) => c.body.output_config?.format);

describe("runAnalysis gegen nachgebaute Claude-API", () => {
  beforeEach(() => {
    calls.length = 0;
    handler = (body) => (body.tools?.length ? research(body) : assess(body));
  });

  test("recherchiert, bewertet in Blöcken, halbiert zu lange Blöcke und speichert alles", async () => {
    const { repo, deps } = setup();
    const r = await runAnalysis(deps, { realm: REALM });
    expect(r).toMatchObject({ candidates: 4, assessed: 4, missing: 0, failedChunks: 0, newBrief: true, budgetHit: false });

    // Recherche: Websuche, pause_turn wird mit derselben Unterhaltung fortgesetzt
    const rc = researchCalls();
    expect(rc).toHaveLength(2);
    expect(rc[0]!.body.stream).toBe(true);
    expect(rc[0]!.body.tools.map((t: any) => t.type)).toEqual(["web_search_20260209", "web_fetch_20260209"]);
    expect(rc[1]!.body.messages[1].role).toBe("assistant");
    // Cache über Fortsetzungen, Suchlimit pro Lauf: nach 3 Suchen bleiben 7
    expect(rc[0]!.body.cache_control).toEqual({ type: "ephemeral" });
    expect(rc.map((c) => c.body.tools[0].max_uses)).toEqual([10, 7]);
    expect(rc[0]!.body.messages[0].content).toContain("Pestblüte"); // umsatzstarke Items als Fokus

    const brief = repo.latestBrief()!;
    expect(brief.content).toBe(BRIEF);
    expect(brief.sources).toEqual([{ url: "https://news.example/onyxia", title: "Onyxia" }]);

    // Bewertung: strukturiert, Lagebericht im gecachten System-Prompt, Fallback an
    const ac = assessCalls();
    expect(ac.map((c) => c.body.messages[0].content.match(/^\d+ \| /gm)!.length)).toEqual([3, 2, 1, 1]);
    for (const c of [...ac, ...rc]) {
      expect(c.body.model).toBe("claude-opus-5-5");
      expect(c.body.fallbacks).toBe("default");
      expect(c.body.provider).toBeUndefined();
      expect(c.beta).toContain("server-side-fallback-2026-07-01");
      expect(c.body.thinking).toEqual({ type: "adaptive" });
      expect(c.body.output_config.effort).toBe("medium");
    }
    expect(ac[0]!.body.output_config.format.type).toBe("json_schema");
    expect(ac[0]!.body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(ac[0]!.body.system[0].text).toContain(BRIEF);
    expect(ac[0]!.body.messages[0].content).toContain("Pestblüte | Gewöhnlich | Handwerkswaren/Kräuter | 40s | 32s | +25 %");

    const saved = new Map(repo.assessments(REALM).map((a) => [a.itemId, a]));
    expect([...saved.keys()].sort((a, b) => a - b)).toEqual([8846, 13457, 13466, 13468]);
    expect(saved.get(13466)).toMatchObject({ direction: "up", changePct: 50, priceAt: 4000, briefId: brief.id });
    expect(r.costUsd).toBeGreaterThan(0);
  });

  test("zweiter Lauf: frischer Bericht und frische Bewertungen werden wiederverwendet", async () => {
    const { deps } = setup();
    await runAnalysis(deps, { realm: REALM });
    calls.length = 0;
    const again = await runAnalysis({ ...deps, now: () => NOW + HOUR }, { realm: REALM });
    expect(again).toMatchObject({ candidates: 0, assessed: 0, newBrief: false });
    expect(calls).toHaveLength(0);

    const all = await runAnalysis({ ...deps, now: () => NOW + HOUR }, { realm: REALM, all: true, limit: 2 });
    expect(all).toMatchObject({ candidates: 2, assessed: 2, newBrief: false });
    expect(researchCalls()).toHaveLength(0);
  });

  test("Probelauf fragt nichts an und schätzt die Kosten", async () => {
    const { deps } = setup();
    const r = await runAnalysis({ ...deps, client: () => { throw new Error("darf nicht aufgerufen werden"); } }, { realm: REALM, dryRun: true });
    expect(r.candidates).toBe(4);
    expect(r.costUsd).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
    expect(estimateCostUsd("unbekanntes-modell", 10, 40, null)).toBeNull();
  });

  test("Budget erreicht in der Recherche: keine weitere Fortsetzung, keine Bewertung", async () => {
    const { deps, repo } = setup({ aiBudgetUsd: 0.0001 });
    expect(runAnalysis(deps, { realm: REALM })).rejects.toThrow("Recherche: Budget von $0.0001 erreicht");
    await Bun.sleep(10);
    expect(researchCalls()).toHaveLength(1); // nach der ersten Pause Schluss
    expect(assessCalls()).toHaveLength(0);
    expect(repo.latestBrief()).toBeNull();
  });

  test("Budget erreicht bei der Bewertung: es wird nichts mehr bewertet", async () => {
    const { deps, logs } = setup();
    await runAnalysis(deps, { realm: REALM, limit: 0 }); // nur Bericht
    calls.length = 0;
    const r = await runAnalysis({ ...deps, config: { ...deps.config, aiBudgetUsd: 0.0001 }, now: () => NOW + HOUR }, { realm: REALM });
    expect(r.newBrief).toBe(false);
    expect(r).toMatchObject({ candidates: 4, assessed: 3, budgetHit: true }); // erster Block (3 Items) läuft fertig, der zweite nicht mehr
    expect(logs.some((l) => l.includes("Budget"))).toBe(true);
  });

  test("Serverfehler kostet nur einen Block, falscher Key bricht ab", async () => {
    const { repo, deps } = setup({ aiChunkSize: 1 });
    await runAnalysis(deps, { realm: REALM, limit: 0 }); // nur Bericht
    handler = (body) => (body.messages[0].content.includes("13468 |") ? { status: 500, error: "kaputt" } : assess(body));
    const r = await runAnalysis({ ...deps, now: () => NOW + HOUR }, { realm: REALM });
    expect(r).toMatchObject({ assessed: 3, failedChunks: 1 });
    expect(repo.assessments(REALM).map((a) => a.itemId)).not.toContain(13468);

    handler = () => ({ status: 401, error: "invalid x-api-key" });
    expect(runAnalysis({ ...deps, now: () => NOW + 2 * HOUR }, { realm: REALM, all: true })).rejects.toBeInstanceOf(
      Anthropic.AuthenticationError,
    );
  });

  test("über OpenRouter: Modellname umgesetzt, nur OpenRouter-Key, kein Anthropic-Fallback, echte Kosten", async () => {
    const config = { ...loadConfig({ OPENROUTER_API_KEY: "or-test" }), aiChunkSize: 3, aiConcurrency: 2 };
    expect(config.aiProvider).toBe("openrouter");
    const { repo, deps } = setup(config);
    // Ein gesetzter Anthropic-Key darf nie bei OpenRouter landen
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-geheim";
    let client: Anthropic;
    try {
      client = createClient(config, mock.url.origin);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
    // OpenRouter schickt die echten Kosten in usage.cost mit (hier nur bei der Bewertung)
    handler = (body) => {
      if (body.tools?.length) return research(body);
      const r = assess(body);
      if ("content" in r) r.usage = { ...r.usage, cost: 0.02 };
      return r;
    };

    const r = await runAnalysis({ ...deps, client: () => client }, { realm: REALM });
    expect(r).toMatchObject({ candidates: 4, assessed: 4, failedChunks: 0 });
    expect(repo.latestBrief()!.content).toBe(BRIEF);

    for (const c of calls) {
      expect(c.path).toBe("/v1/messages");
      expect(c.auth).toBe("Bearer or-test");
      expect(c.body.model).toBe("anthropic/claude-opus-5.5");
      expect(c.body.fallbacks).toBeUndefined();
      expect(c.beta).not.toContain("server-side-fallback");
      // Nur Rechenzentren mit nativer Websuche und strukturierter Ausgabe
      expect(c.body.provider).toEqual({ only: ["anthropic", "claude-on-aws"], sort: "price" });
      expect(c.body.thinking).toEqual({ type: "adaptive" });
    }
    expect(researchCalls()[0]!.body.tools.map((t: any) => t.type)).toEqual(["web_search_20260209"]);
    expect(assessCalls()[0]!.body.output_config.format.type).toBe("json_schema");
    expect(assessCalls()[0]!.body.system[0].cache_control).toEqual({ type: "ephemeral" });

    // 4 Bewertungen à $0.02 gemeldet, die 2 Recherche-Anfragen ohne Kosten werden geschätzt:
    // 2 × (1000 × $4 + 500 × $20) / 1M + 3 Suchen × $0.01
    expect(r.costUsd).toBeCloseTo(4 * 0.02 + 0.028 + 0.03, 6);
  });

  test("DeepSeek über OpenRouter: Modellname bleibt, OpenRouter-Suche, nur passende Anbieter", async () => {
    const model = "deepseek/deepseek-v4.1-flash-1017";
    const config = { ...loadConfig({ OPENROUTER_API_KEY: "or-test", AI_MODEL: model }), aiChunkSize: 3, aiConcurrency: 2 };
    const { deps } = setup(config);
    const client = createClient(config, mock.url.origin);
    const r = await runAnalysis({ ...deps, client: () => client }, { realm: REALM });
    expect(r).toMatchObject({ candidates: 4, assessed: 4, failedChunks: 0 });

    for (const c of calls) {
      expect(c.body.model).toBe(model);
      expect(c.body.provider).toEqual({ require_parameters: true, quantizations: ["fp8", "bf16", "fp16", "unknown"] });
      expect(c.body.fallbacks).toBeUndefined();
    }
    const rc = researchCalls();
    expect(rc[0]!.body.tools).toEqual([{ type: "openrouter:web_search", parameters: { max_results: 5, max_uses: 10 } }]);
    expect(rc[1]!.body.tools[0].parameters.max_uses).toBe(7); // 3 Suchen verbraucht
    expect(rc[0]!.body.cache_control).toBeUndefined();
    expect(assessCalls()[0]!.body.output_config.format.type).toBe("json_schema");
    expect(estimateCostUsd(model, 6608, 40, 17_739)).toBeLessThan(2);
  });

  test("ohne Scans gibt es eine klare Meldung", async () => {
    const { deps } = setup();
    expect(runAnalysis(deps, { realm: "eu-leer-horde" })).rejects.toThrow("Keine Scan-Daten");
  });

  test("Ergebnis landet in Prognosen, API und Data.lua", async () => {
    const { repo, deps, config } = setup();
    await runAnalysis(deps, { realm: REALM });

    const preds = predictionsFor({ repo, knowledge: forever, config }, REALM, NOW);
    const by = new Map(preds.map((p) => [p.itemId, p]));
    expect(by.get(13466)).toMatchObject({ source: "ai", action: "buy", itemName: "Pestblüte" });
    expect(by.get(13468)).toMatchObject({ source: "ai", action: "sell", impact: -0.3 });
    expect(by.has(8846)).toBe(false); // KI sagt flat, Regel für Gromsblut entfällt
    expect(by.get(13463)?.source).toBe("rules"); // Traumblatt hat die KI nicht gesehen

    const lua = toAddonLua(preds, { realm: REALM, generatedAt: NOW });
    expect(lua).toContain('src = "ai"');
    expect(lua).toContain('why = "Gilden stocken ein."');

    const server = startServer({ repo, knowledge: forever, config, hub: new LiveHub(), now: () => NOW }, 0);
    try {
      const up = await json(await fetch(`${server.url}assessments?realm=${REALM}&direction=up`));
      expect(up.assessments).toHaveLength(1);
      expect(up.assessments[0]).toMatchObject({ itemId: 13466, itemName: "Pestblüte" });
      expect((await fetch(`${server.url}assessments?direction=seitwärts`)).status).toBe(400);
      const brief = await json(await fetch(`${server.url}brief`));
      expect(brief.content).toBe(BRIEF);
    } finally {
      server.stop(true);
    }
  });
});

describe("Anbieter: Anthropic oder OpenRouter", () => {
  test("Auswahl aus der .env", () => {
    expect(loadConfig({}).aiProvider).toBe("anthropic");
    expect(loadConfig({ OPENROUTER_API_KEY: "or" }).aiProvider).toBe("openrouter");
    expect(loadConfig({ OPENROUTER_API_KEY: "or", ANTHROPIC_API_KEY: "sk" }).aiProvider).toBe("anthropic");
    expect(loadConfig({ OPENROUTER_API_KEY: "or", ANTHROPIC_API_KEY: "sk", AI_PROVIDER: "openrouter" }).aiProvider).toBe("openrouter");
    expect(() => loadConfig({ AI_PROVIDER: "openai" })).toThrow("AI_PROVIDER");
    expect(() => createClient(loadConfig({ AI_PROVIDER: "openrouter" }))).toThrow(AiError);
  });

  test("Modellnamen und Preise in beiden Schreibweisen", () => {
    const or = (aiModel: string) => apiModel({ aiProvider: "openrouter", aiModel });
    expect(or("claude-opus-5-5")).toBe("anthropic/claude-opus-5.5");
    expect(or("claude-sonnet-5-5")).toBe("anthropic/claude-sonnet-5.5");
    expect(or("claude-opus-5")).toBe("anthropic/claude-opus-5");
    expect(or("anthropic/claude-haiku-5.5")).toBe("anthropic/claude-haiku-5.5");
    expect(apiModel({ aiProvider: "anthropic", aiModel: "claude-opus-5-5" })).toBe("claude-opus-5-5");
    expect(priceFor("anthropic/claude-sonnet-5.5")).toEqual(priceFor("claude-sonnet-5-5"));
    expect(priceFor("anthropic/claude-sonnet-5.5")).not.toBeNull();
    expect(estimateCostUsd("anthropic/claude-opus-5.5", 100, 40, 10_000)).toBe(estimateCostUsd("claude-opus-5-5", 100, 40, 10_000));
  });

  test("gemeldete Kosten zählen exakt, nur der Rest wird geschätzt", () => {
    const u = new UsageTally();
    const usage = (extra: object) => ({ input_tokens: 1_000_000, output_tokens: 0, ...extra }) as any;
    u.add(usage({ cost: 0.5 }));
    expect(u.costUsd("unbekannt")).toBe(0.5);
    u.add(usage({}));
    expect(u.costUsd("claude-opus-5-5")).toBeCloseTo(4.5, 6);
    expect(u.costUsd("unbekannt")).toBeNull();
    expect(u.input).toBe(2_000_000);
  });
});

describe("Item-Infos aus dem Addon", () => {
  test("Companion liest WAHP_DB.itemInfo, Server speichert Name, Qualität, Kategorie", async () => {
    const [scan] = extractScans({
      scans: [{ realm: "Everlook", faction: "Alliance", region: 3, scannedAt: 1_794_740_651, items: { "13466": { min: 100, mkt: 3800, q: 101 } } }],
      itemInfo: { "13466": { n: "Pestblüte", ql: 1, c: "Handwerkswaren/Kräuter" }, "1": { n: "", ql: 99 } },
    });
    expect(scan!.items[0]).toEqual({
      itemId: 13466,
      minBuyout: 100,
      marketPrice: 3800,
      quantity: 101,
      name: "Pestblüte",
      quality: 1,
      category: "Handwerkswaren/Kräuter",
    });

    const repo = new Repo(openDatabase(":memory:"));
    const server = startServer(
      { repo, knowledge: forever, config: { ...loadConfig({ INGEST_TOKEN: "tok" }) }, hub: new LiveHub(), now: () => NOW },
      0,
    );
    try {
      const post = (items: unknown[]) =>
        fetch(`${server.url}scans`, {
          method: "POST",
          headers: { authorization: "Bearer tok", "content-type": "application/json" },
          body: JSON.stringify({ realm: REALM, scannedAt: Math.floor(NOW / 1000), items }),
        });
      expect((await post(scan!.items)).status).toBe(200);
      expect(repo.itemNames([13466]).get(13466)).toBe("Pestblüte");
      expect((await post([{ itemId: 1, minBuyout: 1, quality: 12 }])).status).toBe(400);
      expect((await post([{ itemId: 1, minBuyout: 1, name: "x".repeat(200) }])).status).toBe(400);
    } finally {
      server.stop(true);
    }
  });
});
