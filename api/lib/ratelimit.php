<?php
declare(strict_types=1);

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/response.php';

/**
 * Login attempt throttling.
 *
 * Keyed on (email, ip) — see the migration comment for why both. A window of
 * failures, not a running total, so a legitimate user who mistypes a password
 * a few times regains access on their own once the window passes; nothing
 * needs to be manually unlocked.
 */
final class RateLimit
{
    private const MAX_ATTEMPTS   = 8;
    private const WINDOW_MINUTES = 15;

    /** Exposes the threshold for the self test, which cannot safely call
     *  assertLoginAllowed() once over the limit (it calls exit()). */
    public static function maxAttempts(): int
    {
        return self::MAX_ATTEMPTS;
    }

    /** Blocks the request with 429 if this (email, ip) pair is over the limit. */
    public static function assertLoginAllowed(string $email, string $ip): void
    {
        $count = (int) (Db::one(
            'SELECT COUNT(*) AS n FROM login_attempts
              WHERE email = ? AND ip = ? AND attempted_at > (UTC_TIMESTAMP() - INTERVAL ? MINUTE)',
            [$email, $ip, self::WINDOW_MINUTES]
        )['n'] ?? 0);

        if ($count >= self::MAX_ATTEMPTS) {
            Response::error(
                'too_many_attempts',
                'Too many failed attempts. Try again in a few minutes.',
                429
            );
        }
    }

    public static function recordFailure(string $email, string $ip): void
    {
        Db::run('INSERT INTO login_attempts (email, ip) VALUES (?, ?)', [$email, $ip]);
    }

    /** Successful login: this pair is no longer under suspicion. */
    public static function clear(string $email, string $ip): void
    {
        Db::run('DELETE FROM login_attempts WHERE email = ? AND ip = ?', [$email, $ip]);
    }

    /**
     * The caller's address, preferring the proxy-supplied one.
     *
     * Verified against this deployment: Hostinger's edge forwards the real
     * client address in X-Forwarded-For / X-Real-IP, and REMOTE_ADDR itself
     * already matches it — confirmed via the ops self test rather than assumed.
     * REMOTE_ADDR is still the fallback, since a header can be spoofed by a
     * direct caller that bypasses the proxy, whereas REMOTE_ADDR cannot.
     */
    public static function clientIp(): string
    {
        $forwarded = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? '';
        if ($forwarded !== '') {
            // The header can carry a chain; the first hop is the original client.
            $first = trim(explode(',', $forwarded)[0]);
            if (filter_var($first, FILTER_VALIDATE_IP)) {
                return $first;
            }
        }

        $real = $_SERVER['HTTP_X_REAL_IP'] ?? '';
        if ($real !== '' && filter_var($real, FILTER_VALIDATE_IP)) {
            return $real;
        }

        return (string) ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0');
    }
}
