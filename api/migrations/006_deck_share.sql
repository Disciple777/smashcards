-- Deck sharing by unguessable link, independent of is_public.
--
-- A deck stays private (not listed under Browse public decks) while its
-- share_token is set: anyone holding the link can view and clone it, but it
-- is not discoverable any other way. NULL means "not currently shared".
--
-- Written the portable way, like 003 and 005: no "ADD COLUMN IF NOT EXISTS"
-- (MariaDB-only, a syntax error on MySQL 8) — every change is guarded by an
-- information_schema check instead.

SET NAMES utf8mb4;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'decks' AND column_name = 'share_token'
);
SET @stmt := IF(@col_exists = 0,
  'ALTER TABLE decks ADD COLUMN share_token CHAR(40) DEFAULT NULL AFTER is_public',
  'SELECT 1'
);
PREPARE s1 FROM @stmt; EXECUTE s1; DEALLOCATE PREPARE s1;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'decks' AND index_name = 'uq_decks_share_token'
);
SET @stmt := IF(@idx_exists = 0,
  'ALTER TABLE decks ADD UNIQUE KEY uq_decks_share_token (share_token)',
  'SELECT 1'
);
PREPARE s2 FROM @stmt; EXECUTE s2; DEALLOCATE PREPARE s2;
