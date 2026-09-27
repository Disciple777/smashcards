-- Records which provider was billed most recently in a period, so per-provider
-- spend can be compared without a separate table.
--
-- Written the long way on purpose: "ALTER TABLE ... ADD COLUMN IF NOT EXISTS"
-- is MariaDB-only and is a syntax error on MySQL 8. Checking
-- information_schema first works on both, and keeps the migration re-runnable.

SET NAMES utf8mb4;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name   = 'ai_usage'
     AND column_name  = 'last_provider'
);

SET @statement := IF(
  @column_exists = 0,
  'ALTER TABLE ai_usage ADD COLUMN last_provider VARCHAR(32) DEFAULT NULL AFTER output_tokens',
  'SELECT 1'
);

PREPARE apply_column FROM @statement;
EXECUTE apply_column;
DEALLOCATE PREPARE apply_column;
