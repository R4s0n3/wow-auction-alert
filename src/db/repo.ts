import type { Database } from "bun:sqlite";
import type { Assessment, Brief, MarketItem, Source, StoredAssessment } from "../ai/types.ts";
import type { Action, Prediction, PriceProvider, PriceStats } from "../engine/predict.ts";

export interface ScanItem {
  itemId: number;
  /** Kupfer pro Stück */
  minBuyout: number;
  /** Optional: Marktpreis in Kupfer pro Stück, wird bevorzugt verwendet */
  marketPrice?: number;
  quantity: number;
  /** Optional aus dem Addon: Name, Qualität (0 = grau … 5 = legendär), Kategorie */
  name?: string;
  quality?: number;
  category?: string;
}

export interface Alert {
  id: number;
  ts: number;
  realm: string;
  itemId: number;
  eventId: string;
  action: Action;
  previousAction: Action | null;
  prediction: Prediction;
}

interface AlertRow {
  id: number;
  ts: number;
  realm: string;
  item_id: number;
  event_id: string;
  action: Action;
  previous_action: Action | null;
  prediction: string;
}

const toAlert = (r: AlertRow): Alert => ({
  id: r.id,
  ts: r.ts,
  realm: r.realm,
  itemId: r.item_id,
  eventId: r.event_id,
  action: r.action,
  previousAction: r.previous_action,
  prediction: JSON.parse(r.prediction) as Prediction,
});

export class Repo {
  constructor(private readonly db: Database) {}

  insertScan(realm: string, source: string, ts: number, items: ScanItem[]): number {
    const stmt = this.db.query(
      `INSERT OR REPLACE INTO price_snapshots (realm, item_id, ts, min_buyout, market_price, quantity, source)
       VALUES ($realm, $itemId, $ts, $minBuyout, $marketPrice, $quantity, $source)`,
    );
    const info = this.db.query(
      `INSERT INTO items (item_id, name, quality, category, updated_at)
       VALUES ($itemId, $name, $quality, $category, $ts)
       ON CONFLICT (item_id) DO UPDATE SET
         name = COALESCE(excluded.name, name),
         quality = COALESCE(excluded.quality, quality),
         category = COALESCE(excluded.category, category),
         updated_at = excluded.updated_at`,
    );
    this.db.transaction(() => {
      for (const { name, quality, category, ...item } of items) {
        stmt.run({ realm, source, ts, ...item, marketPrice: item.marketPrice ?? null });
        if (name !== undefined || quality !== undefined || category !== undefined) {
          info.run({ itemId: item.itemId, name: name ?? null, quality: quality ?? null, category: category ?? null, ts });
        }
      }
    })();
    return items.length;
  }

  /** Icon (Wowhead-Name) und Qualität pro Item, soweit bekannt */
  itemMeta(itemIds: number[]): Map<number, { icon: string | null; quality: number | null }> {
    const out = new Map<number, { icon: string | null; quality: number | null }>();
    const stmt = this.db.query(`SELECT icon, quality FROM items WHERE item_id = $itemId`);
    for (const itemId of itemIds) {
      const row = stmt.get({ itemId }) as { icon: string | null; quality: number | null } | null;
      if (row) out.set(itemId, row);
    }
    return out;
  }

  /** Items ohne Icon, die noch nie oder vor `checkedBefore` nachgeschlagen wurden */
  missingIcons(itemIds: number[], checkedBefore: number): number[] {
    const stmt = this.db.query(`SELECT icon, icon_checked_at AS checked FROM items WHERE item_id = $itemId`);
    return itemIds.filter((itemId) => {
      const row = stmt.get({ itemId }) as { icon: string | null; checked: number | null } | null;
      return !row || (!row.icon && (row.checked === null || row.checked < checkedBefore));
    });
  }

  /** Ergebnis der Wowhead-Abfrage. Name und Qualität aus dem Spiel haben Vorrang. */
  setIcon(itemId: number, icon: string | null, quality: number | null, name: string | null, ts: number): void {
    this.db
      .query(
        `INSERT INTO items (item_id, name, quality, icon, icon_checked_at, updated_at)
         VALUES ($itemId, $name, $quality, $icon, $ts, $ts)
         ON CONFLICT (item_id) DO UPDATE SET
           icon = COALESCE(excluded.icon, icon),
           icon_checked_at = excluded.icon_checked_at,
           name = COALESCE(name, excluded.name),
           quality = COALESCE(quality, excluded.quality)`,
      )
      .run({ itemId, name, quality, icon, ts });
  }

  itemNames(itemIds: number[]): Map<number, string> {
    const out = new Map<number, string>();
    const stmt = this.db.query(`SELECT name FROM items WHERE item_id = $itemId AND name IS NOT NULL`);
    for (const itemId of itemIds) {
      const row = stmt.get({ itemId }) as { name: string } | null;
      if (row) out.set(itemId, row.name);
    }
    return out;
  }

  /** Alle Items aus dem neuesten Scan eines Realms (bis `now`), mit Preis-Kontext für die KI. */
  marketItems(realm: string, now: number): MarketItem[] {
    const latest = this.db
      .query(`SELECT MAX(ts) AS ts FROM price_snapshots WHERE realm = $realm AND ts <= $now`)
      .get({ realm, now }) as { ts: number | null };
    if (latest.ts === null) return [];
    const rows = this.db
      .query(
        `SELECT s.item_id AS itemId, MAX(s.quantity) AS quantity, i.name, i.quality, i.category
         FROM price_snapshots s LEFT JOIN items i ON i.item_id = s.item_id
         WHERE s.realm = $realm AND s.ts = $ts
         GROUP BY s.item_id`,
      )
      .all({ realm, ts: latest.ts }) as Array<{
      itemId: number;
      quantity: number;
      name: string | null;
      quality: number | null;
      category: string | null;
    }>;
    const DAY = 86_400_000;
    const items: MarketItem[] = [];
    for (const r of rows) {
      // Bezugspunkt ist der neueste Scan, nicht "jetzt": auch ein paar Tage alte Scans sind brauchbar
      const current = this.priceStats(realm, r.itemId, latest.ts - 2 * DAY, latest.ts);
      if (!current) continue;
      const before = this.priceStats(realm, r.itemId, latest.ts - 9 * DAY, latest.ts - 2 * DAY - 1);
      items.push({ ...r, price: Math.round(current.median), priceWeekBefore: before ? Math.round(before.median) : null });
    }
    return items;
  }

  saveBrief(createdAt: number, model: string, content: string, sources: Source[]): Brief {
    const row = this.db
      .query(
        `INSERT INTO ai_briefs (created_at, model, content, sources) VALUES ($createdAt, $model, $content, $sources)
         RETURNING id`,
      )
      .get({ createdAt, model, content, sources: JSON.stringify(sources) }) as { id: number };
    return { id: row.id, createdAt, model, content, sources };
  }

  latestBrief(): Brief | null {
    const row = this.db.query(`SELECT * FROM ai_briefs ORDER BY id DESC LIMIT 1`).get() as {
      id: number;
      created_at: number;
      model: string;
      content: string;
      sources: string;
    } | null;
    if (!row) return null;
    return { id: row.id, createdAt: row.created_at, model: row.model, content: row.content, sources: JSON.parse(row.sources) };
  }

  saveAssessments(realm: string, briefId: number, createdAt: number, list: Array<Assessment & { priceAt: number | null }>): void {
    const stmt = this.db.query(
      `INSERT OR REPLACE INTO ai_assessments
         (realm, item_id, brief_id, created_at, direction, change_pct, confidence, buy_by, sell_from, sell_by, driver, reason, price_at)
       VALUES ($realm, $itemId, $briefId, $createdAt, $direction, $changePct, $confidence, $buyBy, $sellFrom, $sellBy, $driver, $reason, $priceAt)`,
    );
    this.db.transaction(() => {
      for (const a of list) stmt.run({ realm, briefId, createdAt, ...a });
    })();
  }

  assessments(realm: string, sinceMs = 0): StoredAssessment[] {
    const rows = this.db
      .query(`SELECT * FROM ai_assessments WHERE realm = $realm AND created_at >= $sinceMs ORDER BY item_id`)
      .all({ realm, sinceMs }) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      realm: r.realm as string,
      itemId: r.item_id as number,
      briefId: r.brief_id as number,
      createdAt: r.created_at as number,
      direction: r.direction as StoredAssessment["direction"],
      changePct: r.change_pct as number,
      confidence: r.confidence as number,
      buyBy: r.buy_by as string | null,
      sellFrom: r.sell_from as string | null,
      sellBy: r.sell_by as string | null,
      driver: r.driver as string,
      reason: r.reason as string,
      priceAt: r.price_at as number | null,
    }));
  }

  priceStats(realm: string, itemId: number, fromMs: number, toMs: number): PriceStats | null {
    const rows = this.db
      .query(
        `SELECT COALESCE(market_price, min_buyout) AS p FROM price_snapshots
         WHERE realm = $realm AND item_id = $itemId AND ts >= $fromMs AND ts <= $toMs
         ORDER BY p`,
      )
      .all({ realm, itemId, fromMs, toMs }) as Array<{ p: number }>;
    if (rows.length === 0) return null;
    const mid = Math.floor(rows.length / 2);
    const median = rows.length % 2 === 1 ? rows[mid]!.p : (rows[mid - 1]!.p + rows[mid]!.p) / 2;
    return { median, count: rows.length };
  }

  priceProvider(realm: string): PriceProvider {
    return { stats: (itemId, fromMs, toMs) => this.priceStats(realm, itemId, fromMs, toMs) };
  }

  /** Realms, für die seit `sinceMs` Scans reingekommen sind */
  /** Pro Realm: letzter Scan, Items darin, KI-Bewertungen. Neueste zuerst. */
  overview(): Array<{ realm: string; lastScan: number; items: number; assessed: number }> {
    return this.db
      .query(
        `SELECT s.realm, s.last AS lastScan,
           (SELECT COUNT(*) FROM price_snapshots p WHERE p.realm = s.realm AND p.ts = s.last) AS items,
           (SELECT COUNT(*) FROM ai_assessments a WHERE a.realm = s.realm) AS assessed
         FROM (SELECT realm, MAX(ts) AS last FROM price_snapshots GROUP BY realm) s
         ORDER BY s.last DESC`,
      )
      .all() as Array<{ realm: string; lastScan: number; items: number; assessed: number }>;
  }

  realms(sinceMs: number): string[] {
    const rows = this.db
      .query(`SELECT DISTINCT realm FROM price_snapshots WHERE ts >= $sinceMs`)
      .all({ sinceMs }) as Array<{ realm: string }>;
    return rows.map((r) => r.realm);
  }

  getAction(realm: string, itemId: number, eventId: string): Action | null {
    const row = this.db
      .query(`SELECT action FROM prediction_state WHERE realm = $realm AND item_id = $itemId AND event_id = $eventId`)
      .get({ realm, itemId, eventId }) as { action: Action } | null;
    return row?.action ?? null;
  }

  setAction(realm: string, itemId: number, eventId: string, action: Action, ts: number): void {
    this.db
      .query(
        `INSERT INTO prediction_state (realm, item_id, event_id, action, updated_at)
         VALUES ($realm, $itemId, $eventId, $action, $ts)
         ON CONFLICT (realm, item_id, event_id) DO UPDATE SET action = excluded.action, updated_at = excluded.updated_at`,
      )
      .run({ realm, itemId, eventId, action, ts });
  }

  insertAlert(ts: number, prediction: Prediction, previousAction: Action | null): Alert {
    const row = this.db
      .query(
        `INSERT INTO alerts (ts, realm, item_id, event_id, action, previous_action, prediction)
         VALUES ($ts, $realm, $itemId, $eventId, $action, $previousAction, $prediction)
         RETURNING *`,
      )
      .get({
        ts,
        realm: prediction.realm,
        itemId: prediction.itemId,
        eventId: prediction.eventId,
        action: prediction.action,
        previousAction,
        prediction: JSON.stringify(prediction),
      }) as AlertRow;
    return toAlert(row);
  }

  recentAlerts(realm: string, limit: number): Alert[] {
    const rows = this.db
      .query(`SELECT * FROM alerts WHERE realm = $realm ORDER BY id DESC LIMIT $limit`)
      .all({ realm, limit }) as AlertRow[];
    return rows.map(toAlert);
  }

  logPredictions(runAt: number, predictions: Prediction[]): void {
    const stmt = this.db.query(
      `INSERT OR REPLACE INTO prediction_log
         (run_at, realm, item_id, event_id, action, impact, confidence, current_price, expected_peak)
       VALUES ($runAt, $realm, $itemId, $eventId, $action, $impact, $confidence, $currentPrice, $expectedPeak)`,
    );
    this.db.transaction(() => {
      for (const p of predictions) {
        stmt.run({
          runAt,
          realm: p.realm,
          itemId: p.itemId,
          eventId: p.eventId,
          action: p.action,
          impact: p.impact,
          confidence: p.confidence,
          currentPrice: p.currentPrice,
          expectedPeak: p.expectedPeakPrice,
        });
      }
    })();
  }

  getMeta(key: string): string | null {
    const row = this.db.query(`SELECT value FROM meta WHERE key = $key`).get({ key }) as { value: string } | null;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.query(`INSERT INTO meta (key, value) VALUES ($key, $value) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run({ key, value });
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
