export interface Config {
  port: number;
  dbPath: string;
  ingestToken: string;
  /** Leer = alle GET-Routen offen. Gesetzt = Lesen nur mit READ_TOKEN oder INGEST_TOKEN (fürs Netz) */
  readToken: string;
  /** Öffentliche Adresse der Website, z. B. https://wahp.app.miomideal.com (für Links in Discord) */
  publicUrl: string;
  discordWebhookUrl: string;
  engineIntervalMin: number;
  defaultRealm: string;
  minUpside: number;
  minConfidence: number;
  ahCut: number;
  /**
   * KI-Analyse (Claude), direkt bei Anthropic oder über OpenRouter. Ohne AI_PROVIDER
   * wird OpenRouter genommen, wenn nur OPENROUTER_API_KEY gesetzt ist. Den
   * Anthropic-Key liest das SDK selbst aus ANTHROPIC_API_KEY.
   */
  aiProvider: AiProvider;
  openrouterApiKey: string;
  /** Anthropic-Schreibweise (claude-opus-5-5), für OpenRouter wird sie umgesetzt */
  aiModel: string;
  /**
   * Woher der Lagebericht kommt: "feeds" (Standard) sammelt Artikel kostenlos aus RSS-Feeds
   * und braucht einen einzigen Modellaufruf. "websearch" lässt das Modell selbst suchen (teurer).
   */
  aiResearchMode: "feeds" | "websearch";
  /** Modell für den Lagebericht, Standard wie AI_MODEL. Hier lohnt ein stärkeres Modell am ehesten. */
  aiResearchModel: string;
  aiEffort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Lagebericht (Websuche) wird neu recherchiert, wenn er älter ist */
  aiBriefMaxAgeHours: number;
  /** Items werden neu bewertet, wenn ihre Bewertung älter ist oder der Preis stark gesprungen ist */
  aiReassessHours: number;
  aiChunkSize: number;
  aiConcurrency: number;
  /** Abbruch, wenn die geschätzten Kosten eines Laufs darüber liegen */
  aiBudgetUsd: number;
  /** 0 = aus. Sonst startet der Server die Analyse selbst in diesem Abstand. */
  aiIntervalHours: number;
  /** Ältere KI-Bewertungen werden ignoriert */
  aiMaxAgeDays: number;
}

export type AiProvider = "anthropic" | "openrouter";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

function provider(env: Record<string, string | undefined>): AiProvider {
  const value = env.AI_PROVIDER?.trim();
  if (value) {
    if (value !== "anthropic" && value !== "openrouter") throw new Error('AI_PROVIDER muss "anthropic" oder "openrouter" sein');
    return value;
  }
  return env.OPENROUTER_API_KEY && !env.ANTHROPIC_API_KEY ? "openrouter" : "anthropic";
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Ungültige Zahl in der Config: "${value}"`);
  return n;
}

function researchMode(value: string | undefined): Config["aiResearchMode"] {
  if (!value) return "feeds";
  if (value !== "feeds" && value !== "websearch") throw new Error('AI_RESEARCH_MODE muss "feeds" oder "websearch" sein');
  return value;
}

function effort(value: string | undefined): Config["aiEffort"] {
  if (!value) return "medium";
  if (!(EFFORTS as readonly string[]).includes(value)) throw new Error(`AI_EFFORT muss eins von ${EFFORTS.join(", ")} sein`);
  return value as Config["aiEffort"];
}

// Bun lädt .env automatisch, process.env reicht also.
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    port: num(env.PORT, 3000),
    dbPath: env.DB_PATH || "data/wahp.sqlite",
    ingestToken: env.INGEST_TOKEN ?? "",
    readToken: env.READ_TOKEN ?? "",
    publicUrl: (env.PUBLIC_URL ?? "").replace(/\/+$/, ""),
    discordWebhookUrl: env.DISCORD_WEBHOOK_URL ?? "",
    engineIntervalMin: num(env.ENGINE_INTERVAL_MIN, 15),
    defaultRealm: env.DEFAULT_REALM || "eu",
    minUpside: num(env.MIN_UPSIDE, 0.15),
    minConfidence: num(env.MIN_CONFIDENCE, 0.25),
    ahCut: 0.05,
    aiProvider: provider(env),
    openrouterApiKey: env.OPENROUTER_API_KEY ?? "",
    aiModel: env.AI_MODEL || "claude-opus-5-5",
    aiResearchMode: researchMode(env.AI_RESEARCH_MODE),
    aiResearchModel: env.AI_RESEARCH_MODEL || env.AI_MODEL || "claude-opus-5-5",
    aiEffort: effort(env.AI_EFFORT),
    aiBriefMaxAgeHours: num(env.AI_BRIEF_MAX_AGE_HOURS, 24),
    aiReassessHours: num(env.AI_REASSESS_HOURS, 72),
    aiChunkSize: Math.max(1, Math.round(num(env.AI_CHUNK_SIZE, 40))),
    aiConcurrency: Math.max(1, Math.round(num(env.AI_CONCURRENCY, 3))),
    aiBudgetUsd: num(env.AI_BUDGET_USD, 10),
    aiIntervalHours: num(env.AI_INTERVAL_HOURS, 0),
    aiMaxAgeDays: num(env.AI_MAX_AGE_DAYS, 14),
  };
}
