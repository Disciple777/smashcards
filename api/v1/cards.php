<?php
declare(strict_types=1);

require_once __DIR__ . '/../lib/db.php';
require_once __DIR__ . '/../lib/auth.php';
require_once __DIR__ . '/../lib/guard.php';
require_once __DIR__ . '/../lib/response.php';
require_once __DIR__ . '/../lib/validation.php';

final class CardsController
{
    private const MAX_BULK = 500;
    private const MAX_TEXT = 2000;

    /** GET /v1/decks/{deck_id}/cards */
    public static function index(array $params): never
    {
        $userId = Auth::requireUser();
        $deck   = Guard::deck($params['deck_id'], $userId, forWrite: false);

        // ?status=staged surfaces the phase-3 AI review queue; default hides it.
        $status = ($_GET['status'] ?? 'active') === 'staged' ? 'staged' : 'active';

        $cards = Db::all(
            'SELECT * FROM cards WHERE deck_id = ? AND status = ? ORDER BY position ASC, id ASC',
            [(int) $deck['id'], $status]
        );

        Response::json([
            'deck_id' => (int) $deck['id'],
            'cards'   => array_map([self::class, 'shape'], $cards),
        ]);
    }

    /** POST /v1/decks/{deck_id}/cards */
    public static function store(array $params): never
    {
        $userId = Auth::requireUser();
        $deck   = Guard::deck($params['deck_id'], $userId);
        $body   = Response::body();

        $v = (new Validator($body))
            ->text('question_text', 1, self::MAX_TEXT)
            ->text('answer_text', 1, self::MAX_TEXT);

        if ($v->fails()) {
            Response::error('validation_failed', 'Check the highlighted fields.', 422, $v->errors());
        }

        $cardId = Db::insert(
            'INSERT INTO cards (deck_id, question_text, answer_text, source_type, status, position)
             VALUES (?, ?, ?, ?, ?, ?)',
            [
                (int) $deck['id'],
                Validator::str($body, 'question_text'),
                Validator::str($body, 'answer_text'),
                self::sourceType($body),
                self::status($body),
                self::nextPosition((int) $deck['id']),
            ]
        );

        self::touchDeck((int) $deck['id']);

        Response::json(['card' => self::shape(Db::one('SELECT * FROM cards WHERE id = ?', [$cardId]))], 201);
    }

    /**
     * POST /v1/decks/{deck_id}/cards/bulk
     * body: { cards: [ { question_text, answer_text }, ... ] }
     *
     * All-or-nothing: a half-imported deck is worse than a rejected one.
     */
    public static function bulkStore(array $params): never
    {
        $userId = Auth::requireUser();
        $deck   = Guard::deck($params['deck_id'], $userId);
        $body   = Response::body();

        $rows = $body['cards'] ?? null;
        if (!is_array($rows) || $rows === []) {
            Response::error('validation_failed', 'cards must be a non-empty array.', 422);
        }
        if (count($rows) > self::MAX_BULK) {
            Response::error('too_many_cards', 'Import at most ' . self::MAX_BULK . ' cards per request.', 422);
        }

        $errors = [];
        $clean  = [];

        foreach ($rows as $index => $row) {
            if (!is_array($row)) {
                $errors["cards.$index"] = 'Each card must be an object.';
                continue;
            }
            $v = (new Validator($row))
                ->text('question_text', 1, self::MAX_TEXT)
                ->text('answer_text', 1, self::MAX_TEXT);

            if ($v->fails()) {
                foreach ($v->errors() as $field => $message) {
                    $errors["cards.$index.$field"] = $message;
                }
                continue;
            }
            $clean[] = [
                Validator::str($row, 'question_text'),
                Validator::str($row, 'answer_text'),
                self::sourceType($row),
                self::status($row),
            ];
        }

        if ($errors !== []) {
            Response::error('validation_failed', 'Some cards were rejected; nothing was imported.', 422, $errors);
        }

        $deckId   = (int) $deck['id'];
        $position = self::nextPosition($deckId);
        $pdo      = Db::conn();

        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare(
                'INSERT INTO cards (deck_id, question_text, answer_text, source_type, status, position)
                 VALUES (?, ?, ?, ?, ?, ?)'
            );
            foreach ($clean as $row) {
                $stmt->execute([$deckId, $row[0], $row[1], $row[2], $row[3], $position++]);
            }
            $pdo->commit();
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        self::touchDeck($deckId);

        Response::json(['imported' => count($clean), 'deck_id' => $deckId], 201);
    }

    /** GET /v1/cards/{id} */
    public static function show(array $params): never
    {
        $userId = Auth::requireUser();
        $card   = Guard::card($params['id'], $userId, forWrite: false);

        Response::json(['card' => self::shape($card)]);
    }

    /** PATCH /v1/cards/{id} */
    public static function update(array $params): never
    {
        $userId = Auth::requireUser();
        $card   = Guard::card($params['id'], $userId);
        $body   = Response::body();

        $v = new Validator($body);
        if (array_key_exists('question_text', $body)) {
            $v->text('question_text', 1, self::MAX_TEXT);
        }
        if (array_key_exists('answer_text', $body)) {
            $v->text('answer_text', 1, self::MAX_TEXT);
        }

        if ($v->fails()) {
            Response::error('validation_failed', 'Check the highlighted fields.', 422, $v->errors());
        }

        $sets   = [];
        $values = [];

        foreach (['question_text', 'answer_text'] as $field) {
            if (array_key_exists($field, $body)) {
                $sets[]   = "$field = ?";
                $values[] = Validator::str($body, $field);
            }
        }
        // Approving a staged AI card is just a status flip.
        if (array_key_exists('status', $body)) {
            $sets[]   = 'status = ?';
            $values[] = self::status($body);
        }

        if ($sets === []) {
            Response::error('validation_failed', 'No updatable fields supplied.', 422);
        }

        $values[] = (int) $card['id'];
        Db::run('UPDATE cards SET ' . implode(', ', $sets) . ' WHERE id = ?', $values);

        self::touchDeck((int) $card['deck_id']);

        Response::json(['card' => self::shape(Db::one('SELECT * FROM cards WHERE id = ?', [(int) $card['id']]))]);
    }

    /** DELETE /v1/cards/{id} */
    public static function destroy(array $params): never
    {
        $userId = Auth::requireUser();
        $card   = Guard::card($params['id'], $userId);

        Db::run('DELETE FROM cards WHERE id = ?', [(int) $card['id']]);
        self::touchDeck((int) $card['deck_id']);

        Response::json(['deleted' => true, 'id' => (int) $card['id']]);
    }

    /**
     * PATCH /v1/decks/{deck_id}/cards/reorder
     * body: { card_ids: [3, 1, 2] }
     * Ids left out keep their relative order, after the ones listed.
     */
    public static function reorder(array $params): never
    {
        $userId = Auth::requireUser();
        $deck   = Guard::deck($params['deck_id'], $userId);
        $body   = Response::body();

        $ids = $body['card_ids'] ?? null;
        if (!is_array($ids) || $ids === []) {
            Response::error('validation_failed', 'card_ids must be a non-empty array.', 422);
        }

        $deckId = (int) $deck['id'];
        $owned  = array_map('intval', array_column(
            Db::all('SELECT id FROM cards WHERE deck_id = ? ORDER BY position ASC, id ASC', [$deckId]),
            'id'
        ));

        $ordered = [];
        foreach ($ids as $id) {
            $id = (int) $id;
            if (!in_array($id, $owned, true)) {
                Response::error('validation_failed', "Card $id does not belong to this deck.", 422);
            }
            if (in_array($id, $ordered, true)) {
                Response::error('validation_failed', "Card $id appears twice in card_ids.", 422);
            }
            $ordered[] = $id;
        }

        $pdo = Db::conn();
        $pdo->beginTransaction();
        try {
            $stmt     = $pdo->prepare('UPDATE cards SET position = ? WHERE id = ? AND deck_id = ?');
            $position = 0;
            foreach ($ordered as $id) {
                $stmt->execute([$position++, $id, $deckId]);
            }
            foreach (array_diff($owned, $ordered) as $id) {
                $stmt->execute([$position++, $id, $deckId]);
            }
            $pdo->commit();
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        self::touchDeck($deckId);

        Response::json(['reordered' => count($ordered), 'deck_id' => $deckId]);
    }

    private static function nextPosition(int $deckId): int
    {
        $row = Db::one('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM cards WHERE deck_id = ?', [$deckId]);
        return (int) $row['next'];
    }

    /** Keeps decks.updated_at meaningful as a last-touched sort key. */
    private static function touchDeck(int $deckId): void
    {
        Db::run('UPDATE decks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [$deckId]);
    }

    private static function sourceType(array $body): string
    {
        $value = (string) ($body['source_type'] ?? 'manual');
        return in_array($value, ['manual', 'voice', 'ai'], true) ? $value : 'manual';
    }

    private static function status(array $body): string
    {
        return ($body['status'] ?? 'active') === 'staged' ? 'staged' : 'active';
    }

    public static function shape(array $card): array
    {
        return [
            'id'                 => (int) $card['id'],
            'deck_id'            => (int) $card['deck_id'],
            'question_text'      => $card['question_text'],
            'answer_text'        => $card['answer_text'],
            'question_audio_url' => $card['question_audio_url'],
            'answer_audio_url'   => $card['answer_audio_url'],
            'source_type'        => $card['source_type'],
            'source_id'          => isset($card['source_id']) && $card['source_id'] !== null
                ? (int) $card['source_id']
                : null,
            'status'             => $card['status'],
            'position'           => (int) $card['position'],
            'created_at'         => $card['created_at'],
            'updated_at'         => $card['updated_at'],
        ];
    }
}
