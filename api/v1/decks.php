<?php
declare(strict_types=1);

require_once __DIR__ . '/../lib/db.php';
require_once __DIR__ . '/../lib/auth.php';
require_once __DIR__ . '/../lib/guard.php';
require_once __DIR__ . '/../lib/response.php';
require_once __DIR__ . '/../lib/validation.php';

final class DecksController
{
    /** GET /v1/decks — the caller's decks, with counts the deck list UI needs. */
    public static function index(): never
    {
        $userId = Auth::requireUser();

        $decks = Db::all(
            "SELECT d.*,
                    (SELECT COUNT(*) FROM cards c
                      WHERE c.deck_id = d.id AND c.status = 'active') AS card_count,
                    (SELECT COUNT(*) FROM cards c
                       JOIN card_states s ON s.card_id = c.id AND s.user_id = ?
                      WHERE c.deck_id = d.id AND c.status = 'active'
                        AND s.due_at IS NOT NULL AND s.due_at <= UTC_TIMESTAMP()) AS due_count,
                    (SELECT COUNT(*) FROM cards c
                      WHERE c.deck_id = d.id AND c.status = 'active'
                        AND NOT EXISTS (SELECT 1 FROM card_states s
                                         WHERE s.card_id = c.id AND s.user_id = ?)) AS new_count
               FROM decks d
              WHERE d.user_id = ?
              ORDER BY d.updated_at DESC",
            [$userId, $userId, $userId]
        );

        Response::json(['decks' => array_map([self::class, 'shape'], $decks)]);
    }

    /**
     * GET /v1/decks/public — other users' public decks, newest first.
     * Optional ?q= filters by title. The caller's own public decks are
     * excluded; browsing your own deck to clone it is a no-op anyway (you
     * already have it), so hiding it keeps the list about discovery.
     */
    public static function publicIndex(): never
    {
        $userId = Auth::requireUser();

        $q = trim((string) ($_GET['q'] ?? ''));
        $params = [$userId];
        $where  = 'd.is_public = 1 AND d.user_id != ?';

        if ($q !== '') {
            $where   .= ' AND d.title LIKE ?';
            $params[] = '%' . self::escapeLike($q) . '%';
        }

        $decks = Db::all(
            "SELECT d.*, u.display_name AS owner_name,
                    (SELECT COUNT(*) FROM cards c
                      WHERE c.deck_id = d.id AND c.status = 'active') AS card_count
               FROM decks d
               JOIN users u ON u.id = d.user_id
              WHERE {$where}
              ORDER BY d.updated_at DESC
              LIMIT 100",
            $params
        );

        Response::json(['decks' => array_map(static function (array $deck): array {
            $shaped = self::shape($deck);
            $shaped['owner_name'] = $deck['owner_name'];
            unset($shaped['share_token']); // never leak another owner's private link
            return $shaped;
        }, $decks)]);
    }

    /**
     * POST /v1/decks/{id}/clone — copies a public (or the caller's own) deck
     * into the caller's account: a new deck, a fresh copy of every active
     * card. Nothing about the caller's study progress is involved, because
     * the clone's cards are brand new rows — there is no history to bring
     * over, spaced-repetition or otherwise.
     */
    public static function clone(array $params): never
    {
        $userId = Auth::requireUser();
        $source = Guard::deck($params['id'], $userId, forWrite: false); // owner OR public

        self::respondWithClone($source, $userId);
    }

    /**
     * POST /v1/shared/{token}/clone — same copy as clone(), reached by an
     * unguessable link instead of an id. Access here is "you hold the
     * token", not ownership or is_public — see showShared() for that lookup.
     */
    public static function cloneShared(array $params): never
    {
        $userId = Auth::requireUser();
        $source = self::findByShareToken($params['token']);

        self::respondWithClone($source, $userId);
    }

    /** POST /v1/decks/{id}/share — owner-only. Returns the existing token if
     *  already shared (idempotent), so re-opening settings never silently
     *  invalidates a link already sent to someone. Pass {"regenerate":true}
     *  to deliberately issue a fresh one, which invalidates the old link. */
    public static function share(array $params): never
    {
        $userId = Auth::requireUser();
        $deck   = Guard::deck($params['id'], $userId);
        $body   = Response::body();

        if ($deck['share_token'] !== null && empty($body['regenerate'])) {
            Response::json(['share_token' => $deck['share_token']]);
        }

        // Collisions are astronomically unlikely at 160 bits, but the unique
        // index is the real guarantee — retry the rare case it ever fires.
        for ($attempt = 0; $attempt < 5; $attempt++) {
            $token = bin2hex(random_bytes(20));
            try {
                Db::run('UPDATE decks SET share_token = ? WHERE id = ?', [$token, (int) $deck['id']]);
                Response::json(['share_token' => $token]);
            } catch (PDOException $e) {
                if (!str_contains($e->getMessage(), 'uq_decks_share_token')) {
                    throw $e;
                }
            }
        }

        Response::error('server_error', 'Could not generate a share link. Please try again.', 500);
    }

    /** DELETE /v1/decks/{id}/share — owner-only. The link stops working immediately. */
    public static function unshare(array $params): never
    {
        $userId = Auth::requireUser();
        $deck   = Guard::deck($params['id'], $userId);

        Db::run('UPDATE decks SET share_token = NULL WHERE id = ?', [(int) $deck['id']]);

        Response::json(['unshared' => true]);
    }

    /**
     * GET /v1/shared/{token} — anyone signed in who holds the link. Not
     * gated by is_public or ownership: possession of the token is the
     * access control, same principle as a link-sharing setting elsewhere.
     */
    public static function showShared(array $params): never
    {
        Auth::requireUser();
        $deck = self::findByShareToken($params['token']);

        $shaped = self::shape($deck);
        $shaped['owner_name'] = $deck['owner_name'];
        unset($shaped['share_token']); // a viewer has no use for re-sharing the owner's token

        Response::json(['deck' => $shaped]);
    }

    /** @return array<string,mixed> the deck row plus owner_name, or a 404 */
    private static function findByShareToken(mixed $token): array
    {
        $token = trim((string) $token);
        if ($token === '' || !preg_match('/^[a-f0-9]{40}$/', $token)) {
            Response::error('not_found', 'Shared deck not found.', 404);
        }

        $deck = Db::one(
            "SELECT d.*, u.display_name AS owner_name,
                    (SELECT COUNT(*) FROM cards c
                      WHERE c.deck_id = d.id AND c.status = 'active') AS card_count
               FROM decks d
               JOIN users u ON u.id = d.user_id
              WHERE d.share_token = ?",
            [$token]
        );

        if ($deck === null) {
            Response::error('not_found', 'Shared deck not found.', 404);
        }

        return $deck;
    }

    /** Shared copy logic behind both clone() and cloneShared(). */
    private static function respondWithClone(array $source, int $userId): never
    {
        $cards = Db::all(
            "SELECT question_text, answer_text FROM cards
              WHERE deck_id = ? AND status = 'active' ORDER BY position ASC",
            [(int) $source['id']]
        );

        $pdo = Db::conn();
        $pdo->beginTransaction();
        try {
            $newDeckId = Db::insert(
                'INSERT INTO decks (user_id, title, description, language_front, language_back, is_public)
                 VALUES (?, ?, ?, ?, ?, 0)',
                [
                    $userId,
                    $source['title'],
                    $source['description'],
                    $source['language_front'],
                    $source['language_back'],
                ]
            );

            $stmt = $pdo->prepare(
                "INSERT INTO cards (deck_id, question_text, answer_text, source_type, status, position)
                 VALUES (?, ?, ?, 'manual', 'active', ?)"
            );
            foreach ($cards as $position => $card) {
                $stmt->execute([$newDeckId, $card['question_text'], $card['answer_text'], $position]);
            }

            $pdo->commit();
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        Response::json([
            'deck' => self::shape(Db::one('SELECT * FROM decks WHERE id = ?', [$newDeckId])),
            'cards_cloned' => count($cards),
        ], 201);
    }

    private static function escapeLike(string $value): string
    {
        return addcslashes($value, '%_\\');
    }

    /** POST /v1/decks */
    public static function store(): never
    {
        $userId = Auth::requireUser();
        $body   = Response::body();

        $v = (new Validator($body))
            ->text('title', 1, 200)
            ->text('description', 0, 2000, false)
            ->text('language_front', 2, 16, false)
            ->text('language_back', 2, 16, false);

        if ($v->fails()) {
            Response::error('validation_failed', 'Check the highlighted fields.', 422, $v->errors());
        }

        $description = Validator::str($body, 'description');
        $folderId    = self::resolveFolder($body, $userId);

        $deckId = Db::insert(
            'INSERT INTO decks (user_id, folder_id, title, description, language_front, language_back, is_public)
             VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
                $userId,
                $folderId,
                Validator::str($body, 'title'),
                $description === '' ? null : $description,
                Validator::str($body, 'language_front') ?: 'en-US',
                Validator::str($body, 'language_back') ?: 'en-US',
                !empty($body['is_public']) ? 1 : 0,
            ]
        );

        Response::json(['deck' => self::shape(Db::one('SELECT * FROM decks WHERE id = ?', [$deckId]))], 201);
    }

    /** GET /v1/decks/{id} */
    public static function show(array $params): never
    {
        $userId = Auth::requireUser();
        $deck   = Guard::deck($params['id'], $userId, forWrite: false); // owner OR public

        $shaped = self::shape($deck);
        // A public deck is readable by anyone, but its share_token must stay
        // visible only to the owner — otherwise browsing a public deck would
        // hand every viewer the same "private link" as a side effect.
        if ((int) $deck['user_id'] !== $userId) {
            $shaped['share_token'] = null;
        }

        Response::json(['deck' => $shaped]);
    }

    /** PATCH /v1/decks/{id} — partial update; absent keys are left alone. */
    public static function update(array $params): never
    {
        $userId = Auth::requireUser();
        $deck   = Guard::deck($params['id'], $userId);
        $body   = Response::body();

        $v = new Validator($body);
        if (array_key_exists('title', $body))          { $v->text('title', 1, 200); }
        if (array_key_exists('description', $body))    { $v->text('description', 0, 2000, false); }
        if (array_key_exists('language_front', $body)) { $v->text('language_front', 2, 16, false); }
        if (array_key_exists('language_back', $body))  { $v->text('language_back', 2, 16, false); }

        if ($v->fails()) {
            Response::error('validation_failed', 'Check the highlighted fields.', 422, $v->errors());
        }

        $sets   = [];
        $values = [];

        foreach (['title', 'description', 'language_front', 'language_back'] as $field) {
            if (array_key_exists($field, $body)) {
                $value    = Validator::str($body, $field);
                $sets[]   = "$field = ?";
                $values[] = ($field === 'description' && $value === '') ? null : $value;
            }
        }
        if (array_key_exists('is_public', $body)) {
            $sets[]   = 'is_public = ?';
            $values[] = !empty($body['is_public']) ? 1 : 0;
        }
        // Moving a deck: folder_id is nullable, so presence in the body (not
        // truthiness) is what signals a change — { folder_id: null } means
        // "move to root" and must be a real update, not a no-op.
        if (array_key_exists('folder_id', $body)) {
            $sets[]   = 'folder_id = ?';
            $values[] = self::resolveFolder($body, $userId);
        }

        if ($sets === []) {
            Response::error('validation_failed', 'No updatable fields supplied.', 422);
        }

        $values[] = (int) $deck['id'];
        Db::run('UPDATE decks SET ' . implode(', ', $sets) . ' WHERE id = ?', $values);

        Response::json(['deck' => self::shape(Db::one('SELECT * FROM decks WHERE id = ?', [(int) $deck['id']]))]);
    }

    /** DELETE /v1/decks/{id} — cascades to cards, card_states and reviews. */
    public static function destroy(array $params): never
    {
        $userId = Auth::requireUser();
        $deck   = Guard::deck($params['id'], $userId);

        // The sources rows go with the deck by foreign key, but the uploaded
        // files they point at live on disk, where no cascade reaches — so they
        // are removed first. Skipping this leaks every PDF and recording the
        // deck ever held, permanently and invisibly.
        self::deleteStoredFilesFor((int) $deck['id']);

        Db::run('DELETE FROM decks WHERE id = ?', [(int) $deck['id']]);

        Response::json(['deleted' => true, 'id' => (int) $deck['id']]);
    }

    /**
     * Removes the uploaded files belonging to a deck's sources.
     *
     * Best-effort by design: a file that is already gone, or a storage
     * directory that has moved, must not stop the user deleting their deck.
     */
    private static function deleteStoredFilesFor(int $deckId): void
    {
        require_once __DIR__ . '/../lib/storage.php';

        try {
            $rows = Db::all(
                'SELECT storage_key FROM sources WHERE deck_id = ? AND storage_key IS NOT NULL',
                [$deckId]
            );

            foreach ($rows as $row) {
                Storage::delete((string) $row['storage_key']);
            }
        } catch (Throwable $e) {
            error_log('[smashcards] could not clean up deck files: ' . $e->getMessage());
        }
    }

    /** Validates a folder_id from the body: null (root) or an owned folder. */
    private static function resolveFolder(array $body, int $userId): ?int
    {
        $raw = $body['folder_id'] ?? null;
        if ($raw === null || $raw === '') {
            return null;
        }
        require_once __DIR__ . '/../lib/guard.php';
        return (int) Guard::folder($raw, $userId)['id'];
    }

    /** Casts MySQL's all-strings result into real JSON types. */
    public static function shape(array $deck): array
    {
        return [
            'id'             => (int) $deck['id'],
            'user_id'        => (int) $deck['user_id'],
            'folder_id'      => $deck['folder_id'] !== null ? (int) $deck['folder_id'] : null,
            'title'          => $deck['title'],
            'description'    => $deck['description'],
            'language_front' => $deck['language_front'],
            'language_back'  => $deck['language_back'],
            'is_public'      => (bool) $deck['is_public'],
            'share_token'    => $deck['share_token'] ?? null,
            'card_count'     => isset($deck['card_count']) ? (int) $deck['card_count'] : null,
            'due_count'      => isset($deck['due_count']) ? (int) $deck['due_count'] : null,
            'new_count'      => isset($deck['new_count']) ? (int) $deck['new_count'] : null,
            'created_at'     => $deck['created_at'],
            'updated_at'     => $deck['updated_at'],
        ];
    }
}
