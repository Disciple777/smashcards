<?php
declare(strict_types=1);

require_once __DIR__ . '/jwt.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/response.php';

/** Bearer-token middleware. */
final class Auth
{
    /** Returns the authenticated user id, or 401s. */
    public static function requireUser(): int
    {
        $token = self::bearerToken();
        if ($token === null) {
            Response::error('unauthenticated', 'Missing Authorization header.', 401);
        }

        $claims = Jwt::verify($token, 'access');
        if ($claims === null) {
            Response::error('invalid_token', 'Token is invalid or has expired.', 401);
        }

        $userId = (int) $claims['sub'];

        // The token can outlive the account it names.
        $exists = Db::one('SELECT id FROM users WHERE id = ?', [$userId]);
        if ($exists === null) {
            Response::error('invalid_token', 'Token is invalid or has expired.', 401);
        }

        return $userId;
    }

    private static function bearerToken(): ?string
    {
        $header = $_SERVER['HTTP_AUTHORIZATION']
            ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION']  // Apache CGI/FastCGI
            ?? '';

        if ($header === '' && function_exists('apache_request_headers')) {
            foreach (apache_request_headers() as $name => $value) {
                if (strcasecmp($name, 'Authorization') === 0) {
                    $header = $value;
                    break;
                }
            }
        }

        if (preg_match('/^Bearer\s+(\S+)$/i', trim($header), $m) === 1) {
            return $m[1];
        }
        return null;
    }
}
