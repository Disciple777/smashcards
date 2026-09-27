<?php
declare(strict_types=1);

require_once __DIR__ . '/../lib/db.php';
require_once __DIR__ . '/../lib/auth.php';
require_once __DIR__ . '/../lib/guard.php';
require_once __DIR__ . '/../lib/response.php';
require_once __DIR__ . '/../lib/validation.php';

final class SessionsController
{
    /** POST /v1/sessions — body: { deck_id, mode } */
    public static function store(): never
    {
        $userId = Auth::requireUser();
        $body   = Response::body();

        $deck = Guard::deck($body['deck_id'] ?? '', $userId, forWrite: false);
        $mode = self::mode($body);

        $sessionId = Db::insert(
            'INSERT INTO sessions (user_id, deck_id, mode) VALUES (?, ?, ?)',
            [$userId, (int) $deck['id'], $mode]
        );

        Response::json(['session' => self::shape(self::find($sessionId, $userId))], 201);
    }

    /** GET /v1/sessions/{id} */
    public static function show(array $params): never
    {
        $userId = Auth::requireUser();
        Response::json(['session' => self::shape(self::find(Guard::id($params['id']), $userId))]);
    }

    /**
     * PATCH /v1/sessions/{id} — ends a session.
     * cards_reviewed is maintained by the reviews endpoint, not trusted from the client.
     */
    public static function update(array $params): never
    {
        $userId  = Auth::requireUser();
        $session = self::find(Guard::id($params['id']), $userId);

        if ($session['ended_at'] === null) {
            Db::run('UPDATE sessions SET ended_at = UTC_TIMESTAMP() WHERE id = ?', [(int) $session['id']]);
        }

        Response::json(['session' => self::shape(self::find((int) $session['id'], $userId))]);
    }

    /** GET /v1/sessions — recent sessions, for the progress screen. */
    public static function index(): never
    {
        $userId = Auth::requireUser();

        $limit = isset($_GET['limit']) && ctype_digit((string) $_GET['limit'])
            ? min(100, max(1, (int) $_GET['limit']))
            : 20;

        $rows = Db::all(
            'SELECT * FROM sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT ' . $limit,
            [$userId]
        );

        Response::json(['sessions' => array_map([self::class, 'shape'], $rows)]);
    }

    /** A session belonging to someone else is a 404, as everywhere else. */
    public static function find(int $sessionId, int $userId): array
    {
        $session = Db::one('SELECT * FROM sessions WHERE id = ? AND user_id = ?', [$sessionId, $userId]);
        if ($session === null) {
            Response::error('not_found', 'Session not found.', 404);
        }
        return $session;
    }

    public static function mode(array $body): string
    {
        return ($body['mode'] ?? 'spaced') === 'random' ? 'random' : 'spaced';
    }

    public static function shape(array $session): array
    {
        return [
            'id'             => (int) $session['id'],
            'deck_id'        => $session['deck_id'] === null ? null : (int) $session['deck_id'],
            'mode'           => $session['mode'],
            'started_at'     => $session['started_at'],
            'ended_at'       => $session['ended_at'],
            'cards_reviewed' => (int) $session['cards_reviewed'],
        ];
    }
}
