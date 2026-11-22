-- Eventious database schema
-- The server runs this automatically on startup (CREATE ... IF NOT EXISTS),
-- but you can also import it yourself in phpMyAdmin.

CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(100)  NOT NULL,
  email         VARCHAR(190)  NOT NULL UNIQUE,
  password_hash VARCHAR(255)  NOT NULL,
  role          ENUM('admin','client') NOT NULL DEFAULT 'client',
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS events (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED  NOT NULL,
  name        VARCHAR(200)  NOT NULL,
  event_date  DATE          NOT NULL,
  event_time  TIME          NULL,
  venue       VARCHAR(200)  NULL,
  client      VARCHAR(200)  NULL,
  category    VARCHAR(50)   NOT NULL DEFAULT 'Other',
  remind_days TINYINT UNSIGNED NOT NULL DEFAULT 3,
  notes       TEXT          NULL,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_events_user_date (user_id, event_date),
  CONSTRAINT fk_events_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS event_needs (
  id       INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  event_id INT UNSIGNED  NOT NULL,
  name     VARCHAR(100)  NOT NULL,
  qty      INT UNSIGNED  NOT NULL DEFAULT 1,
  ready    TINYINT(1)    NOT NULL DEFAULT 0,
  position SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  INDEX idx_needs_event (event_id),
  CONSTRAINT fk_needs_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
