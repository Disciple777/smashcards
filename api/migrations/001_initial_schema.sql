-- Flashcard Study App — schema
-- Target: MySQL 8.0 / MariaDB 10.4+ (Hostinger shared hosting)
-- Charset utf8mb4 throughout: decks are multilingual by design.

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email          VARCHAR(255)    NOT NULL,
  password_hash  VARCHAR(255)    NOT NULL,
  display_name   VARCHAR(100)    NOT NULL,
  settings_json  JSON            DEFAULT NULL,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- decks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decks (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        BIGINT UNSIGNED NOT NULL,
  title          VARCHAR(200)    NOT NULL,
  description    TEXT            DEFAULT NULL,
  -- BCP-47 tags ('en-US', 'es-ES'); fed straight to the Web Speech API.
  language_front VARCHAR(16)     NOT NULL DEFAULT 'en-US',
  language_back  VARCHAR(16)     NOT NULL DEFAULT 'en-US',
  is_public      TINYINT(1)      NOT NULL DEFAULT 0,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_decks_user (user_id),
  KEY idx_decks_public (is_public, updated_at),
  CONSTRAINT fk_decks_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- cards
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cards (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  deck_id            BIGINT UNSIGNED NOT NULL,
  question_text      TEXT            NOT NULL,
  answer_text        TEXT            NOT NULL,
  -- Populated in phase 2+ when cloud TTS audio is cached per card.
  question_audio_url VARCHAR(512)    DEFAULT NULL,
  answer_audio_url   VARCHAR(512)    DEFAULT NULL,
  source_type        ENUM('manual','voice','ai') NOT NULL DEFAULT 'manual',
  -- Staging state for phase 3: AI output is never auto-committed to a deck.
  status             ENUM('active','staged') NOT NULL DEFAULT 'active',
  position           INT UNSIGNED    NOT NULL DEFAULT 0,
  created_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cards_deck_position (deck_id, position),
  KEY idx_cards_deck_status (deck_id, status),
  CONSTRAINT fk_cards_deck FOREIGN KEY (deck_id) REFERENCES decks (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- card_states — scheduling belongs to a user, not to a card.
-- One row per (user, card). Public/shared decks work for free because of this.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS card_states (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id          BIGINT UNSIGNED NOT NULL,
  card_id          BIGINT UNSIGNED NOT NULL,
  ease_factor      DECIMAL(4,2)    NOT NULL DEFAULT 2.50,
  interval_days    INT             NOT NULL DEFAULT 0,
  repetitions      INT             NOT NULL DEFAULT 0,
  due_at           DATETIME        DEFAULT NULL,
  last_reviewed_at DATETIME        DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_card_states_user_card (user_id, card_id),
  -- The hot query: "what is due for this user, soonest first".
  KEY idx_card_states_due (user_id, due_at),
  CONSTRAINT fk_card_states_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_card_states_card FOREIGN KEY (card_id) REFERENCES cards (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        BIGINT UNSIGNED NOT NULL,
  deck_id        BIGINT UNSIGNED DEFAULT NULL,
  mode           ENUM('spaced','random') NOT NULL DEFAULT 'spaced',
  started_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at       DATETIME        DEFAULT NULL,
  cards_reviewed INT UNSIGNED    NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_sessions_user_started (user_id, started_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  -- Deleting a deck must not erase the history of having studied it.
  CONSTRAINT fk_sessions_deck FOREIGN KEY (deck_id) REFERENCES decks (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- reviews — immutable log, one row per answer.
-- score is numeric (0.00–1.00) so phase 4 fuzzy evaluation writes to the same
-- column as today's 1–4 self-rating, with no migration and no backfill.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reviews (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  card_id     BIGINT UNSIGNED NOT NULL,
  session_id  BIGINT UNSIGNED DEFAULT NULL,
  score       DECIMAL(3,2)    NOT NULL,
  rating      TINYINT UNSIGNED DEFAULT NULL,  -- raw 1–4 when self-rated
  response_ms INT UNSIGNED    DEFAULT NULL,
  mode        ENUM('spaced','random') NOT NULL DEFAULT 'spaced',
  reviewed_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_reviews_user_time (user_id, reviewed_at),
  KEY idx_reviews_card (card_id),
  KEY idx_reviews_session (session_id),
  CONSTRAINT fk_reviews_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_reviews_card FOREIGN KEY (card_id) REFERENCES cards (id) ON DELETE CASCADE,
  CONSTRAINT fk_reviews_session FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
