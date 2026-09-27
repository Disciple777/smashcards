-- Deck folders, with subfolders via a self-referencing parent_id.
--
-- Deleting a folder cascades to its subfolders (they exist only inside it),
-- but decks inside are never destroyed — decks.folder_id is ON DELETE SET
-- NULL, so a deck simply moves to the root ("no folder") view. Losing the
-- folder you organized things into should never mean losing the things.
--
-- Written the portable way, like 003: no "ADD COLUMN IF NOT EXISTS" or "ADD
-- CONSTRAINT IF NOT EXISTS" (MariaDB-only, a syntax error on MySQL 8) — every
-- change is guarded by an information_schema check instead.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS folders (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  parent_id  BIGINT UNSIGNED DEFAULT NULL,
  name       VARCHAR(100)    NOT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_folders_user_parent (user_id, parent_id),
  CONSTRAINT fk_folders_user   FOREIGN KEY (user_id)   REFERENCES users (id)   ON DELETE CASCADE,
  CONSTRAINT fk_folders_parent FOREIGN KEY (parent_id) REFERENCES folders (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- decks.folder_id -----------------------------------------------------------

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'decks' AND column_name = 'folder_id'
);
SET @stmt := IF(@col_exists = 0,
  'ALTER TABLE decks ADD COLUMN folder_id BIGINT UNSIGNED DEFAULT NULL AFTER user_id',
  'SELECT 1'
);
PREPARE s1 FROM @stmt; EXECUTE s1; DEALLOCATE PREPARE s1;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'decks' AND index_name = 'idx_decks_folder'
);
SET @stmt := IF(@idx_exists = 0,
  'ALTER TABLE decks ADD KEY idx_decks_folder (folder_id)',
  'SELECT 1'
);
PREPARE s2 FROM @stmt; EXECUTE s2; DEALLOCATE PREPARE s2;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.table_constraints
   WHERE table_schema = DATABASE() AND table_name = 'decks' AND constraint_name = 'fk_decks_folder'
);
SET @stmt := IF(@fk_exists = 0,
  'ALTER TABLE decks ADD CONSTRAINT fk_decks_folder FOREIGN KEY (folder_id) REFERENCES folders (id) ON DELETE SET NULL',
  'SELECT 1'
);
PREPARE s3 FROM @stmt; EXECUTE s3; DEALLOCATE PREPARE s3;
