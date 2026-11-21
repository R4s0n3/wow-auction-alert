import { describe, expect, test } from "bun:test";
import { curveAt } from "../src/engine/curve.ts";
import { combine, computeDemand, DEFAULT_PASS_THROUGH, UNVERIFIED_RECIPE_FACTOR } from "../src/engine/demand.ts";
import { predict, type PredictOptions } from "../src/engine/predict.ts";
import { DAY, EVENT_MS, fakePrices, noPrices, testKnowledge } from "./fixtures.ts";

const curve = { runUpDays: 21, peakOffsetDays: 3, decayDays: 28, residual: 0.35 };
const opts = (now: number): PredictOptions => ({ realm: "eu", now, minUpside: 0.15, minConfidence: 0.25, ahCut: 0.05 });

describe("curveAt", () => {
  test("0 vor dem Run-up, 1 am Peak, residual nach dem Abklingen", () => {
    expect(curveAt(-30, curve)).toBe(0);
    expect(curveAt(-21, curve)).toBe(0);
    expect(curveAt(3, curve)).toBe(1);
    expect(curveAt(31, curve)).toBe(0.35);
    expect(curveAt(100, curve)).toBe(0.35);
  });

  test("steigt im Run-up monoton", () => {
    let last = -1;
    for (let t = -21; t <= 3; t += 0.5) {
      const v = curveAt(t, curve);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });
});

describe("computeDemand", () => {
  const demand = computeDemand(testKnowledge, "raids");

  test("Tag-Regel trifft alle Raid-Consumables direkt", () => {
    for (const id of [10, 11, 12]) expect(demand.get(id)?.impact).toBeCloseTo(0.6);
  });

  test("Reagenz erbt Nachfrage über das Rezept, gedämpft", () => {
    const pest = demand.get(4)!;
    expect(pest.impact).toBeCloseTo(0.6 * DEFAULT_PASS_THROUGH);
    expect(pest.confidence).toBeCloseTo(0.6 * UNVERIFIED_RECIPE_FACTOR);
    expect(pest.drivers[0]!.path).toEqual([12, 4]);
  });

  test("mehrere Abnehmer summieren sich mit abnehmendem Gewicht", () => {
    // Lotus steckt in Flask A und Flask B
    const lotus = demand.get(1)!;
    const single = 0.6 * DEFAULT_PASS_THROUGH;
    expect(lotus.drivers).toHaveLength(2);
    expect(lotus.impact).toBeCloseTo(single * 1.5);
  });

  test("geprüfte Rezepte senken die Sicherheit nicht", () => {
    const lotus = demand.get(1)!;
    const viaVerified = lotus.drivers.find((d) => d.path[0] === 11)!;
    expect(viaVerified.confidence).toBeCloseTo(0.6);
  });

  test("Items ohne Bezug zum Event tauchen nicht auf", () => {
    expect(computeDemand(testKnowledge, "gibts-nicht").size).toBe(0);
  });

  test("Zyklen im Rezeptgraph hängen nicht", () => {
    const k = {
      ...testKnowledge,
      recipes: [
        ...testKnowledge.recipes,
        { id: "x", output: 4, profession: "alchemy", reagents: [[12, 1]] as Array<[number, number]> },
      ],
    };
    expect(() => computeDemand(k, "raids")).not.toThrow();
  });

  test("combine ist leer 0", () => {
    expect(combine([])).toEqual({ impact: 0, confidence: 0 });
  });
});

describe("predict", () => {
  const find = (now: number, itemId: number, prices = noPrices) =>
    predict(testKnowledge, prices, opts(now)).find((p) => p.itemId === itemId);

  test("Aktion folgt dem Zeitfenster um das Event", () => {
    expect(find(EVENT_MS - 25 * DAY, 4)?.action).toBe("buy");
    expect(find(EVENT_MS - 2 * DAY, 4)?.action).toBe("hold");
    expect(find(EVENT_MS + 2 * DAY, 4)?.action).toBe("sell");
    expect(find(EVENT_MS + 15 * DAY, 4)?.action).toBe("avoid");
    expect(find(EVENT_MS + 40 * DAY, 4)).toBeUndefined();
  });

  test("ohne Preisdaten: Upside rein aus der Kurve, keine Goldwerte", () => {
    const p = find(EVENT_MS - 25 * DAY, 4)!;
    expect(p.priceBasis).toBe("none");
    expect(p.currentPrice).toBeNull();
    expect(p.netUpside).toBeCloseTo((1 + 0.48) * 0.95 - 1);
    expect(p.drivers[0]!.chain).toBe("Raids → Mungo → Pestblüte");
  });

  test("mit Preis-Historie: Normalpreis vor dem Run-up, Peak-Preis daraus", () => {
    const runUpStart = EVENT_MS - 21 * DAY;
    const prices = fakePrices([
      ...[1, 2, 3, 4, 5].map((d): [number, number, number] => [4, runUpStart - d * DAY, 10_000]),
      [4, EVENT_MS - 10 * DAY - 3600_000, 11_000],
    ]);
    const p = find(EVENT_MS - 10 * DAY, 4, prices)!;
    expect(p.priceBasis).toBe("history");
    expect(p.baselinePrice).toBe(10_000);
    expect(p.expectedPeakPrice).toBe(14_800);
    expect(p.currentPrice).toBe(11_000);
    expect(p.action).toBe("buy");
  });

  test("wenn Spekulanten den Preis schon hochgetrieben haben: beobachten statt kaufen", () => {
    const runUpStart = EVENT_MS - 21 * DAY;
    const prices = fakePrices([
      ...[1, 2, 3].map((d): [number, number, number] => [4, runUpStart - d * DAY, 10_000]),
      [4, EVENT_MS - 10 * DAY - 3600_000, 16_000],
    ]);
    const p = find(EVENT_MS - 10 * DAY, 4, prices)!;
    expect(p.netUpside).toBeLessThan(0);
    expect(p.action).toBe("watch");
  });

  test("zu wenig Sicherheit: beobachten", () => {
    const low = { ...opts(EVENT_MS - 25 * DAY), minConfidence: 0.9 };
    const p = predict(testKnowledge, noPrices, low).find((x) => x.itemId === 4)!;
    expect(p.action).toBe("watch");
  });

  test("sortiert nach Aktion, dann nach Upside", () => {
    const order = predict(testKnowledge, noPrices, opts(EVENT_MS - 25 * DAY)).map((p) => p.action);
    expect(order.every((a) => a === "buy")).toBe(true);
    const ups = predict(testKnowledge, noPrices, opts(EVENT_MS - 25 * DAY)).map((p) => p.netUpside);
    expect([...ups].sort((a, b) => b - a)).toEqual(ups);
  });
});
