import { categorize, FOCUS } from "../categories.ts";
import type { Config } from "../config.ts";
import type { Alert, Repo } from "../db/repo.ts";
import type { Knowledge } from "../knowledge/types.ts";
import { aiPredictions, mergePredictions } from "./ai.ts";
import { DAY_MS } from "./curve.ts";
import { byActionThenUpside, predict, type Action, type Prediction } from "./predict.ts";

/** Nur bei diesen Wechseln geht ein Alert raus */
const ALERT_ACTIONS = new Set<Action>(["buy", "sell"]);

export interface EngineDeps {
  repo: Repo;
  knowledge: Knowledge;
  config: Config;
}

/**
 * Setzt Kategorie und Verwendung bei der Handwerks-Fraktion und wirft BoE-Ausrüstung
 * raus, die keine Verfügung verlangt (ein ganz anderer Markt, dafür taugt das hier nicht).
 */
export function categorized(repo: Repo, list: Prediction[]): Prediction[] {
  const facts = repo.itemFacts(list.map((p) => p.itemId));
  const needs = repo.factionNeeds();
  const out: Prediction[] = [];
  for (const p of list) {
    const f = facts.get(p.itemId);
    const uses = needs.get(p.itemId);
    const category = categorize({ name: f?.name ?? p.itemName, classId: f?.classId ?? null, whKind: f?.whKind ?? null }, uses !== undefined);
    if (category === "gear") continue;
    out.push({ ...p, category, ...(uses ? { uses } : {}) });
  }
  return out;
}

/**
 * Alerts für Discord: Kategorie neu bestimmen (gerade frisch von Wowhead geholt) und nur
 * den Fokus behalten, also Handwerkswaren und Handwerks-Fraktion.
 */
export function focusAlerts(repo: Repo, alerts: Alert[]): Alert[] {
  const fresh = new Map(categorized(repo, alerts.map((a) => a.prediction)).map((p) => [`${p.itemId}:${p.eventId}`, p]));
  return alerts.flatMap((a) => {
    const p = fresh.get(`${a.itemId}:${a.eventId}`);
    return p && FOCUS.includes(p.category ?? "unknown") ? [{ ...a, prediction: p }] : [];
  });
}

export function predictionsFor(deps: EngineDeps, realm: string, now: number): Prediction[] {
  const opts = {
    realm,
    now,
    minUpside: deps.config.minUpside,
    minConfidence: deps.config.minConfidence,
    ahCut: deps.config.ahCut,
  };
  const prices = deps.repo.priceProvider(realm);
  const rules = predict(deps.knowledge, prices, opts);

  const assessments = deps.repo.assessments(realm, now - deps.config.aiMaxAgeDays * DAY_MS);
  if (assessments.length === 0) return categorized(deps.repo, rules);
  const names = deps.repo.itemNames(assessments.map((a) => a.itemId));
  for (const item of deps.knowledge.items) if (!names.has(item.id)) names.set(item.id, item.name);
  const ai = aiPredictions(assessments, prices, names, opts);
  return categorized(deps.repo, mergePredictions(rules, ai, new Set(assessments.map((a) => a.itemId))).sort(byActionThenUpside));
}

/**
 * Ein Engine-Durchlauf: Prognosen für alle aktiven Realms berechnen, loggen und
 * neue Alerts erzeugen, wenn eine Empfehlung auf "kaufen" oder "verkaufen" springt.
 */
export function runEngine(
  deps: EngineDeps,
  now = Date.now(),
): { predictions: number; alerts: Alert[]; /** Items mit Kauf- oder Verkaufssignal, z. B. für Icons */ signalItemIds: number[] } {
  const realms = new Set(deps.repo.realms(now - 7 * DAY_MS));
  realms.add(deps.config.defaultRealm);

  const alerts: Alert[] = [];
  const signals = new Set<number>();
  let count = 0;
  deps.repo.transaction(() => {
    for (const realm of realms) {
      const predictions = predictionsFor(deps, realm, now);
      count += predictions.length;
      deps.repo.logPredictions(now, predictions);
      for (const p of predictions) {
        if (ALERT_ACTIONS.has(p.action)) signals.add(p.itemId);
        const previous = deps.repo.getAction(realm, p.itemId, p.eventId);
        if (previous === p.action) continue;
        deps.repo.setAction(realm, p.itemId, p.eventId, p.action, now);
        if (ALERT_ACTIONS.has(p.action)) alerts.push(deps.repo.insertAlert(now, p, previous));
      }
    }
  });
  return { predictions: count, alerts, signalItemIds: [...signals] };
}
