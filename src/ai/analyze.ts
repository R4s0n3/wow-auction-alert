import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.ts";
import type { Repo } from "../db/repo.ts";
import { isoDate } from "../engine/predict.ts";
import type { Knowledge } from "../knowledge/types.ts";
import { AiError, assessChunk, priceFor, research, UsageTally } from "./claude.ts";
import { assessSystem, itemsPrompt, RESEARCH_SYSTEM, researchPrompt } from "./prompts.ts";
import { apiModel } from "./provider.ts";
import type { Brief, MarketItem, StoredAssessment } from "./types.ts";

const HOUR = 3_600_000;
/** Springt der Preis seit der letzten Bewertung um mehr als das, wird neu bewertet */
const REPRICE_JUMP = 0.25;

export interface AnalyzeDeps {
  repo: Repo;
  knowledge: Knowledge;
  config: Config;
  /** Wird erst gebraucht, wenn wirklich angefragt wird (nicht bei dryRun) */
  client: () => Anthropic;
  log: (msg: string) => void;
  now?: () => number;
}

export interface AnalyzeOptions {
  realm: string;
  /** Höchstens so viele Items bewerten (die umsatzstärksten zuerst) */
  limit?: number;
  /** Auch Items neu bewerten, deren Bewertung noch frisch ist */
  all?: boolean;
  /** Lagebericht neu recherchieren, auch wenn er noch frisch ist */
  newBrief?: boolean;
  /** Nur zählen und Kosten schätzen, nichts anfragen */
  dryRun?: boolean;
}

export interface AnalyzeResult {
  realm: string;
  candidates: number;
  assessed: number;
  missing: number;
  failedChunks: number;
  briefId: number | null;
  newBrief: boolean;
  budgetHit: boolean;
  /** Bei dryRun geschätzt, sonst aus den echten Token-Zahlen */
  costUsd: number | null;
  usage: UsageTally;
}

/** Was bewertet werden soll: alles außer grauem Müll, Umsatzstärkstes zuerst, Frisches überspringen. */
export function selectItems(
  items: MarketItem[],
  existing: Map<number, StoredAssessment>,
  opts: { all?: boolean; limit?: number; reassessHours: number; now: number },
): MarketItem[] {
  const due = items.filter((i) => {
    if (i.quality !== null && i.quality < 1) return false;
    if (opts.all) return true;
    const prev = existing.get(i.itemId);
    if (!prev) return true;
    if (opts.now - prev.createdAt >= opts.reassessHours * HOUR) return true;
    return prev.priceAt !== null && prev.priceAt > 0 && Math.abs(i.price / prev.priceAt - 1) > REPRICE_JUMP;
  });
  due.sort((a, b) => b.price * b.quantity - a.price * a.quantity || a.itemId - b.itemId);
  return opts.limit !== undefined ? due.slice(0, opts.limit) : due;
}

/** Grobe Kostenschätzung vor dem Lauf, damit niemand überrascht wird. */
export function estimateCostUsd(
  model: string,
  itemCount: number,
  chunkSize: number,
  briefChars: number | null,
): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const chunks = Math.ceil(itemCount / chunkSize);
  const prefix = (briefChars ?? 15_000) / 3.5 + 1_500; // System-Prompt + Lagebericht in Tokens
  const research = briefChars === null ? (150_000 * p.input + 10_000 * p.output) / 1e6 + 20 * 0.01 : 0;
  const input = itemCount * 40 + chunks * 150;
  const output = itemCount * 110 + chunks * 2_000; // JSON + Nachdenken
  const cache = chunks > 0 ? prefix * p.input * 1.25 + (chunks - 1) * prefix * p.cacheRead : 0;
  return research + (input * p.input + output * p.output + cache) / 1e6;
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Vorübergehende Fehler (Rate-Limit, Überlast, Netz, kaputte Antwort) kosten nur
 * einen Block. Alles andere (falscher Key, falsches Modell, fehlerhafte Anfrage)
 * würde bei jedem weiteren Block genauso scheitern, dann brechen wir ab.
 */
function fatal(err: unknown): boolean {
  return !(
    err instanceof AiError ||
    err instanceof Anthropic.RateLimitError ||
    err instanceof Anthropic.InternalServerError ||
    err instanceof Anthropic.APIConnectionError
  );
}

export async function runAnalysis(deps: AnalyzeDeps, opts: AnalyzeOptions): Promise<AnalyzeResult> {
  const { repo, config, log } = deps;
  const now = (deps.now ?? Date.now)();
  const today = isoDate(now);
  const usage = new UsageTally();

  const market = repo.marketItems(opts.realm, now);
  if (market.length === 0) throw new AiError(`Keine Scan-Daten für ${opts.realm}. Erst im Spiel /wahp scan, dann den Companion laufen lassen.`);
  const existing = new Map(repo.assessments(opts.realm).map((a) => [a.itemId, a]));
  const candidates = selectItems(market, existing, {
    all: opts.all,
    limit: opts.limit,
    reassessHours: config.aiReassessHours,
    now,
  });

  const latest = repo.latestBrief();
  const needBrief = opts.newBrief || !latest || now - latest.createdAt > config.aiBriefMaxAgeHours * HOUR;
  const result: AnalyzeResult = {
    realm: opts.realm,
    candidates: candidates.length,
    assessed: 0,
    missing: 0,
    failedChunks: 0,
    briefId: latest?.id ?? null,
    newBrief: needBrief,
    budgetHit: false,
    costUsd: null,
    usage,
  };

  if (opts.dryRun) {
    result.costUsd = estimateCostUsd(config.aiModel, candidates.length, config.aiChunkSize, needBrief ? null : latest!.content.length);
    return result;
  }
  if (candidates.length === 0 && !needBrief) return result;

  const client = deps.client();
  const provider = config.aiProvider;
  const model = apiModel(config);
  const cost = () => usage.costUsd(model);
  const overBudget = () => {
    const c = cost();
    return c !== null && c >= config.aiBudgetUsd;
  };

  let brief: Brief;
  if (needBrief) {
    log("Recherchiere die aktuelle Lage mit Websuche, das dauert ein paar Minuten …");
    // Die umsatzstärksten Items helfen der Recherche, sich auf das Wichtige zu konzentrieren
    const focus = [...market].sort((a, b) => b.price * b.quantity - a.price * a.quantity).slice(0, 80);
    const r = await research(client, {
      provider,
      model,
      effort: config.aiEffort,
      system: RESEARCH_SYSTEM,
      prompt: researchPrompt(today, deps.knowledge, focus),
      usage,
    });
    brief = repo.saveBrief(now, config.aiModel, r.content, r.sources);
    log(`Lagebericht #${brief.id}: ${r.content.length} Zeichen, ${r.sources.length} Quellen, ${usage.webSearches} Suchen`);
  } else {
    brief = latest!;
    log(`Nutze Lagebericht #${brief.id} vom ${new Date(brief.createdAt).toLocaleString("de-DE")}`);
  }
  result.briefId = brief.id;

  const system = assessSystem(today, brief.content);
  const byId = new Map(candidates.map((i) => [i.itemId, i]));

  // Läuft ein Block in max_tokens, wird er halbiert und nochmal versucht
  async function assess(items: MarketItem[]): Promise<void> {
    const r = await assessChunk(client, {
      provider,
      model,
      effort: config.aiEffort,
      system,
      prompt: itemsPrompt(items),
      itemIds: items.map((i) => i.itemId),
      usage,
    });
    if (!r.ok) {
      if (items.length === 1) {
        result.missing += 1;
        return;
      }
      const half = Math.ceil(items.length / 2);
      await assess(items.slice(0, half));
      await assess(items.slice(half));
      return;
    }
    repo.saveAssessments(
      opts.realm,
      brief.id,
      now,
      r.assessments.map((a) => ({ ...a, priceAt: byId.get(a.itemId)?.price ?? null })),
    );
    result.assessed += r.assessments.length;
    result.missing += items.length - r.assessments.length;
  }

  let fatalError: unknown = null;
  async function runChunk(items: MarketItem[]): Promise<void> {
    if (fatalError) return;
    if (overBudget()) {
      result.budgetHit = true;
      return;
    }
    try {
      await assess(items);
      const c = cost();
      log(`${result.assessed}/${candidates.length} Items bewertet${c === null ? "" : `, bisher ~$${c.toFixed(2)}`}`);
    } catch (err) {
      if (fatal(err)) {
        fatalError ??= err;
        return;
      }
      result.failedChunks += 1;
      log(`Block mit ${items.length} Items fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const chunks = chunk(candidates, config.aiChunkSize);
  // Erster Block allein, damit er den Cache für den Lagebericht anlegt; danach parallel
  if (chunks[0]) await runChunk(chunks[0]);
  let next = 1;
  await Promise.all(
    Array.from({ length: Math.min(config.aiConcurrency, Math.max(0, chunks.length - 1)) }, async () => {
      while (next < chunks.length && !fatalError) await runChunk(chunks[next++]!);
    }),
  );
  if (fatalError) throw fatalError;

  result.costUsd = cost();
  if (result.budgetHit) log(`Budget von $${config.aiBudgetUsd} erreicht, der Rest kommt beim nächsten Lauf dran.`);
  return result;
}
