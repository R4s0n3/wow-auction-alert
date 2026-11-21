import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.ts";
import { AiError } from "./claude.ts";

/** OpenRouter spricht das Anthropic-Format unter /api/v1/messages */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

export const PROVIDER_NAME: Record<Config["aiProvider"], string> = { anthropic: "Anthropic", openrouter: "OpenRouter" };

/** Modellname, wie ihn der Anbieter erwartet: bei OpenRouter wird claude-opus-5-5 zu anthropic/claude-opus-5.5 */
export function apiModel(config: Pick<Config, "aiProvider" | "aiModel">): string {
  const model = config.aiModel;
  if (config.aiProvider !== "openrouter" || model.includes("/")) return model;
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(model);
  return m ? `anthropic/claude-${m[1]}-${m[2]}${m[3] ? `.${m[3]}` : ""}` : `anthropic/${model}`;
}

/**
 * Client für Anthropic direkt (Key aus ANTHROPIC_API_KEY) oder für OpenRouter.
 * Bei OpenRouter geht nur der OpenRouter-Key als Bearer-Token mit. Ist zusätzlich
 * ANTHROPIC_API_KEY gesetzt, liest das SDK ihn nicht, er landet also nie bei OpenRouter.
 */
export function createClient(config: Config, baseURL?: string): Anthropic {
  if (config.aiProvider === "openrouter") {
    if (!config.openrouterApiKey) throw new AiError("AI_PROVIDER=openrouter, aber OPENROUTER_API_KEY ist leer");
    return new Anthropic({ authToken: config.openrouterApiKey, baseURL: baseURL ?? OPENROUTER_BASE_URL, maxRetries: 4 });
  }
  return new Anthropic({ maxRetries: 4, ...(baseURL ? { baseURL } : {}) });
}
