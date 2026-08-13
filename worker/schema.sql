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
  task       TEXT    NOT NULL DEFAULT '', -- employee's note of the day's work
  created_at TEXT    NOT NULL,
  UNIQUE (user_id, work_date)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS corrections (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER NOT NULL,
  work_date           TEXT    NOT NULL,              -- local 'YYYY-MM-DD'
  reason              TEXT    NOT NULL,              -- 'forgot_clock_out' | 'clocked_out_early' | 'forgot_clock_in' | 'wrong_time' | 'other'
  note                TEXT,
  current_clock_in    TEXT,
  current_clock_out   TEXT,
  requested_clock_in  TEXT,
  requested_clock_out TEXT,
  status              TEXT    NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  admin_note          TEXT,
  request_group       TEXT,                          -- shared id for dates submitted in one batch
  created_at          TEXT    NOT NULL,
  decided_at          TEXT,
  decided_by          INTEGER
);

CREATE TABLE IF NOT EXISTS leaves (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  start_date  TEXT    NOT NULL,              -- local 'YYYY-MM-DD'
  end_date    TEXT    NOT NULL,              -- inclusive local 'YYYY-MM-DD'
  days        INTEGER NOT NULL DEFAULT 1,    -- number of days covered
  leave_type  TEXT    NOT NULL DEFAULT 'casual', -- 'casual' | 'sick' | 'pl' | 'lwp' | 'other'
  note        TEXT,
  status      TEXT    NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  admin_note  TEXT,
  created_at  TEXT    NOT NULL,
  decided_at  TEXT,
  decided_by  INTEGER
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('work_days_per_week', '6');
INSERT OR IGNORE INTO settings (key, value) VALUES ('currency', '₹');

CREATE INDEX IF NOT EXISTS idx_attendance_user_date ON attendance (user_id, work_date);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance (work_date);
CREATE INDEX IF NOT EXISTS idx_corrections_user ON corrections (user_id, status);
CREATE INDEX IF NOT EXISTS idx_corrections_status ON corrections (status);
CREATE INDEX IF NOT EXISTS idx_leaves_user ON leaves (user_id, status);
CREATE INDEX IF NOT EXISTS idx_leaves_status ON leaves (status);
