export type ItemId = number;

export interface Item {
  id: ItemId;
  /** Anzeigename (deutsch) */
  name: string;
  nameEn?: string;
  /** Regeln können statt einzelner Items einen Tag treffen, z. B. "raid-consumable" */
  tags?: string[];
}

export interface Recipe {
  id: string;
  output: ItemId;
  /** [itemId, Menge pro Craft]. Vendor-Reagenzien weglassen, die sind für Prognosen egal. */
  reagents: Array<[ItemId, number]>;
  profession: string;
  /** true, sobald das Rezept in Forever geprüft ist. Ungeprüfte Rezepte senken die Sicherheit. */
  verified?: boolean;
  /** Wie stark Nachfrage nach dem Produkt auf die Reagenzien durchschlägt (0..1, Default 0.8) */
  passThrough?: number;
}

export type EventKind = "raid-release" | "phase" | "patch" | "other";

/** Preisverlauf um ein Event herum, alles in Tagen relativ zum Event-Tag. */
export interface Curve {
  /** So viele Tage vorher fangen die Preise an zu steigen */
  runUpDays: number;
  /** Peak relativ zum Event-Tag (3 = erste Raid-Woche) */
  peakOffsetDays: number;
  /** Tage vom Peak zurück aufs neue Normalniveau */
  decayDays: number;
  /** Anteil des Aufschlags, der dauerhaft bleibt (0..1) */
  residual: number;
}

export interface GameEvent {
  id: string;
  name: string;
  /** YYYY-MM-DD, UTC */
  date: string;
  kind: EventKind;
  curve?: Partial<Curve>;
  notes?: string;
  source?: string;
}

export type RuleTarget = { item: ItemId } | { tag: string };

export interface DemandRule {
  id: string;
  event: string;
  target: RuleTarget;
  /** Erwarteter Preisaufschlag zum Peak: 0.5 = +50 % */
  impact: number;
  /** Wie sicher wir uns sind, 0..1 */
  confidence: number;
  /** Klartext-Begründung, landet im Tooltip und in Discord */
  reason: string;
}

export interface Knowledge {
  items: Item[];
  recipes: Recipe[];
  events: GameEvent[];
  rules: DemandRule[];
}
