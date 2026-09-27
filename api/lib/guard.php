<?php
declare(strict_types=1);

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/response.php';

/**
 * Ownership checks for deck- and card-scoped routes.
 *
 * A deck that exists but belongs to someone else answers 404, not 403.
 * 403 would confirm the id is real, letting anyone enumerate the deck space.
 */
final class Guard
{
    /**
     * @param bool $forWrite public decks are readable by anyone, writable only by the owner
     * @return array<string,mixed> the deck row
     */
    public static function deck(int|string $deckId, int $userId, bool $forWrite = true): array
    {
        $id = self::id($deckId);

        $deck = Db::one('SELECT * FROM decks WHERE id = ?', [$id]);
        if ($deck === null) {
            Response::error('not_found', 'Deck not found.', 404);
        }

        $isOwner = (int) $deck['user_id'] === $userId;

        if ($forWrite && !$isOwner) {
            Response::error('not_found', 'Deck not found.', 404);
        }
        if (!$isOwner && (int) $deck['is_public'] !== 1) {
            Response::error('not_found', 'Deck not found.', 404);
        }

        return $deck;
    }

    /** Folders are never public — always owner-only, unlike decks. */
    public static function folder(int|string $folderId, int $userId): array
    {
        $id = self::id($folderId);

        $folder = Db::one('SELECT * FROM folders WHERE id = ?', [$id]);
        if ($folder === null || (int) $folder['user_id'] !== $userId) {
            Response::error('not_found', 'Folder not found.', 404);
        }

        return $folder;
    }

    /** @return array<string,mixed> the card row, with deck_user_id and deck_is_public attached */
    public static function card(int|string $cardId, int $userId, bool $forWrite = true): array
    {
        $id = self::id($cardId);

        $card = Db::one(
            'SELECT c.*, d.user_id AS deck_user_id, d.is_public AS deck_is_public
               FROM cards c
               JOIN decks d ON d.id = c.deck_id
              WHERE c.id = ?',
            [$id]
        );
        if ($card === null) {
            Response::error('not_found', 'Card not found.', 404);
        }

        $isOwner = (int) $card['deck_user_id'] === $userId;

        if ($forWrite && !$isOwner) {
            Response::error('not_found', 'Card not found.', 404);
        }
        if (!$isOwner && (int) $card['deck_is_public'] !== 1) {
            Response::error('not_found', 'Card not found.', 404);
        }

        return $card;
    }

    /** Route params arrive as strings; anything non-numeric is a 404, not a SQL error. */
    public static function id(int|string $value): int
    {
        if (!ctype_digit((string) $value)) {
            Response::error('not_found', 'Not found.', 404);
        }
        return (int) $value;
    }
}
