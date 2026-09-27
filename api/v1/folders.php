<?php
declare(strict_types=1);

require_once __DIR__ . '/../lib/db.php';
require_once __DIR__ . '/../lib/auth.php';
require_once __DIR__ . '/../lib/guard.php';
require_once __DIR__ . '/../lib/response.php';
require_once __DIR__ . '/../lib/validation.php';
require_once __DIR__ . '/../lib/foldertree.php';

/**
 * Deck folders, with subfolders via parent_id.
 *
 * The client fetches the whole flat list once (folders rarely number more
 * than a few dozen for one user) and builds the tree, breadcrumbs, and
 * recursive deck counts locally — the same shape GET /v1/decks already uses,
 * and it avoids a round trip per folder navigated into.
 */
final class FoldersController
{
    /** GET /v1/folders */
    public static function index(): never
    {
        $userId = Auth::requireUser();

        $folders = Db::all(
            'SELECT * FROM folders WHERE user_id = ? ORDER BY name ASC',
            [$userId]
        );

        Response::json(['folders' => array_map([self::class, 'shape'], $folders)]);
    }

    /** POST /v1/folders — body: { name, parent_id? } */
    public static function store(): never
    {
        $userId = Auth::requireUser();
        $body   = Response::body();

        $v = (new Validator($body))->text('name', 1, 100);
        if ($v->fails()) {
            Response::error('validation_failed', 'Check the highlighted fields.', 422, $v->errors());
        }

        $parentId = self::resolveParent($body, $userId);

        $id = Db::insert(
            'INSERT INTO folders (user_id, parent_id, name) VALUES (?, ?, ?)',
            [$userId, $parentId, Validator::str($body, 'name')]
        );

        Response::json(['folder' => self::shape(Db::one('SELECT * FROM folders WHERE id = ?', [$id]))], 201);
    }

    /** PATCH /v1/folders/{id} — body: { name?, parent_id? } — rename and/or move */
    public static function update(array $params): never
    {
        $userId = Auth::requireUser();
        $folder = Guard::folder($params['id'], $userId);
        $body   = Response::body();

        $sets   = [];
        $values = [];

        if (array_key_exists('name', $body)) {
            $v = (new Validator($body))->text('name', 1, 100);
            if ($v->fails()) {
                Response::error('validation_failed', 'Check the highlighted fields.', 422, $v->errors());
            }
            $sets[]   = 'name = ?';
            $values[] = Validator::str($body, 'name');
        }

        if (array_key_exists('parent_id', $body)) {
            $newParentId = self::resolveParent($body, $userId, (int) $folder['id']);
            $sets[]   = 'parent_id = ?';
            $values[] = $newParentId;
        }

        if ($sets === []) {
            Response::error('validation_failed', 'No updatable fields supplied.', 422);
        }

        $values[] = (int) $folder['id'];
        Db::run('UPDATE folders SET ' . implode(', ', $sets) . ' WHERE id = ?', $values);

        Response::json(['folder' => self::shape(Db::one('SELECT * FROM folders WHERE id = ?', [(int) $folder['id']]))]);
    }

    /**
     * DELETE /v1/folders/{id}
     * Subfolders cascade (FK). Decks inside — at any depth being removed —
     * move to root via ON DELETE SET NULL; they are never deleted here.
     */
    public static function destroy(array $params): never
    {
        $userId = Auth::requireUser();
        $folder = Guard::folder($params['id'], $userId);

        Db::run('DELETE FROM folders WHERE id = ?', [(int) $folder['id']]);

        Response::json(['deleted' => true, 'id' => (int) $folder['id']]);
    }

    // ------------------------------------------------------------ internals --

    /**
     * Validates and returns a parent_id from the request body: null (root),
     * or an owned folder id. When $selfId is given (an update, not a create),
     * also rejects moving a folder into itself or into its own subtree —
     * that would detach the tree from its own root and orphan it in a cycle
     * no listing could ever reach.
     */
    private static function resolveParent(array $body, int $userId, ?int $selfId = null): ?int
    {
        $raw = $body['parent_id'] ?? null;
        if ($raw === null || $raw === '') {
            return null;
        }

        $parent = Guard::folder($raw, $userId);
        $parentId = (int) $parent['id'];

        if ($selfId !== null && FolderTree::wouldCreateCycle($parentId, $selfId, $userId)) {
            Response::error(
                'validation_failed',
                'Cannot move a folder into itself or one of its own subfolders.',
                422
            );
        }

        return $parentId;
    }

    public static function shape(array $folder): array
    {
        return [
            'id'         => (int) $folder['id'],
            'parent_id'  => $folder['parent_id'] !== null ? (int) $folder['parent_id'] : null,
            'name'       => $folder['name'],
            'created_at' => $folder['created_at'],
            'updated_at' => $folder['updated_at'],
        ];
    }
}
