import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaToolUnion,
  BetaUsage,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { AiProvider } from "../config.ts";
import { AssessmentBatchSchema, sanitizeAssessment, type Assessment, type Source } from "./types.ts";

/** Lehnt das Modell ab, springt serverseitig ein passendes Ersatzmodell ein. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_CONTINUATIONS = 6;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export class AiError extends Error {}

/**
 * Bei OpenRouter nur die Rechenzentren, die Websuche und strukturierte Ausgabe nativ
 * können (laut /api/v1/models/anthropic/claude-opus-5.5/endpoints, Stand 2026-11).
 * Bedrock, Azure und Google haben keine native Websuche, Bedrock auch keine strukturierte Ausgabe.
 */
export const OPENROUTER_ENDPOINTS = ["anthropic", "claude-on-aws"];

/**
 * Anthropic direkt: Ersatzmodell bei Ablehnung. OpenRouter versteht unter `fallbacks`
 * etwas anderes (eine Modell-Liste bei Ausfällen), dort legen wir stattdessen die
 * Rechenzentren fest, günstigste zuerst (der doppelt so teure Fast-Endpunkt nur als letzter Ausweg).
 */
function providerParams(provider: AiProvider) {
  if (provider === "anthropic") return { betas: [FALLBACK_BETA], fallbacks: "default" as const };
  return { provider: { only: OPENROUTER_ENDPOINTS, sort: "price" } };
}

interface Tokens {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  webSearches: number;
  requests: number;
}

const noTokens = (): Tokens => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, webSearches: 0, requests: 0 });

/** Zählt Tokens, Websuchen und Kosten über alle Anfragen eines Laufs. */
export class UsageTally {
  input = 0;
  output = 0;
  cacheWrite = 0;
  cacheRead = 0;
  webSearches = 0;
  requests = 0;
  /** Echte Kosten, soweit der Anbieter sie mitschickt (OpenRouter: usage.cost) */
  billedUsd = 0;
  /** Anfragen ohne mitgeschickte Kosten, die werden aus den Tokens geschätzt */
  private unbilled = noTokens();

  add(u: BetaUsage): void {
    const t: Tokens = {
      input: u.input_tokens,
      output: u.output_tokens,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      webSearches: u.server_tool_use?.web_search_requests ?? 0,
      requests: 1,
    };
    for (const k of Object.keys(t) as Array<keyof Tokens>) this[k] += t[k];
    const cost = (u as { cost?: unknown }).cost;
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
      this.billedUsd += cost;
      return;
    }
    for (const k of Object.keys(t) as Array<keyof Tokens>) this.unbilled[k] += t[k];
  }

  /** Kosten in USD: gemeldete plus geschätzte, null wenn etwas zu schätzen ist und das Modell unbekannt */
  costUsd(model: string): number | null {
    const u = this.unbilled;
    if (u.requests === 0) return this.billedUsd;
    const p = priceFor(model);
    if (!p) return null;
    return (
      this.billedUsd +
      (u.input * p.input + u.output * p.output + u.cacheWrite * p.input * 1.25 + u.cacheRead * p.cacheRead) / 1e6 +
      u.webSearches * 0.01
    );
  }
}

/** USD pro Million Tokens (Stand 2026-11), OpenRouter reicht dieselben Preise durch */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2 },
};

/** Preise für claude-opus-5-5 und die OpenRouter-Schreibweise anthropic/claude-opus-5.5 */
export function priceFor(model: string): (typeof PRICES)[string] | null {
  return PRICES[model.replace(/^anthropic\//, "").replace(/\./g, "-")] ?? null;
}

function checkStop(msg: BetaMessage, what: string): void {
  if (msg.stop_reason === "refusal") {
    throw new AiError(`${what}: Modell hat abgelehnt (${msg.stop_details?.category ?? "ohne Kategorie"})`);
  }
}

/** Quellen aus Suchergebnissen und Zitaten, Zitate zuerst, ohne Duplikate. */
export function collectSources(blocks: BetaContentBlock[]): Source[] {
  const cited = new Map<string, Source>();
  const found = new Map<string, Source>();
  for (const b of blocks) {
    if (b.type === "text") {
      for (const c of b.citations ?? []) {
        if (c.type === "web_search_result_location" && !cited.has(c.url)) cited.set(c.url, { url: c.url, title: c.title ?? c.url });
      }
    } else if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) if (!found.has(r.url)) found.set(r.url, { url: r.url, title: r.title });
    } else if (b.type === "web_fetch_tool_result" && b.content.type === "web_fetch_result") {
      const url = b.content.url;
      if (!found.has(url)) found.set(url, { url, title: b.content.content.title ?? url });
    }
  }
  for (const [url, s] of found) if (!cited.has(url)) cited.set(url, s);
  return [...cited.values()];
}

/** Der eigentliche Bericht: Text nach dem letzten Werkzeug-Ergebnis (davor sind Zwischenstände). */
export function finalText(blocks: BetaContentBlock[]): string {
  let start = 0;
  blocks.forEach((b, i) => {
    if (b.type === "web_search_tool_result" || b.type === "web_fetch_tool_result" || b.type === "server_tool_use") start = i + 1;
  });
  const text = blocks
    .slice(start)
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return text;
}

export interface ResearchResult {
  content: string;
  sources: Source[];
}

/**
 * Recherche mit Websuche: Claude sucht selbst (serverseitig), wir sammeln den
 * Bericht und die Quellen ein. Lange Recherchen pausieren (pause_turn) und
 * werden mit derselben Unterhaltung fortgesetzt.
 */
export async function research(
  client: Anthropic,
  opts: {
    provider: AiProvider;
    model: string;
    effort: Effort;
    system: string;
    prompt: string;
    usage: UsageTally;
    maxSearches?: number;
  },
): Promise<ResearchResult> {
  const messages: BetaMessageParam[] = [{ role: "user", content: opts.prompt }];
  const blocks: BetaContentBlock[] = [];
  const tools: BetaToolUnion[] = [{ type: "web_search_20260209", name: "web_search", max_uses: opts.maxSearches ?? 20 }];
  // OpenRouter reicht die Websuche im Anthropic-Format durch, Web-Fetch nicht
  if (opts.provider === "anthropic") tools.push({ type: "web_fetch_20260209", name: "web_fetch", max_uses: 10 });

  for (let turn = 0; ; turn++) {
    if (turn >= MAX_CONTINUATIONS) throw new AiError("Recherche: zu viele Fortsetzungen, Abbruch");
    const msg = await client.beta.messages
      .stream({
        model: opts.model,
        max_tokens: 64_000,
        ...providerParams(opts.provider),
        thinking: { type: "adaptive" },
        output_config: { effort: opts.effort },
        system: opts.system,
        tools,
        messages,
      })
      .finalMessage();
    opts.usage.add(msg.usage);
    checkStop(msg, "Recherche");
    blocks.push(...msg.content);
    if (msg.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: msg.content });
      continue;
    }
    if (msg.stop_reason === "max_tokens") throw new AiError("Recherche: Antwort abgeschnitten (max_tokens)");
    break;
  }

  const content = finalText(blocks);
  if (!content) throw new AiError("Recherche: kein Bericht in der Antwort");
  return { content, sources: collectSources(blocks) };
}

export type AssessResult = { ok: true; assessments: Assessment[] } | { ok: false; truncated: true };

/**
 * Bewertet einen Block Items. Der System-Prompt mit dem Lagebericht ist für
 * alle Blöcke gleich und wird gecacht, nur die Item-Liste ändert sich.
 */
export async function assessChunk(
  client: Anthropic,
  opts: {
    provider: AiProvider;
    model: string;
    effort: Effort;
    system: string;
    prompt: string;
    itemIds: number[];
    usage: UsageTally;
  },
): Promise<AssessResult> {
  const msg = await client.beta.messages.create({
    model: opts.model,
    max_tokens: 16_000,
    ...providerParams(opts.provider),
    thinking: { type: "adaptive" },
    output_config: { effort: opts.effort, format: betaZodOutputFormat(AssessmentBatchSchema) },
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: opts.prompt }],
  });
  opts.usage.add(msg.usage);
  checkStop(msg, "Bewertung");
  if (msg.stop_reason === "max_tokens") return { ok: false, truncated: true };

  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AiError("Bewertung: Antwort ist kein gültiges JSON");
  }
  const parsed = AssessmentBatchSchema.safeParse(json);
  if (!parsed.success) throw new AiError(`Bewertung: Antwort passt nicht zum Schema (${parsed.error.issues[0]?.message})`);

  // Nur Items aus diesem Block, jedes nur einmal
  const wanted = new Set(opts.itemIds);
  const seen = new Set<number>();
  const assessments: Assessment[] = [];
  for (const a of parsed.data.assessments) {
    if (!wanted.has(a.itemId) || seen.has(a.itemId)) continue;
    seen.add(a.itemId);
    assessments.push(sanitizeAssessment(a));
  }
  return { ok: true, assessments };
}
