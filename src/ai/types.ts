import * as z from "zod/v4";

export type Direction = "up" | "down" | "flat";

/**
 * Antwortformat der Bewertung, so wie Claude es liefern muss (Structured Outputs).
 * Keine min/max-Constraints: die API unterstützt sie nicht, Zahlen werden in
 * `sanitizeAssessment` geprüft und begrenzt.
 */
export const AssessmentSchema = z.object({
  itemId: z.number().int(),
  direction: z.enum(["up", "down", "flat"]),
  /** Erwartete Änderung zum Peak (up) bzw. Tief (down) in Prozent, relativ zum aktuellen Preis */
  changePct: z.number(),
  /** 0..1 */
  confidence: z.number(),
  /** YYYY-MM-DD oder null */
  buyBy: z.string().nullable(),
  sellFrom: z.string().nullable(),
  sellBy: z.string().nullable(),
  /** Kurz, z. B. "Onyxia 9.12. → Feuerschutz" */
  driver: z.string(),
  /** Ein bis zwei Sätze Begründung */
  reason: z.string(),
});

export const AssessmentBatchSchema = z.object({ assessments: z.array(AssessmentSchema) });

export type Assessment = z.infer<typeof AssessmentSchema>;

export interface StoredAssessment extends Assessment {
  realm: string;
  briefId: number;
  createdAt: number;
  /** Marktpreis bei der Bewertung (Kupfer), darauf bezieht sich changePct */
  priceAt: number | null;
}

export interface Source {
  url: string;
  title: string;
}

export interface Brief {
  id: number;
  createdAt: number;
  model: string;
  content: string;
  sources: Source[];
}

/** Ein Item, wie es der KI zur Bewertung vorgelegt wird */
export interface MarketItem {
  itemId: number;
  name: string | null;
  quality: number | null;
  category: string | null;
  /** Median der letzten 48 h, Kupfer */
  price: number;
  /** Median der 7 Tage davor, Kupfer */
  priceWeekBefore: number | null;
  quantity: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(s: string | null): string | null {
  if (s === null || !ISO_DATE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s) ? s : null;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Begrenzt Zahlen, verwirft kaputte Daten und kürzt Texte. Das Schema garantiert nur die Form. */
export function sanitizeAssessment(a: Assessment): Assessment {
  // Die Richtung ist die eigentliche Entscheidung, das Vorzeichen der Zahl ein häufiger
  // Flüchtigkeitsfehler ("down" mit 70 statt -70). Also zählt die Richtung, die Zahl folgt ihr.
  const size = Number.isFinite(a.changePct) ? Math.abs(a.changePct) : 0;
  const changePct = a.direction === "up" ? clamp(size, 0, 500) : a.direction === "down" ? -clamp(size, 0, 95) : 0;
  return {
    itemId: a.itemId,
    direction: changePct === 0 ? "flat" : a.direction,
    changePct: Number(changePct.toFixed(1)),
    confidence: Number.isFinite(a.confidence) ? Number(clamp(a.confidence, 0, 1).toFixed(2)) : 0,
    buyBy: validDate(a.buyBy),
    sellFrom: validDate(a.sellFrom),
    sellBy: validDate(a.sellBy),
    driver: cut(a.driver.trim(), 80),
    reason: cut(a.reason.trim(), 300),
  };
}
