import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Alle Zeitstempel in Millisekunden, alle Preise in Kupfer pro Stück.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS price_snapshots (
  realm      TEXT    NOT NULL,
  item_id    INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  min_buyout INTEGER NOT NULL,
  -- Ø der günstigsten 15 % der Menge (vom Addon berechnet), robuster als min_buyout
  market_price INTEGER,
  quantity   INTEGER NOT NULL DEFAULT 0,
  source     TEXT    NOT NULL,
  PRIMARY KEY (realm, item_id, ts, source)
);

-- Letzte Empfehlung pro Item/Event, damit Alerts nur bei Änderungen rausgehen
CREATE TABLE IF NOT EXISTS prediction_state (
  realm      TEXT    NOT NULL,
  item_id    INTEGER NOT NULL,
  event_id   TEXT    NOT NULL,
  action     TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (realm, item_id, event_id)
);

CREATE TABLE IF NOT EXISTS alerts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  realm           TEXT    NOT NULL,
  item_id         INTEGER NOT NULL,
  event_id        TEXT    NOT NULL,
  action          TEXT    NOT NULL,
  previous_action TEXT,
  prediction      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_realm_ts ON alerts (realm, ts);

-- Jede Prognose wird geloggt, damit wir später nachmessen können, wie gut sie war
CREATE TABLE IF NOT EXISTS prediction_log (
  run_at        INTEGER NOT NULL,
  realm         TEXT    NOT NULL,
  item_id       INTEGER NOT NULL,
  event_id      TEXT    NOT NULL,
  action        TEXT    NOT NULL,
  impact        REAL    NOT NULL,
  confidence    REAL    NOT NULL,
  current_price INTEGER,
  expected_peak INTEGER,
  PRIMARY KEY (run_at, realm, item_id, event_id)
);

-- Name, Qualität und Kategorie aus den Ingame-Scans, damit die KI weiß, was ein Item ist
CREATE TABLE IF NOT EXISTS items (
  item_id    INTEGER PRIMARY KEY,
  name       TEXT,
  quality    INTEGER,
  category   TEXT,
  updated_at INTEGER NOT NULL,
  -- Icon-Name von Wowhead (z. B. inv_misc_herb_plaguebloom), für Discord und Website
  icon            TEXT,
  icon_checked_at INTEGER,
  -- Itemklasse aus dem Client (7 = Handwerkswaren, 2/4 = Waffe/Rüstung …), sprachunabhängig
  class_id        INTEGER,
  subclass_id     INTEGER,
  -- Ersatz, solange die Klasse fehlt: Kategorie aus dem Wowhead-Tooltip
  wh_kind         TEXT,
  wh_checked_at   INTEGER
);

-- Was die Handwerks-Fraktion verlangt: Abgefangene Kisten werden mit Paketen aus
-- Handwerkswaren gefüllt (aus dem Wowhead-Tooltip). Verfügungen stehen im Namen.
CREATE TABLE IF NOT EXISTS faction_needs (
  source_item_id INTEGER NOT NULL,
  need_name      TEXT    NOT NULL,
  count          INTEGER,
  PRIMARY KEY (source_item_id, need_name)
);

-- Lagebericht der KI-Recherche (Websuche), Grundlage für alle Item-Bewertungen
CREATE TABLE IF NOT EXISTS ai_briefs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  model      TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  sources    TEXT    NOT NULL -- JSON: [{ url, title }]
);

-- Kleine Merkzettel, z. B. wann der Wochenrückblick zuletzt in Discord war
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Letzte KI-Bewertung pro Item und Realm
CREATE TABLE IF NOT EXISTS ai_assessments (
  realm      TEXT    NOT NULL,
  item_id    INTEGER NOT NULL,
  brief_id   INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  direction  TEXT    NOT NULL,
  change_pct REAL    NOT NULL,
  confidence REAL    NOT NULL,
  buy_by     TEXT,
  sell_from  TEXT,
  sell_by    TEXT,
  driver     TEXT    NOT NULL,
  reason     TEXT    NOT NULL,
  -- Marktpreis zum Zeitpunkt der Bewertung, darauf bezieht sich change_pct
  price_at   INTEGER,
  PRIMARY KEY (realm, item_id)
);
`;

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  // Spalten, die nach dem ersten Release dazugekommen sind
  const itemColumns = new Set((db.query("PRAGMA table_info(items)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!itemColumns.has("icon")) db.exec("ALTER TABLE items ADD COLUMN icon TEXT");
  if (!itemColumns.has("icon_checked_at")) db.exec("ALTER TABLE items ADD COLUMN icon_checked_at INTEGER");
  const added: Array<[string, string]> = [["class_id", "INTEGER"], ["subclass_id", "INTEGER"], ["wh_kind", "TEXT"], ["wh_checked_at", "INTEGER"]];
  for (const [col, type] of added) {
    if (!itemColumns.has(col)) db.exec(`ALTER TABLE items ADD COLUMN ${col} ${type}`);
  }
  return db;
}
