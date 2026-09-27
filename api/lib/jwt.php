<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';

/**
 * Minimal HS256 JWT. Hand-rolled deliberately: shared hosting makes Composer
 * awkward, and the signed-token subset we need is small and well-specified.
 *
 * Two token types, distinguished by the 'typ' claim:
 *   access  — short-lived, sent as `Authorization: Bearer <token>`
 *   refresh — long-lived, exchanged at /auth/refresh for a new pair
 *
 * Signature and expiry are all this file judges. Whether a *refresh* token is
 * still live is a separate question, answered by the refresh_tokens table via
 * RefreshTokens — tokens rotate, and an already-exchanged one is treated as
 * evidence of theft. Access tokens remain purely stateless: they expire in
 * fifteen minutes, and a database round trip on every request to shorten that
 * further is not a trade worth making here.
 */
final class Jwt
{
    public static function issueAccess(int $userId): string
    {
        return self::encode($userId, 'access', (int) Config::get('jwt.access_ttl', 900));
    }

    public static function issueRefresh(int $userId): string
    {
        return self::encode($userId, 'refresh', (int) Config::get('jwt.refresh_ttl', 2592000));
    }

    private static function encode(int $userId, string $type, int $ttl): string
    {
        $now = time();
        $payload = [
            'iss' => Config::get('jwt.issuer', 'smashcards'),
            'sub' => (string) $userId,
            'typ' => $type,
            'iat' => $now,
            'exp' => $now + $ttl,
            'jti' => bin2hex(random_bytes(8)),
        ];

        $header    = self::b64(json_encode(['alg' => 'HS256', 'typ' => 'JWT'], JSON_THROW_ON_ERROR));
        $body      = self::b64(json_encode($payload, JSON_THROW_ON_ERROR));
        $signature = self::b64(self::sign("$header.$body"));

        return "$header.$body.$signature";
    }

    /**
     * Verifies signature, expiry and token type.
     * @return array<string,mixed>|null decoded claims, or null if invalid
     */
    public static function verify(string $token, string $expectedType = 'access'): ?array
    {
        $parts = explode('.', $token);
        if (count($parts) !== 3) {
            return null;
        }
        [$header, $body, $signature] = $parts;

        // hash_equals: constant-time, so a bad signature leaks no timing signal.
        if (!hash_equals(self::b64(self::sign("$header.$body")), $signature)) {
            return null;
        }

        $claims = json_decode(self::unb64($body), true);
        if (!is_array($claims)) {
            return null;
        }

        $leeway = (int) Config::get('jwt.leeway', 60);
        $now    = time();

        if (!isset($claims['exp']) || $now > ((int) $claims['exp'] + $leeway)) {
            return null;
        }
        if (isset($claims['iat']) && ((int) $claims['iat'] - $leeway) > $now) {
            return null;  // issued in the future
        }
        if (($claims['typ'] ?? null) !== $expectedType) {
            return null;  // refresh token must never be accepted as an access token
        }
        if (($claims['iss'] ?? null) !== Config::get('jwt.issuer', 'smashcards')) {
            return null;
        }
        if (!isset($claims['sub']) || !ctype_digit((string) $claims['sub'])) {
            return null;
        }

        return $claims;
    }

    private static function sign(string $data): string
    {
        return hash_hmac('sha256', $data, (string) Config::get('jwt.secret'), true);
    }

    private static function b64(string $raw): string
    {
        return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
    }

    private static function unb64(string $encoded): string
    {
        return base64_decode(strtr($encoded, '-_', '+/')) ?: '';
    }
}
