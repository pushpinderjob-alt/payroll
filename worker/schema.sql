CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'employee',  -- 'admin' | 'employee'
  salary        REAL    NOT NULL DEFAULT 0,
  password_hash TEXT    NOT NULL,
  salt          TEXT    NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  work_date  TEXT    NOT NULL,            -- local 'YYYY-MM-DD'
  clock_in   TEXT,                        -- local 'HH:MM' or NULL
  clock_out  TEXT,                        -- local 'HH:MM' or NULL
  status     TEXT    NOT NULL DEFAULT 'present', -- 'present' | 'leave' | 'absent'
  note       TEXT,
  created_at TEXT    NOT NULL,
  UNIQUE (user_id, work_date)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('work_days_per_week', '6');
INSERT OR IGNORE INTO settings (key, value) VALUES ('currency', '₹');

CREATE INDEX IF NOT EXISTS idx_attendance_user_date ON attendance (user_id, work_date);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance (work_date);
