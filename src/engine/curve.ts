import type { Curve, EventKind, GameEvent } from "../knowledge/types.ts";

export const DAY_MS = 86_400_000;

// Muster aus Classic 2019/2020: Run-up ein paar Wochen vorher, Peak in der
// ersten Woche nach Release, danach sinkt der Preis, weil das Angebot nachzieht.
const DEFAULT_CURVES: Record<EventKind, Curve> = {
  "raid-release": { runUpDays: 21, peakOffsetDays: 3, decayDays: 28, residual: 0.35 },
  phase: { runUpDays: 28, peakOffsetDays: 3, decayDays: 35, residual: 0.35 },
  patch: { runUpDays: 14, peakOffsetDays: 2, decayDays: 21, residual: 0.25 },
  other: { runUpDays: 14, peakOffsetDays: 2, decayDays: 21, residual: 0.25 },
};

/** Verkaufsfenster rund um den Peak und letzter sinnvoller Kauftag, in Tagen. */
const SELL_BEFORE_PEAK_DAYS = 4;
const SELL_AFTER_PEAK_DAYS = 7;
const BUY_STOP_BEFORE_PEAK_DAYS = 7;

export function curveFor(event: GameEvent): Curve {
  return { ...DEFAULT_CURVES[event.kind], ...event.curve };
}

export function eventStartMs(event: GameEvent): number {
  return Date.parse(`${event.date}T00:00:00Z`);
}

const smooth = (x: number): number => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};

/**
 * Anteil des Peak-Aufschlags, der t Tage relativ zum Event im Preis steckt:
 * 0 vor dem Run-up, 1 am Peak, `residual` nach dem Abklingen.
 */
export function curveAt(t: number, c: Curve): number {
  const start = -c.runUpDays;
  const peak = c.peakOffsetDays;
  const end = peak + c.decayDays;
  if (t <= start) return 0;
  if (t < peak) return smooth((t - start) / (peak - start));
  if (t < end) return 1 - (1 - c.residual) * smooth((t - peak) / (end - peak));
  return c.residual;
}

export interface Windows {
  runUpStart: number;
  buyUntil: number;
  sellFrom: number;
  sellTo: number;
  /** Danach ist das Event für Prognosen durch */
  expires: number;
}

export function windowsFor(event: GameEvent, c: Curve): Windows {
  const start = eventStartMs(event);
  const peak = start + c.peakOffsetDays * DAY_MS;
  return {
    runUpStart: start - c.runUpDays * DAY_MS,
    buyUntil: peak - BUY_STOP_BEFORE_PEAK_DAYS * DAY_MS,
    sellFrom: peak - SELL_BEFORE_PEAK_DAYS * DAY_MS,
    sellTo: peak + SELL_AFTER_PEAK_DAYS * DAY_MS,
    expires: peak + c.decayDays * DAY_MS,
  };
}
