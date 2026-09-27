<?php
declare(strict_types=1);

require_once __DIR__ . '/db.php';

/**
 * Cycle detection for the folder tree, factored out of FoldersController so
 * it has a name and can be exercised directly by the ops self test — the
 * same reason RateLimit::maxAttempts() exists as its own accessor.
 */
final class FolderTree
{
    private const MAX_DEPTH = 12; // generous; a real tree is a handful of levels

    /**
     * True if moving $movingId to become a child of $candidateParentId would
     * make $movingId its own ancestor — i.e. $candidateParentId is $movingId
     * itself, or lives anywhere in $movingId's current subtree.
     */
    public static function wouldCreateCycle(int $candidateParentId, int $movingId, int $userId): bool
    {
        if ($candidateParentId === $movingId) {
            return true;
        }

        $currentId = $candidateParentId;

        for ($depth = 0; $depth < self::MAX_DEPTH; $depth++) {
            if ($currentId === $movingId) {
                return true;
            }

            $row = Db::one('SELECT parent_id FROM folders WHERE id = ? AND user_id = ?', [$currentId, $userId]);
            if ($row === null || $row['parent_id'] === null) {
                return false; // reached the root without finding $movingId — safe
            }
            $currentId = (int) $row['parent_id'];
        }

        // Depth exceeded: either an unusually deep tree or (defensively) a
        // cycle that already exists. Refuse rather than loop forever.
        return true;
    }
}
