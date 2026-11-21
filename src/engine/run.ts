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
  if (assessments.length === 0) return rules;
  const names = deps.repo.itemNames(assessments.map((a) => a.itemId));
  for (const item of deps.knowledge.items) if (!names.has(item.id)) names.set(item.id, item.name);
  const ai = aiPredictions(assessments, prices, names, opts);
  return mergePredictions(rules, ai, new Set(assessments.map((a) => a.itemId))).sort(byActionThenUpside);
}

/**
 * Ein Engine-Durchlauf: Prognosen für alle aktiven Realms berechnen, loggen und
 * neue Alerts erzeugen, wenn eine Empfehlung auf "kaufen" oder "verkaufen" springt.
 */
export function runEngine(deps: EngineDeps, now = Date.now()): { predictions: number; alerts: Alert[] } {
  const realms = new Set(deps.repo.realms(now - 7 * DAY_MS));
  realms.add(deps.config.defaultRealm);

  const alerts: Alert[] = [];
  let count = 0;
  deps.repo.transaction(() => {
    for (const realm of realms) {
      const predictions = predictionsFor(deps, realm, now);
      count += predictions.length;
      deps.repo.logPredictions(now, predictions);
      for (const p of predictions) {
        const previous = deps.repo.getAction(realm, p.itemId, p.eventId);
        if (previous === p.action) continue;
        deps.repo.setAction(realm, p.itemId, p.eventId, p.action, now);
        if (ALERT_ACTIONS.has(p.action)) alerts.push(deps.repo.insertAlert(now, p, previous));
      }
    }
  });
  return { predictions: count, alerts };
}
