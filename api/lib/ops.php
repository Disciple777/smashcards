<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/response.php';

/**
 * Shared gate for the ops endpoints (migrate, selftest).
 *
 * These endpoints exist because the host has no SSH: they are the only way to
 * run schema changes and inspect the database remotely. That makes them the
 * most sensitive URLs on the server, so the gate fails closed.
 */
final class Ops
{
    /**
     * @param string $configPath e.g. 'ops.migrate_key'
     *
     * An unconfigured key must never mean "allow". Falling open here would
     * expose a schema-altering endpoint to the internet the moment somebody
     * forgot a config line.
     */
    public static function requireKey(string $configPath): void
    {
        $expected = (string) Config::get($configPath, '');

        if ($expected === '' || str_starts_with($expected, 'CHANGE_ME')) {
            Response::error(
                'ops_key_not_configured',
                'This endpoint is disabled until its key is set in api/config.php.',
                503
            );
        }

        // Header preferred; the query fallback exists only for quick manual
        // checks and is why these URLs must never be logged with query strings.
        $provided = (string) ($_SERVER['HTTP_X_OPS_KEY'] ?? $_GET['key'] ?? '');

        // hash_equals: constant-time, so a wrong key leaks no timing signal.
        if ($provided === '' || !hash_equals($expected, $provided)) {
            Response::error('forbidden', 'Invalid or missing ops key.', 403);
        }
    }
}
