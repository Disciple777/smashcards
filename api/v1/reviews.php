<?php
declare(strict_types=1);

require_once __DIR__ . '/../lib/db.php';
require_once __DIR__ . '/../lib/auth.php';
require_once __DIR__ . '/../lib/guard.php';
require_once __DIR__ . '/../lib/response.php';
require_once __DIR__ . '/../lib/validation.php';
require_once __DIR__ . '/sessions.php';

/**
 * Review submission.
 *
 * Per the roadmap, scheduling math lives in React: the client computes the next
 * card state and posts it alongside the review. The API stores what it is told,
 * but validates every value into a sane range first — a client bug should not be
 * able to write ease_factor = 0 or an interval of 40 years.
 */
final class ReviewsController
{
    private const MIN_EASE = 1.30;
    private const MAX_EASE = 5.00;
    private const MAX_INTERVAL_DAYS = 36500;  // ~100 years

    /**
     * POST /v1/reviews
     * body: {
     *   card_id, session_id?, rating (1-4), score (0-1), response_ms?, mode,
     *   state: { ease_factor, interval_days, repetitions, due_at, last_reviewed_at? }
     * }
     */
    public static function store(): never
    {
        $userId = Auth::requireUser();
        $body   = Response::body();

        $card   = Guard::card($body['card_id'] ?? '', $userId, forWrite: false);
        $cardId = (int) $card['id'];

        $rating = self::rating($body);
        $score  = self::score($body, $rating);
        $mode   = SessionsController::mode($body);

        $sessionId = null;
        if (isset($body['session_id']) && $body['session_id'] !== null && $body['session_id'] !== '') {
            $sessionId = (int) SessionsController::find(Guard::id($body['session_id']), $userId)['id'];
        }

        $responseMs = null;
        if (isset($body['response_ms']) && is_numeric($body['response_ms'])) {
            // Clamp rather than reject: a backgrounded tab can produce absurd values.
            $responseMs = max(0, min(3600000, (int) $body['response_ms']));
        }

        $state = self::state($body['state'] ?? []);

        $pdo = Db::conn();
        $pdo->beginTransaction();
        try {
            $reviewId = (int) self::insert($pdo,
                'INSERT INTO reviews (user_id, card_id, session_id, score, rating, response_ms, mode)
                 VALUES (?, ?, ?, ?, ?, ?, ?)',
                [$userId, $cardId, $sessionId, $score, $rating, $responseMs, $mode]
            );

            // One row per user per card; a second review updates it in place.
            self::exec($pdo,
                'INSERT INTO card_states
                    (user_id, card_id, ease_factor, interval_days, repetitions, due_at, last_reviewed_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    ease_factor      = VALUES(ease_factor),
                    interval_days    = VALUES(interval_days),
                    repetitions      = VALUES(repetitions),
                    due_at           = VALUES(due_at),
                    last_reviewed_at = VALUES(last_reviewed_at)',
                [
                    $userId,
                    $cardId,
                    $state['ease_factor'],
                    $state['interval_days'],
                    $state['repetitions'],
                    $state['due_at'],
                    $state['last_reviewed_at'],
                ]
            );

            if ($sessionId !== null) {
                self::exec($pdo,
                    'UPDATE sessions SET cards_reviewed = cards_reviewed + 1 WHERE id = ? AND user_id = ?',
                    [$sessionId, $userId]
                );
            }

            $pdo->commit();
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        Response::json([
            'review_id'  => $reviewId,
            'card_state' => self::shapeState(
                Db::one('SELECT * FROM card_states WHERE user_id = ? AND card_id = ?', [$userId, $cardId])
            ),
        ], 201);
    }

    /**
     * GET /v1/decks/{deck_id}/states
     * The caller's scheduling state for every card in the deck, keyed by card id,
     * so the client can build a session queue in one request.
     */
    public static function statesForDeck(array $params): never
    {
        $userId = Auth::requireUser();
        $deck   = Guard::deck($params['deck_id'], $userId, forWrite: false);

        $rows = Db::all(
            'SELECT s.* FROM card_states s
               JOIN cards c ON c.id = s.card_id
              WHERE s.user_id = ? AND c.deck_id = ?',
            [$userId, (int) $deck['id']]
        );

        $states = [];
        foreach ($rows as $row) {
            $states[(string) (int) $row['card_id']] = self::shapeState($row);
        }

        Response::json(['deck_id' => (int) $deck['id'], 'states' => (object) $states]);
    }

    private static function rating(array $body): int
    {
        $rating = $body['rating'] ?? null;
        if (!is_numeric($rating) || (int) $rating < 1 || (int) $rating > 4) {
            Response::error('validation_failed', 'rating must be an integer from 1 to 4.', 422, [
                'rating' => 'Must be 1, 2, 3 or 4.',
            ]);
        }
        return (int) $rating;
    }

    /** Falls back to a rating-derived score, so the column is never null. */
    private static function score(array $body, int $rating): float
    {
        if (isset($body['score']) && is_numeric($body['score'])) {
            $score = (float) $body['score'];
            if ($score < 0 || $score > 1) {
                Response::error('validation_failed', 'score must be between 0 and 1.', 422, [
                    'score' => 'Must be between 0 and 1.',
                ]);
            }
            return round($score, 2);
        }

        return [1 => 0.0, 2 => 0.4, 3 => 0.75, 4 => 1.0][$rating];
    }

    /** Clamps client-supplied scheduling values into ranges the schema can hold. */
    private static function state(mixed $state): array
    {
        if (!is_array($state)) {
            $state = [];
        }

        $ease = isset($state['ease_factor']) && is_numeric($state['ease_factor'])
            ? (float) $state['ease_factor']
            : 2.5;

        $interval = isset($state['interval_days']) && is_numeric($state['interval_days'])
            ? (int) $state['interval_days']
            : 0;

        $repetitions = isset($state['repetitions']) && is_numeric($state['repetitions'])
            ? (int) $state['repetitions']
            : 0;

        return [
            'ease_factor'      => round(max(self::MIN_EASE, min(self::MAX_EASE, $ease)), 2),
            'interval_days'    => max(0, min(self::MAX_INTERVAL_DAYS, $interval)),
            'repetitions'      => max(0, min(100000, $repetitions)),
            'due_at'           => self::dateTime($state['due_at'] ?? null)
                ?? gmdate('Y-m-d H:i:s', time() + 86400),
            'last_reviewed_at' => self::dateTime($state['last_reviewed_at'] ?? null)
                ?? gmdate('Y-m-d H:i:s'),
        ];
    }

    /** Accepts ISO-8601 or MySQL DATETIME, always stores UTC 'Y-m-d H:i:s'. */
    private static function dateTime(mixed $value): ?string
    {
        if (!is_string($value) || trim($value) === '') {
            return null;
        }
        $timestamp = strtotime($value);
        if ($timestamp === false) {
            return null;
        }
        return gmdate('Y-m-d H:i:s', $timestamp);
    }

    private static function shapeState(?array $row): ?array
    {
        if ($row === null) {
            return null;
        }
        return [
            'card_id'          => (int) $row['card_id'],
            'ease_factor'      => (float) $row['ease_factor'],
            'interval_days'    => (int) $row['interval_days'],
            'repetitions'      => (int) $row['repetitions'],
            'due_at'           => $row['due_at'],
            'last_reviewed_at' => $row['last_reviewed_at'],
        ];
    }

    private static function insert(PDO $pdo, string $sql, array $params): string
    {
        self::exec($pdo, $sql, $params);
        return $pdo->lastInsertId();
    }

    private static function exec(PDO $pdo, string $sql, array $params): void
    {
        $pdo->prepare($sql)->execute($params);
    }
}
