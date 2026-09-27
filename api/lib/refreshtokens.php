<?php
declare(strict_types=1);

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/config.php';

/**
 * Refresh-token rotation, with reuse detection.
 *
 * The rule: a refresh token may be exchanged exactly once. Each exchange marks
 * the old token used and issues a new one in the same *family* — one family per
 * login, followed through every rotation.
 *
 * That single rule is what makes theft detectable. A stolen token is a copy,
 * and a copy means the token eventually gets exchanged twice: once by the
 * thief and once by the real client, in whichever order. The second exchange
 * finds a row already marked used, which cannot happen in honest operation, so
 * the whole family is revoked and both parties are logged out. The user has to
 * sign in again — the correct outcome, because by then their session really has
 * been compromised.
 *
 * Access tokens stay stateless and keep working until they expire (fifteen
 * minutes), so revocation is not instantaneous. Checking a row on every request
 * to close that window is not worth the database round trip here.
 */
final class RefreshTokens
{
    /**
     * Records a newly issued refresh token.
     *
     * @param string|null $family null starts a new family — a new login.
     */
    public static function record(int $userId, array $claims, ?string $family = null): string
    {
        $family ??= bin2hex(random_bytes(16));

        Db::run(
            'INSERT INTO refresh_tokens (user_id, jti, family, expires_at) VALUES (?, ?, ?, ?)',
            [
                $userId,
                (string) $claims['jti'],
                $family,
                gmdate('Y-m-d H:i:s', (int) $claims['exp']),
            ]
        );

        self::pruneOccasionally();

        return $family;
    }

    /**
     * Consumes a refresh token, returning the family the replacement belongs to.
     *
     * @return array{ok: true, family: string}|array{ok: false, reason: string}
     */
    public static function consume(int $userId, array $claims): array
    {
        $jti = (string) ($claims['jti'] ?? '');
        if ($jti === '') {
            return ['ok' => false, 'reason' => 'malformed'];
        }

        $row = Db::one('SELECT * FROM refresh_tokens WHERE jti = ?', [$jti]);

        if ($row === null) {
            // A valid signature with no row: either a token issued before this
            // table existed, or one whose row was pruned. Adopting it into a
            // fresh family keeps existing sessions alive across the deploy that
            // introduced this, and the window closes on its own as those
            // pre-existing tokens reach their thirty-day expiry.
            return ['ok' => true, 'family' => bin2hex(random_bytes(16))];
        }

        if ((int) $row['user_id'] !== $userId) {
            // The signature says one user, the row says another. Not possible
            // without tampering.
            return ['ok' => false, 'reason' => 'mismatch'];
        }

        if ($row['revoked_at'] !== null) {
            return ['ok' => false, 'reason' => 'revoked'];
        }

        if ($row['used_at'] !== null) {
            // Exchanged twice. One of the two holders is not the real client,
            // and there is no way to tell which — so neither keeps the session.
            self::revokeFamily((string) $row['family']);
            error_log(sprintf(
                '[smashcards] refresh token reuse detected for user %d, family %s — family revoked',
                $userId,
                $row['family']
            ));

            return ['ok' => false, 'reason' => 'reused'];
        }

        Db::run('UPDATE refresh_tokens SET used_at = UTC_TIMESTAMP() WHERE id = ?', [(int) $row['id']]);

        return ['ok' => true, 'family' => (string) $row['family']];
    }

    /** Ends one session. Returns false when the token was not ours to revoke. */
    public static function revokeByJti(string $jti): bool
    {
        $row = Db::one('SELECT family FROM refresh_tokens WHERE jti = ?', [$jti]);
        if ($row === null) {
            return false;
        }

        self::revokeFamily((string) $row['family']);

        return true;
    }

    /** Ends every session for a user — "log out everywhere". */
    public static function revokeAllFor(int $userId): int
    {
        return Db::run(
            'UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP()
              WHERE user_id = ? AND revoked_at IS NULL',
            [$userId]
        );
    }

    public static function revokeFamily(string $family): void
    {
        Db::run(
            'UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP()
              WHERE family = ? AND revoked_at IS NULL',
            [$family]
        );
    }

    /** How many sessions a user currently has open. */
    public static function activeSessionCount(int $userId): int
    {
        $row = Db::one(
            'SELECT COUNT(DISTINCT family) AS n FROM refresh_tokens
              WHERE user_id = ? AND revoked_at IS NULL AND used_at IS NULL
                AND expires_at > UTC_TIMESTAMP()',
            [$userId]
        );

        return (int) ($row['n'] ?? 0);
    }

    /**
     * Drops rows that can no longer authorise anything.
     *
     * There is no cron on this host, so housekeeping rides along with ordinary
     * traffic — roughly one request in fifty, which is frequent enough to keep
     * the table small and rare enough to cost nothing noticeable.
     */
    private static function pruneOccasionally(): void
    {
        if (random_int(1, 50) !== 1) {
            return;
        }

        try {
            // Kept a while past expiry: a reused token is worth detecting and
            // logging even shortly after it would have expired anyway.
            Db::run('DELETE FROM refresh_tokens WHERE expires_at < (UTC_TIMESTAMP() - INTERVAL 7 DAY)');
        } catch (Throwable $e) {
            error_log('[smashcards] refresh token prune failed: ' . $e->getMessage());
        }
    }
}
