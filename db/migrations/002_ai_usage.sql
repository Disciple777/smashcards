-- Phase 3: per-user AI quota accounting.
-- Run once against the smashcards database (phpMyAdmin → Import).

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS ai_usage (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  -- Calendar month in UTC, 'YYYY-MM'. A string rather than a date because the
  -- quota is per whole month and this makes the unique key trivial.
  period          CHAR(7)         NOT NULL,
  characters_used INT UNSIGNED    NOT NULL DEFAULT 0,
  requests        INT UNSIGNED    NOT NULL DEFAULT 0,
  input_tokens    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  output_tokens   BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ai_usage_user_period (user_id, period),
  CONSTRAINT fk_ai_usage_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
