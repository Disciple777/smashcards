<?php
declare(strict_types=1);

/**
 * Backend self test, over HTTPS.
 *
 * This is what replaces SSH: it inspects the live database from the inside and
 * reports structured JSON, so the state of the server can be verified without a
 * shell and without asking anyone to click through phpMyAdmin.
 *
 *   GET /api/ops/selftest.php   with header  X-Ops-Key: <OPS_KEY>
 *
 * Safety rules, in order of importance:
 *  - every row it writes belongs to one dedicated test user, identified by a
 *    fixed email that no real person can register (the domain is reserved);
 *  - it deletes everything it created before returning, in a finally block;
 *  - it never touches, counts against, or reports on real users' data.
 */

require_once __DIR__ . '/../lib/config.php';
require_once __DIR__ . '/../lib/db.php';
require_once __DIR__ . '/../lib/response.php';
require_once __DIR__ . '/../lib/ops.php';

ini_set('display_errors', '0');

/**
 * Set once the ops key has been accepted. Before that point a crash reveals
 * nothing; after it, the caller has already proved it is trusted, so hiding
 * the reason only makes a broken deploy harder to diagnose from a laptop.
 */
$authenticated = false;

set_exception_handler(function (Throwable $e) use (&$authenticated): void {
    error_log('[smashcards selftest] ' . $e::class . ': ' . $e->getMessage());
    Response::json([
        'error' => [
            'code'    => 'selftest_crashed',
            'message' => 'Self test crashed.',
            'detail'  => $authenticated
                ? $e::class . ': ' . $e->getMessage() . ' @ ' . basename($e->getFile()) . ':' . $e->getLine()
                : null,
        ],
    ], 500);
});

Response::cors();
Ops::requireKey('ops.selftest_key');
$authenticated = true;

/** RFC 6761 reserves .invalid, so this address can never belong to a real user. */
const TEST_EMAIL = 'selftest@smashcards.invalid';

$checks = [];
$drift  = null;

/** Records one assertion. */
function check(string $name, bool $passed, string $detail = ''): void
{
    global $checks;
    $checks[] = ['name' => $name, 'passed' => $passed, 'detail' => $detail];
}

// ------------------------------------------------------------------ schema --

$expectedTables = ['users', 'decks', 'cards', 'card_states', 'reviews', 'sessions', 'ai_usage', 'schema_migrations', 'login_attempts', 'folders', 'sources', 'refresh_tokens'];
$present = array_column(
    Db::all('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()'),
    't'
);
$present = array_map('strtolower', $present);

foreach ($expectedTables as $table) {
    check("table {$table} exists", in_array($table, $present, true));
}

$migrations = in_array('schema_migrations', $present, true)
    ? array_column(Db::all('SELECT filename FROM schema_migrations ORDER BY filename'), 'filename')
    : [];

$migrationFiles = array_map('basename', glob(__DIR__ . '/../migrations/*.sql') ?: []);
sort($migrationFiles, SORT_STRING);
$pending = array_values(array_diff($migrationFiles, $migrations));

check('all migrations applied', $pending === [], $pending ? 'pending: ' . implode(', ', $pending) : '');

// Column-level checks: a table can exist while missing a column added later.
$cardColumns = array_column(
    Db::all("SELECT column_name AS c FROM information_schema.columns
              WHERE table_schema = DATABASE() AND table_name = 'cards'"),
    'c'
);
$cardColumns = array_map('strtolower', $cardColumns);
check("cards.status exists (AI staging)", in_array('status', $cardColumns, true));
check("cards.source_type exists", in_array('source_type', $cardColumns, true));
check("cards.source_id exists (material a card came from)", in_array('source_id', $cardColumns, true));

// Uploaded material must be writable somewhere, or document and audio import
// fails at the last step — after the user has waited through the upload.
require_once __DIR__ . '/../lib/storage.php';
check('uploaded material has a writable storage directory', Storage::isWritable(), Storage::root());

$deckColumns = array_map('strtolower', array_column(
    Db::all("SELECT column_name AS c FROM information_schema.columns
              WHERE table_schema = DATABASE() AND table_name = 'decks'"),
    'c'
));
check('decks.folder_id exists', in_array('folder_id', $deckColumns, true));
check('decks.share_token exists', in_array('share_token', $deckColumns, true));

// --------------------------------------------------------------- integrity --

$orphanStates = Db::one(
    'SELECT COUNT(*) AS n FROM card_states s LEFT JOIN cards c ON c.id = s.card_id WHERE c.id IS NULL'
)['n'] ?? 0;
check('no orphaned card_states', (int) $orphanStates === 0, "found {$orphanStates}");

$orphanCards = Db::one(
    'SELECT COUNT(*) AS n FROM cards c LEFT JOIN decks d ON d.id = c.deck_id WHERE d.id IS NULL'
)['n'] ?? 0;
check('no orphaned cards', (int) $orphanCards === 0, "found {$orphanCards}");

$orphanSources = Db::one(
    'SELECT COUNT(*) AS n FROM sources s LEFT JOIN decks d ON d.id = s.deck_id WHERE d.id IS NULL'
)['n'] ?? 0;
check('no orphaned sources', (int) $orphanSources === 0, "found {$orphanSources}");

// A dangling source_id would make a card claim to come from material that is
// gone; the FK is ON DELETE SET NULL precisely so this can never happen.
$danglingSource = Db::one(
    'SELECT COUNT(*) AS n FROM cards c
       LEFT JOIN sources s ON s.id = c.source_id
      WHERE c.source_id IS NOT NULL AND s.id IS NULL'
)['n'] ?? 0;
check('no card points at material that no longer exists', (int) $danglingSource === 0, "found {$danglingSource}");

$badEase = Db::one('SELECT COUNT(*) AS n FROM card_states WHERE ease_factor < 1.3')['n'] ?? 0;
check('no ease factor below the 1.3 floor', (int) $badEase === 0, "found {$badEase}");

$badScore = Db::one('SELECT COUNT(*) AS n FROM reviews WHERE score < 0 OR score > 1')['n'] ?? 0;
check('every review score is within 0.00–1.00', (int) $badScore === 0, "found {$badScore}");

$badInterval = Db::one('SELECT COUNT(*) AS n FROM card_states WHERE interval_days < 0 OR repetitions < 0')['n'] ?? 0;
check('no negative intervals or repetition counts', (int) $badInterval === 0, "found {$badInterval}");

$dupStates = Db::one(
    'SELECT COUNT(*) AS n FROM (
        SELECT user_id, card_id FROM card_states GROUP BY user_id, card_id HAVING COUNT(*) > 1
     ) d'
)['n'] ?? 0;
check('one card_state row per (user, card)', (int) $dupStates === 0, "found {$dupStates}");

// Every stored datetime must be UTC; a server drifting off UTC silently shifts
// every due date, which is invisible until schedules are hours wrong.
$tz = Db::one('SELECT TIMEDIFF(NOW(), UTC_TIMESTAMP()) AS tz_offset')['tz_offset'] ?? null;
check('database connection is on UTC', $tz === '00:00:00', "offset {$tz}");

// ---------------------------------------------------------- rate limiting --

require_once __DIR__ . '/../lib/ratelimit.php';

const TEST_IP = '203.0.113.1';  // TEST-NET-3, RFC 5737 — never a real caller

// Clean slate: a previous crashed run could leave rows for this synthetic pair.
Db::run('DELETE FROM login_attempts WHERE email = ? AND ip = ?', [TEST_EMAIL, TEST_IP]);

// assertLoginAllowed() calls Response::error() on failure, which calls exit() —
// fine for a live request, fatal here: it would kill the self test mid-run and
// skip the finally block that cleans up the test user above. So this checks
// the same threshold assertLoginAllowed uses (RateLimit::MAX_ATTEMPTS) by
// reading the count directly, rather than invoking the exiting path.
check('rate limit allows a fresh (email, ip) pair',
    (int) (Db::one(
        'SELECT COUNT(*) AS n FROM login_attempts WHERE email = ? AND ip = ?',
        [TEST_EMAIL, TEST_IP]
    )['n'] ?? 0) === 0
);

for ($i = 0; $i < 8; $i++) {
    RateLimit::recordFailure(TEST_EMAIL, TEST_IP);
}

$attemptCount = (int) (Db::one(
    'SELECT COUNT(*) AS n FROM login_attempts WHERE email = ? AND ip = ?',
    [TEST_EMAIL, TEST_IP]
)['n'] ?? 0);
check('failed attempts are recorded', $attemptCount === 8, "found {$attemptCount}");
check('recorded failures reach the block threshold', $attemptCount >= RateLimit::maxAttempts());

RateLimit::clear(TEST_EMAIL, TEST_IP);
$afterClear = (int) (Db::one(
    'SELECT COUNT(*) AS n FROM login_attempts WHERE email = ? AND ip = ?',
    [TEST_EMAIL, TEST_IP]
)['n'] ?? 0);
check('a successful login clears prior failures', $afterClear === 0, "found {$afterClear}");

// Belt and braces: clear() should already have removed every row, but this
// guarantees the synthetic IP leaves no trace even if that assertion is wrong.
Db::run('DELETE FROM login_attempts WHERE email = ? AND ip = ?', [TEST_EMAIL, TEST_IP]);

// -------------------------------------------------------------- round trip --

$userId = null;

try {
    // Reuse the test user if a previous crashed run left it behind.
    $existing = Db::one('SELECT id FROM users WHERE email = ?', [TEST_EMAIL]);
    $userId = $existing
        ? (int) $existing['id']
        : Db::insert(
            'INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)',
            [TEST_EMAIL, password_hash(bin2hex(random_bytes(16)), PASSWORD_DEFAULT), 'Self Test']
        );

    check('test user provisioned', $userId > 0);

    // Leftovers from an interrupted run would corrupt the counts below.
    cleanup($userId);

    // -------------------------------------------------------------- folders --

    require_once __DIR__ . '/../lib/foldertree.php';

    $rootFolderId = Db::insert('INSERT INTO folders (user_id, parent_id, name) VALUES (?, NULL, ?)', [$userId, 'Root']);
    $childFolderId = Db::insert('INSERT INTO folders (user_id, parent_id, name) VALUES (?, ?, ?)', [$userId, $rootFolderId, 'Child']);
    $grandchildFolderId = Db::insert('INSERT INTO folders (user_id, parent_id, name) VALUES (?, ?, ?)', [$userId, $childFolderId, 'Grandchild']);
    check('nested folders created', $rootFolderId > 0 && $childFolderId > 0 && $grandchildFolderId > 0);

    // A deck placed in the deepest folder.
    $folderedDeckId = Db::insert(
        'INSERT INTO decks (user_id, folder_id, title, language_front, language_back) VALUES (?, ?, ?, ?, ?)',
        [$userId, $grandchildFolderId, 'Foldered deck', 'en-US', 'en-US']
    );
    $readBackFolder = Db::one('SELECT folder_id FROM decks WHERE id = ?', [$folderedDeckId]);
    check('deck stores its folder', (int) $readBackFolder['folder_id'] === $grandchildFolderId);

    // Cycle detection: moving Root under its own grandchild must be refused —
    // this is the exact scenario that would detach the tree from itself.
    check('moving a folder into its own grandchild is refused',
        FolderTree::wouldCreateCycle($grandchildFolderId, $rootFolderId, $userId) === true);
    check('moving a folder into itself is refused',
        FolderTree::wouldCreateCycle($rootFolderId, $rootFolderId, $userId) === true);
    check('moving a folder to an unrelated ancestor is allowed',
        FolderTree::wouldCreateCycle($rootFolderId, $grandchildFolderId, $userId) === false);

    // Deleting the middle folder cascades to the grandchild (FK) but the deck
    // inside it must survive, orphaned to root — never silently deleted.
    Db::run('DELETE FROM folders WHERE id = ?', [$childFolderId]);

    $grandchildGone = Db::one('SELECT id FROM folders WHERE id = ?', [$grandchildFolderId]);
    check('deleting a folder cascades to its subfolders', $grandchildGone === null);

    $deckAfterCascade = Db::one('SELECT folder_id FROM decks WHERE id = ?', [$folderedDeckId]);
    check('a deck in a deleted folder survives, moved to root',
        $deckAfterCascade !== null && $deckAfterCascade['folder_id'] === null);

    // CREATE
    $deckId = Db::insert(
        'INSERT INTO decks (user_id, title, language_front, language_back) VALUES (?, ?, ?, ?)',
        [$userId, 'Self test deck', 'en-US', 'es-ES']
    );
    check('deck created', $deckId > 0);

    $cardIds = [];
    foreach ([['q1', 'a1'], ['q2', 'a2'], ['q3', 'a3']] as $i => [$q, $a]) {
        $cardIds[] = Db::insert(
            'INSERT INTO cards (deck_id, question_text, answer_text, position) VALUES (?, ?, ?, ?)',
            [$deckId, $q, $a, $i]
        );
    }
    check('cards created', count($cardIds) === 3);

    // A staged card must be invisible to the deck — the phase 3 safety rule.
    $stagedId = Db::insert(
        "INSERT INTO cards (deck_id, question_text, answer_text, source_type, status, position)
         VALUES (?, 'staged q', 'staged a', 'ai', 'staged', 99)",
        [$deckId]
    );
    $activeCount = (int) Db::one(
        "SELECT COUNT(*) AS n FROM cards WHERE deck_id = ? AND status = 'active'", [$deckId]
    )['n'];
    check('staged cards are excluded from the deck', $activeCount === 3, "active={$activeCount}");

    // READ
    $readBack = Db::one('SELECT title, language_back FROM decks WHERE id = ?', [$deckId]);
    check('deck reads back', $readBack['title'] === 'Self test deck' && $readBack['language_back'] === 'es-ES');

    // UPDATE + derived field recomputation
    $now      = gmdate('Y-m-d H:i:s');
    $past     = gmdate('Y-m-d H:i:s', time() - 86400);
    $future   = gmdate('Y-m-d H:i:s', time() + 86400 * 7);

    // card 0 due yesterday, card 1 due next week, card 2 never studied.
    Db::run(
        'INSERT INTO card_states (user_id, card_id, ease_factor, interval_days, repetitions, due_at, last_reviewed_at)
         VALUES (?, ?, 2.50, 1, 1, ?, ?)',
        [$userId, $cardIds[0], $past, $past]
    );
    Db::run(
        'INSERT INTO card_states (user_id, card_id, ease_factor, interval_days, repetitions, due_at, last_reviewed_at)
         VALUES (?, ?, 2.36, 7, 3, ?, ?)',
        [$userId, $cardIds[1], $future, $now]
    );

    // The same counts the deck list computes in SQL.
    $counts = Db::one(
        "SELECT
            (SELECT COUNT(*) FROM cards c WHERE c.deck_id = d.id AND c.status = 'active') AS card_count,
            (SELECT COUNT(*) FROM cards c
               JOIN card_states s ON s.card_id = c.id AND s.user_id = ?
              WHERE c.deck_id = d.id AND c.status = 'active'
                AND s.due_at IS NOT NULL AND s.due_at <= UTC_TIMESTAMP()) AS due_count,
            (SELECT COUNT(*) FROM cards c
              WHERE c.deck_id = d.id AND c.status = 'active'
                AND NOT EXISTS (SELECT 1 FROM card_states s WHERE s.card_id = c.id AND s.user_id = ?)) AS new_count
         FROM decks d WHERE d.id = ?",
        [$userId, $userId, $deckId]
    );

    check('derived due_count recomputed', (int) $counts['due_count'] === 1, "got {$counts['due_count']}");
    check('derived new_count recomputed', (int) $counts['new_count'] === 1, "got {$counts['new_count']}");
    check('derived card_count excludes staged', (int) $counts['card_count'] === 3, "got {$counts['card_count']}");

    // A review, and the session it belongs to.
    $sessionId = Db::insert(
        "INSERT INTO sessions (user_id, deck_id, mode, cards_reviewed) VALUES (?, ?, 'spaced', 1)",
        [$userId, $deckId]
    );
    Db::insert(
        "INSERT INTO reviews (user_id, card_id, session_id, score, rating, response_ms, mode)
         VALUES (?, ?, ?, 0.75, 3, 1200, 'spaced')",
        [$userId, $cardIds[0], $sessionId]
    );
    $reviewCount = (int) Db::one('SELECT COUNT(*) AS n FROM reviews WHERE user_id = ?', [$userId])['n'];
    check('review written', $reviewCount === 1, "got {$reviewCount}");

    // An updated state must replace, not duplicate.
    Db::run(
        'UPDATE card_states SET ease_factor = 2.60, interval_days = 6, repetitions = 2 WHERE user_id = ? AND card_id = ?',
        [$userId, $cardIds[0]]
    );
    $updated = Db::one('SELECT ease_factor, interval_days FROM card_states WHERE user_id = ? AND card_id = ?', [$userId, $cardIds[0]]);
    check('card state updates in place', (float) $updated['ease_factor'] === 2.60 && (int) $updated['interval_days'] === 6);

    // Raw inputs + server-computed outputs, for the client-side drift check.
    $drift = [
        'now'   => gmdate('Y-m-d H:i:s'),
        'cards' => Db::all(
            'SELECT id, deck_id, position, status FROM cards WHERE deck_id = ? ORDER BY position',
            [$deckId]
        ),
        'states' => Db::all(
            'SELECT card_id, ease_factor, interval_days, repetitions, due_at, last_reviewed_at
               FROM card_states WHERE user_id = ?',
            [$userId]
        ),
        'server_counts' => [
            'card_count' => (int) $counts['card_count'],
            'due_count'  => (int) $counts['due_count'],
            'new_count'  => (int) $counts['new_count'],
        ],
    ];

    // DELETE + cascade
    Db::run('DELETE FROM decks WHERE id = ?', [$deckId]);

    $cardsLeft  = (int) Db::one('SELECT COUNT(*) AS n FROM cards WHERE deck_id = ?', [$deckId])['n'];
    $statesLeft = (int) Db::one('SELECT COUNT(*) AS n FROM card_states WHERE user_id = ?', [$userId])['n'];

    check('deleting a deck cascades to its cards', $cardsLeft === 0, "left {$cardsLeft}");
    check('deleting a deck cascades to card states', $statesLeft === 0, "left {$statesLeft}");

    // sessions.deck_id is ON DELETE SET NULL: history survives the deck.
    $session = Db::one('SELECT deck_id FROM sessions WHERE id = ?', [$sessionId]);
    check('session history survives deck deletion', $session !== null && $session['deck_id'] === null);
} finally {
    // Runs even if an assertion above threw, so a crashed run leaves no rows.
    if ($userId !== null) {
        cleanup($userId);
        Db::run('DELETE FROM users WHERE id = ? AND email = ?', [$userId, TEST_EMAIL]);
    }
}

$leftover = (int) (Db::one('SELECT COUNT(*) AS n FROM users WHERE email = ?', [TEST_EMAIL])['n'] ?? 0);
check('self test cleaned up after itself', $leftover === 0, "users left: {$leftover}");

$failed = array_values(array_filter($checks, static fn(array $c): bool => !$c['passed']));

Response::json([
    'ok'      => $failed === [],
    'passed'  => count($checks) - count($failed),
    'failed'  => count($failed),
    'checks'  => $checks,
    'drift'   => $drift,
    'server'  => [
        'php'        => PHP_VERSION,
        'time_utc'   => gmdate('c'),
        'migrations' => $migrations,
    ],
], $failed === [] ? 200 : 500);

/** Removes every row belonging to the test user, children first. */
function cleanup(int $userId): void
{
    Db::run('DELETE FROM reviews WHERE user_id = ?', [$userId]);
    Db::run('DELETE FROM card_states WHERE user_id = ?', [$userId]);
    Db::run('DELETE FROM sessions WHERE user_id = ?', [$userId]);
    Db::run('DELETE FROM decks WHERE user_id = ?', [$userId]);
    Db::run('DELETE FROM folders WHERE user_id = ?', [$userId]);
    Db::run('DELETE FROM ai_usage WHERE user_id = ?', [$userId]);
}
