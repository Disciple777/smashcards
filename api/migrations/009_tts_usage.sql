-- Cloud text-to-speech accounting.
--
-- Browser speech only works for languages the *device* has a voice installed
-- for, which is far fewer than people expect: a Windows machine typically
-- ships voices for its display language and nothing else. A deck in any other
-- language then either goes silent or gets read by whatever default voice
-- exists, in the wrong accent. Cloud speech removes the device from the
-- equation entirely.
--
-- Counted separately from card generation: the two are billed per character by
-- different models and mixing them into one number would make both meaningless.
-- Synthesised audio is cached, so this only ever counts characters that
-- actually cost something — a card re-read for the hundredth time is free.

SET NAMES utf8mb4;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'ai_usage' AND column_name = 'tts_characters'
);
SET @stmt := IF(@col_exists = 0,
  'ALTER TABLE ai_usage ADD COLUMN tts_characters INT UNSIGNED NOT NULL DEFAULT 0 AFTER characters_used',
  'SELECT 1'
);
PREPARE s1 FROM @stmt; EXECUTE s1; DEALLOCATE PREPARE s1;
