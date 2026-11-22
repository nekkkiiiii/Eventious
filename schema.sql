-- Eventious database schema (PostgreSQL)
-- The server runs this automatically on startup (everything is IF NOT EXISTS),
-- but you can also run it yourself in your database's SQL editor.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(10)  NOT NULL DEFAULT 'client' CHECK (role IN ('admin', 'client')),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        VARCHAR(200) NOT NULL,
  event_date  DATE         NOT NULL,
  event_time  TIME         NULL,
  venue       VARCHAR(200) NULL,
  client      VARCHAR(200) NULL,
  category    VARCHAR(50)  NOT NULL DEFAULT 'Other',
  remind_days SMALLINT     NOT NULL DEFAULT 3,
  notes       TEXT         NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_user_date ON events (user_id, event_date);

CREATE TABLE IF NOT EXISTS event_needs (
  id       SERIAL PRIMARY KEY,
  event_id INTEGER      NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name     VARCHAR(100) NOT NULL,
  qty      INTEGER      NOT NULL DEFAULT 1,
  ready    BOOLEAN      NOT NULL DEFAULT FALSE,
  position SMALLINT     NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_needs_event ON event_needs (event_id);

-- Login sessions (used by connect-pg-simple)
CREATE TABLE IF NOT EXISTS session (
  sid    VARCHAR      NOT NULL PRIMARY KEY,
  sess   JSON         NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_expire ON session (expire);

-- Upgrade older databases and make sure there is always an admin
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(10) NOT NULL DEFAULT 'client';
UPDATE users SET role = 'admin'
WHERE id = (SELECT MIN(id) FROM users)
  AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin');
