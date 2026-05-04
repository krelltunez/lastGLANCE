export const SCHEMA_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chores (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  name                        TEXT NOT NULL,
  category_id                 INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  target_cadence_days         INTEGER,
  auto_schedule_to_dayglance  INTEGER NOT NULL DEFAULT 0 CHECK(auto_schedule_to_dayglance IN (0,1)),
  preferred_schedule_behavior TEXT CHECK(preferred_schedule_behavior IN ('today','next_weekend','next_free_day')),
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS completion_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chore_id     INTEGER NOT NULL REFERENCES chores(id) ON DELETE CASCADE,
  completed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  note         TEXT,
  source       TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','dayglance'))
);

CREATE INDEX IF NOT EXISTS idx_completion_chore_time
  ON completion_events(chore_id, completed_at DESC);
`

export const SEED_SQL = `
INSERT OR IGNORE INTO categories(id, name, sort_order) VALUES
  (1, 'Home',      0),
  (2, 'Pets',      1),
  (3, 'Vehicle',   2),
  (4, 'Deep clean', 3);

INSERT OR IGNORE INTO chores(id, name, category_id, target_cadence_days) VALUES
  (1, 'Mop kitchen',        1, 14),
  (2, 'Clean bathrooms',    1, 7),
  (3, 'Vacuum',             1, 7),
  (4, 'Take out trash',     1, 3),
  (5, 'Change cat litter',  2, 2),
  (6, 'Feed fish',          2, 1),
  (7, 'Oil change',         3, 90),
  (8, 'Wash car',           3, 30),
  (9, 'Clean oven',         4, 60),
  (10,'Wipe down cabinets', 4, 30);
`
