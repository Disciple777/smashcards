-- Study sources — the material cards were generated from, kept for reference.
--
-- Before this, a pasted passage was sent to the AI, turned into cards, and
-- thrown away: there was no way to go back and read what a card came from.
-- Every generation input is now a row here — pasted text, an uploaded document,
-- or an uploaded audio file — with:
--
--   * the original bytes on disk (storage_key), for documents and audio
--   * the text that was actually fed to the model (content_text): the passage
--     itself for text, extracted text for a PDF, the transcript for audio
--
-- so both halves of an audio import (the recording and its transcript) survive
-- together, and a pasted passage is no longer lost the moment cards are made.
--
-- Written the portable way, like 003, 005 and 006: no "ADD COLUMN IF NOT
-- EXISTS" (MariaDB-only, a syntax error on MySQL 8) — the column change is
-- guarded by an information_schema check so the file is re-runnable.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS sources (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        BIGINT UNSIGNED NOT NULL,
  deck_id        BIGINT UNSIGNED NOT NULL,
  -- 'text' has no file; 'document' and 'audio' always do.
  kind           ENUM('text','document','audio') NOT NULL DEFAULT 'text',
  title          VARCHAR(255)    NOT NULL,
  -- As the user named it. Never used to build a path — see storage_key.
  original_name  VARCHAR(255)    DEFAULT NULL,
  mime_type      VARCHAR(127)    DEFAULT NULL,
  byte_size      INT UNSIGNED    NOT NULL DEFAULT 0,
  -- Relative path under the storage root, server-generated and unguessable.
  -- NULL for pasted text, which has no file of its own.
  storage_key    VARCHAR(255)    DEFAULT NULL,
  -- The text fed to the model: the passage, the PDF's text, or the transcript.
  -- MEDIUMTEXT because a transcript of a long lecture outruns TEXT's 64KB.
  content_text   MEDIUMTEXT      DEFAULT NULL,
  -- Which service produced content_text, when it was not supplied directly:
  -- 'pdfjs' (extracted in the browser) or an audio transcription model.
  extracted_by   VARCHAR(48)     DEFAULT NULL,
  duration_seconds INT UNSIGNED  DEFAULT NULL,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sources_deck (deck_id, created_at),
  KEY idx_sources_user (user_id),
  CONSTRAINT fk_sources_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_sources_deck FOREIGN KEY (deck_id) REFERENCES decks (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which source a card came from. ON DELETE SET NULL, not CASCADE: deleting the
-- reference material must never delete cards the user has already been studying.
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'cards' AND column_name = 'source_id'
);
SET @stmt := IF(@col_exists = 0,
  'ALTER TABLE cards ADD COLUMN source_id BIGINT UNSIGNED DEFAULT NULL AFTER source_type',
  'SELECT 1'
);
PREPARE s1 FROM @stmt; EXECUTE s1; DEALLOCATE PREPARE s1;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.table_constraints
   WHERE table_schema = DATABASE() AND table_name = 'cards' AND constraint_name = 'fk_cards_source'
);
SET @stmt := IF(@fk_exists = 0,
  'ALTER TABLE cards ADD CONSTRAINT fk_cards_source FOREIGN KEY (source_id) REFERENCES sources (id) ON DELETE SET NULL',
  'SELECT 1'
);
PREPARE s2 FROM @stmt; EXECUTE s2; DEALLOCATE PREPARE s2;
