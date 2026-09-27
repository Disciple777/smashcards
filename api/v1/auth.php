<?php
declare(strict_types=1);

require_once __DIR__ . '/../lib/db.php';
require_once __DIR__ . '/../lib/jwt.php';
require_once __DIR__ . '/../lib/auth.php';
require_once __DIR__ . '/../lib/response.php';
require_once __DIR__ . '/../lib/validation.php';
require_once __DIR__ . '/../lib/ratelimit.php';
require_once __DIR__ . '/../lib/refreshtokens.php';

final class AuthController
{
    /** POST /api/v1/auth/register */
    public static function register(): never
    {
        $body = Response::body();

        $v = (new Validator($body))
            ->email('email')
            ->password('password')
            ->text('display_name', 1, 100);

        if ($v->fails()) {
            Response::error('validation_failed', 'Check the highlighted fields.', 422, $v->errors());
        }

        $email       = strtolower(Validator::str($body, 'email'));
        $displayName = Validator::str($body, 'display_name');
        $password    = (string) $body['password'];

        if (Db::one('SELECT id FROM users WHERE email = ?', [$email]) !== null) {
            Response::error('email_taken', 'That email is already registered.', 409, [
                'email' => 'That email is already registered.',
            ]);
        }

        $userId = Db::insert(
            'INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)',
            [$email, password_hash($password, PASSWORD_DEFAULT), $displayName]
        );

        Response::json(self::tokenPayload($userId), 201);
    }

    /** POST /api/v1/auth/login */
    public static function login(): never
    {
        $body     = Response::body();
        $email    = strtolower(Validator::str($body, 'email'));
        $password = (string) ($body['password'] ?? '');

        if ($email === '' || $password === '') {
            Response::error('validation_failed', 'Email and password are required.', 422);
        }

        $ip = RateLimit::clientIp();
        RateLimit::assertLoginAllowed($email, $ip);

        $user = Db::one('SELECT id, password_hash FROM users WHERE email = ?', [$email]);

        // One generic message for both branches: confirming which half was wrong
        // turns the login form into an account-enumeration oracle.
        if ($user === null || !password_verify($password, $user['password_hash'])) {
            // Spend comparable time on the miss so response latency doesn't leak
            // whether the address exists.
            if ($user === null) {
                password_verify($password, '$2y$10$usesomesillystringfoeegheatoflongenoughsaltvaluexxxxxxxxxxxxx');
            }
            RateLimit::recordFailure($email, $ip);
            Response::error('invalid_credentials', 'Email or password is incorrect.', 401);
        }

        RateLimit::clear($email, $ip);

        // Transparently upgrade hashes when PHP's default cost or algorithm moves.
        if (password_needs_rehash($user['password_hash'], PASSWORD_DEFAULT)) {
            Db::run('UPDATE users SET password_hash = ? WHERE id = ?', [
                password_hash($password, PASSWORD_DEFAULT),
                (int) $user['id'],
            ]);
        }

        Response::json(self::tokenPayload((int) $user['id']));
    }

    /** POST /api/v1/auth/refresh — body: { refresh_token } */
    public static function refresh(): never
    {
        $body  = Response::body();
        $token = Validator::str($body, 'refresh_token');

        if ($token === '') {
            Response::error('validation_failed', 'refresh_token is required.', 422);
        }

        $claims = Jwt::verify($token, 'refresh');
        if ($claims === null) {
            Response::error('invalid_token', 'Refresh token is invalid or has expired.', 401);
        }

        $userId = (int) $claims['sub'];
        if (Db::one('SELECT id FROM users WHERE id = ?', [$userId]) === null) {
            Response::error('invalid_token', 'Refresh token is invalid or has expired.', 401);
        }

        // Rotate: each refresh token may be exchanged exactly once, and a
        // second attempt means a copy of it exists somewhere it should not.
        $result = RefreshTokens::consume($userId, $claims);

        if (!$result['ok']) {
            $message = $result['reason'] === 'reused'
                ? 'This session was signed out because its token was used twice. Please log in again.'
                : 'Refresh token is invalid or has expired.';

            Response::error('invalid_token', $message, 401);
        }

        Response::json(self::tokenPayload($userId, $result['family']));
    }

    /**
     * POST /api/v1/auth/logout — body: { refresh_token }
     *
     * Ends this session for real. Throwing the token away on the device was
     * never enough: the token itself stayed valid for its full thirty days, so
     * any copy taken beforehand kept working.
     *
     * Deliberately unauthenticated. Logging out is a safe thing to allow — the
     * worst a stranger can do with a stolen refresh token here is end the
     * session it belongs to, which is what the real owner would want anyway —
     * and requiring a live access token would make it impossible to log out
     * once that token had expired.
     */
    public static function logout(): never
    {
        $body  = Response::body();
        $token = Validator::str($body, 'refresh_token');

        $claims = $token === '' ? null : Jwt::verify($token, 'refresh');

        // Always 200: whether the token was real is not something an
        // unauthenticated caller needs to learn, and the client's next step is
        // the same either way.
        if ($claims !== null && isset($claims['jti'])) {
            RefreshTokens::revokeByJti((string) $claims['jti']);
        }

        Response::json(['logged_out' => true]);
    }

    /**
     * POST /api/v1/auth/logout-all — ends every session for the signed-in user.
     *
     * Requires a live access token, because this one *is* worth protecting:
     * it signs out the user's other devices.
     */
    public static function logoutAll(): never
    {
        $userId = Auth::requireUser();
        $revoked = RefreshTokens::revokeAllFor($userId);

        Response::json(['logged_out' => true, 'tokens_revoked' => $revoked]);
    }

    /** GET /api/v1/auth/me */
    public static function me(): never
    {
        $userId = Auth::requireUser();
        Response::json(['user' => self::publicUser($userId)]);
    }

    /**
     * @param string|null $family the session to continue; null starts a new one
     */
    private static function tokenPayload(int $userId, ?string $family = null): array
    {
        $refresh = Jwt::issueRefresh($userId);

        // Re-read the claims rather than threading them out of the issuer: the
        // jti has to be recorded exactly as it was signed, and verifying what
        // we just produced costs one HMAC.
        $claims = Jwt::verify($refresh, 'refresh');
        RefreshTokens::record($userId, $claims, $family);

        return [
            'access_token'  => Jwt::issueAccess($userId),
            'refresh_token' => $refresh,
            'token_type'    => 'Bearer',
            'expires_in'    => (int) Config::get('jwt.access_ttl', 900),
            'user'          => self::publicUser($userId),
        ];
    }

    /** Never returns password_hash. */
    private static function publicUser(int $userId): array
    {
        $user = Db::one(
            'SELECT id, email, display_name, settings_json, created_at FROM users WHERE id = ?',
            [$userId]
        );

        return [
            'id'           => (int) $user['id'],
            'email'        => $user['email'],
            'display_name' => $user['display_name'],
            'settings'     => $user['settings_json'] !== null
                ? json_decode($user['settings_json'], true)
                : new stdClass(),
            'created_at'   => $user['created_at'],
        ];
    }
}
