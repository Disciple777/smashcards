<?php
declare(strict_types=1);

/**
 * Applies pending SQL migrations, over HTTPS.
 *
 * There is no SSH on this host, so this endpoint is the only way to run schema
 * changes without opening phpMyAdmin by hand. It is idempotent: each applied
 * file is recorded in schema_migrations and skipped on later runs.
 *
 *   POST /api/ops/migrate.php   with header  X-Ops-Key: <MIGRATE_KEY>
 */

require_once __DIR__ . '/../lib/config.php';
require_once __DIR__ . '/../lib/db.php';
require_once __DIR__ . '/../lib/response.php';
require_once __DIR__ . '/../lib/ops.php';

ini_set('display_errors', '0');

set_exception_handler(function (Throwable $e): void {
    error_log('[smashcards migrate] ' . $e->getMessage());
    Response::error('migration_failed', Config::isProduction() ? 'Migration failed.' : $e->getMessage(), 500);
});

Response::cors();
Ops::requireKey('ops.migrate_key');

$dir = __DIR__ . '/../migrations';
if (!is_dir($dir)) {
    Response::error('no_migrations', 'The migrations directory is missing on the server.', 500);
}

Db::run(
    'CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   VARCHAR(255) NOT NULL,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (filename)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
);

$applied = array_column(Db::all('SELECT filename FROM schema_migrations'), 'filename');

// Filename order is the migration order, which is why they are numbered.
$files = glob($dir . '/*.sql') ?: [];
sort($files, SORT_STRING);

$ran     = [];
$skipped = [];

foreach ($files as $path) {
    $name = basename($path);

    if (in_array($name, $applied, true)) {
        $skipped[] = $name;
        continue;
    }

    $sql = file_get_contents($path);
    if ($sql === false) {
        Response::error('unreadable_migration', "Could not read {$name}.", 500);
    }

    $pdo = Db::conn();
    // MySQL DDL does not roll back, so a failure mid-file leaves partial state.
    // Every migration is therefore written to be re-runnable (IF NOT EXISTS).
    foreach (splitStatements($sql) as $statement) {
        try {
            $pdo->exec($statement);
        } catch (PDOException $e) {
            error_log("[smashcards migrate] {$name}: " . $e->getMessage());
            Response::json([
                'error' => [
                    'code'    => 'migration_failed',
                    'message' => "Migration {$name} failed.",
                    'detail'  => Config::isProduction() ? null : $e->getMessage(),
                ],
                'ran'     => $ran,
                'skipped' => $skipped,
            ], 500);
        }
    }

    Db::run('INSERT INTO schema_migrations (filename) VALUES (?)', [$name]);
    $ran[] = $name;
}

Response::json([
    'ok'      => true,
    'ran'     => $ran,
    'skipped' => $skipped,
    'total'   => count($files),
]);

// ---------------------------------------------------------------- helpers --

/**
 * Splits a SQL file into statements.
 *
 * Naively exploding on ';' breaks whenever a semicolon appears inside a string
 * or a comment, so this walks the text tracking quote and comment state.
 *
 * @return array<int,string>
 */
function splitStatements(string $sql): array
{
    $statements = [];
    $current    = '';
    $length     = strlen($sql);
    $inSingle   = false;
    $inDouble   = false;
    $inBacktick = false;
    $inLineComment  = false;
    $inBlockComment = false;

    for ($i = 0; $i < $length; $i++) {
        $char = $sql[$i];
        $next = $i + 1 < $length ? $sql[$i + 1] : '';

        if ($inLineComment) {
            if ($char === "\n") $inLineComment = false;
            $current .= $char;
            continue;
        }
        if ($inBlockComment) {
            if ($char === '*' && $next === '/') { $inBlockComment = false; $current .= '*/'; $i++; continue; }
            $current .= $char;
            continue;
        }

        if (!$inSingle && !$inDouble && !$inBacktick) {
            if ($char === '-' && $next === '-') { $inLineComment = true; $current .= '--'; $i++; continue; }
            if ($char === '#') { $inLineComment = true; $current .= $char; continue; }
            if ($char === '/' && $next === '*') { $inBlockComment = true; $current .= '/*'; $i++; continue; }

            if ($char === ';') {
                if (trim($current) !== '') $statements[] = trim($current);
                $current = '';
                continue;
            }
        }

        // Quote toggling, honouring backslash escapes inside strings.
        if ($char === "'" && !$inDouble && !$inBacktick) {
            if ($inSingle && $sql[$i - 1] === '\\') { $current .= $char; continue; }
            $inSingle = !$inSingle;
        } elseif ($char === '"' && !$inSingle && !$inBacktick) {
            if ($inDouble && $sql[$i - 1] === '\\') { $current .= $char; continue; }
            $inDouble = !$inDouble;
        } elseif ($char === '`' && !$inSingle && !$inDouble) {
            $inBacktick = !$inBacktick;
        }

        $current .= $char;
    }

    if (trim($current) !== '') {
        $statements[] = trim($current);
    }

    // A file of only comments produces statements with no executable content.
    return array_values(array_filter($statements, static function (string $s): bool {
        $stripped = trim(preg_replace('/^\s*(--[^\n]*|#[^\n]*)$/m', '', $s) ?? '');
        return $stripped !== '';
    }));
}
