<?php
declare(strict_types=1);

/**
 * Front controller. Everything under /api/ is rewritten here by .htaccess.
 * Works at the domain root or under a subdirectory (e.g. /smashcards/api).
 */

require_once __DIR__ . '/lib/config.php';
require_once __DIR__ . '/lib/response.php';
require_once __DIR__ . '/lib/router.php';

// JSON only: never leak a PHP warning into a response body.
ini_set('display_errors', '0');
error_reporting(E_ALL);

set_exception_handler(function (Throwable $e): void {
    error_log(sprintf('[smashcards] %s: %s in %s:%d', $e::class, $e->getMessage(), $e->getFile(), $e->getLine()));
    $detail = Config::isProduction() ? 'An unexpected error occurred.' : $e->getMessage();
    Response::error('server_error', $detail, 500);
});

Response::cors();

$root = fn() => Response::json(['name' => 'smashcards api', 'version' => 'v1', 'status' => 'ok']);

$auth  = function (string $method): callable {
    return function (array $params) use ($method): never {
        require_once __DIR__ . '/v1/auth.php';
        AuthController::$method($params);
    };
};
$decks = function (string $method): callable {
    return function (array $params) use ($method): never {
        require_once __DIR__ . '/v1/decks.php';
        DecksController::$method($params);
    };
};
$cards = function (string $method): callable {
    return function (array $params) use ($method): never {
        require_once __DIR__ . '/v1/cards.php';
        CardsController::$method($params);
    };
};
$ai = function (string $method): callable {
    return function (array $params) use ($method): never {
        require_once __DIR__ . '/v1/ai.php';
        AiController::$method($params);
    };
};
$sessions = function (string $method): callable {
    return function (array $params) use ($method): never {
        require_once __DIR__ . '/v1/sessions.php';
        SessionsController::$method($params);
    };
};
$reviews = function (string $method): callable {
    return function (array $params) use ($method): never {
        require_once __DIR__ . '/v1/reviews.php';
        ReviewsController::$method($params);
    };
};
$folders = function (string $method): callable {
    return function (array $params) use ($method): never {
        require_once __DIR__ . '/v1/folders.php';
        FoldersController::$method($params);
    };
};
$sources = function (string $method): callable {
    return function (array $params) use ($method): never {
        require_once __DIR__ . '/v1/sources.php';
        SourcesController::$method($params);
    };
};
$speech = function (string $method): callable {
    return function (array $params) use ($method): never {
        require_once __DIR__ . '/v1/speech.php';
        SpeechController::$method($params);
    };
};

$router = new Router();

$router
    ->add('GET', '/', $root)
    ->add('GET', '/v1', $root)
    ->add('GET', '/v1/health', function (): never {
        require_once __DIR__ . '/lib/db.php';
        Db::conn()->query('SELECT 1');
        Response::json(['status' => 'ok', 'database' => 'connected', 'time' => gmdate('c')]);
    })

    // auth
    ->add('POST',   '/v1/auth/register', $auth('register'))
    ->add('POST',   '/v1/auth/login',    $auth('login'))
    ->add('POST',   '/v1/auth/refresh',    $auth('refresh'))
    ->add('POST',   '/v1/auth/logout',     $auth('logout'))
    ->add('POST',   '/v1/auth/logout-all', $auth('logoutAll'))
    ->add('GET',    '/v1/auth/me',         $auth('me'))

    // folders
    ->add('GET',    '/v1/folders',      $folders('index'))
    ->add('POST',   '/v1/folders',      $folders('store'))
    ->add('PATCH',  '/v1/folders/{id}', $folders('update'))
    ->add('DELETE', '/v1/folders/{id}', $folders('destroy'))

    // decks
    // /v1/decks/public must be registered before /v1/decks/{id} — the router
    // dispatches on the first pattern that matches, and {id} (a wildcard
    // segment) would otherwise capture "public" as an id and 404 in show().
    ->add('GET',    '/v1/decks/public', $decks('publicIndex'))
    ->add('GET',    '/v1/decks',      $decks('index'))
    ->add('POST',   '/v1/decks',      $decks('store'))
    ->add('GET',    '/v1/decks/{id}', $decks('show'))
    ->add('PATCH',  '/v1/decks/{id}', $decks('update'))
    ->add('DELETE', '/v1/decks/{id}', $decks('destroy'))
    ->add('POST',   '/v1/decks/{id}/clone', $decks('clone'))
    ->add('POST',   '/v1/decks/{id}/share', $decks('share'))
    ->add('DELETE', '/v1/decks/{id}/share', $decks('unshare'))

    // shared decks — reached by an unguessable link, not by id
    ->add('GET',    '/v1/shared/{token}',       $decks('showShared'))
    ->add('POST',   '/v1/shared/{token}/clone', $decks('cloneShared'))

    // cards, deck-scoped
    ->add('GET',    '/v1/decks/{deck_id}/cards',         $cards('index'))
    ->add('POST',   '/v1/decks/{deck_id}/cards',         $cards('store'))
    ->add('POST',   '/v1/decks/{deck_id}/cards/bulk',    $cards('bulkStore'))
    ->add('PATCH',  '/v1/decks/{deck_id}/cards/reorder', $cards('reorder'))

    // AI extraction (phase 3)
    ->add('GET',    '/v1/ai/usage',                      $ai('usage'))
    ->add('POST',   '/v1/decks/{deck_id}/ai/extract',    $ai('extract'))
    ->add('POST',   '/v1/decks/{deck_id}/cards/approve', $ai('approve'))

    // study sources — uploaded documents, audio, and saved pasted text.
    // /v1/sources/limits before /v1/sources/{id}, for the same reason
    // /v1/decks/public comes before /v1/decks/{id}: first match wins.
    ->add('GET',    '/v1/sources/limits',            $sources('limits'))
    ->add('GET',    '/v1/decks/{deck_id}/sources',   $sources('index'))
    ->add('POST',   '/v1/decks/{deck_id}/sources',   $sources('store'))
    ->add('GET',    '/v1/sources/{id}',              $sources('show'))
    ->add('GET',    '/v1/sources/{id}/file',         $sources('download'))
    ->add('DELETE', '/v1/sources/{id}',              $sources('destroy'))

    // cloud text-to-speech, for languages the device has no voice for
    ->add('GET',    '/v1/speech/status', $speech('status'))
    ->add('POST',   '/v1/speech',        $speech('speak'))

    // cards, by id
    ->add('GET',    '/v1/cards/{id}', $cards('show'))
    ->add('PATCH',  '/v1/cards/{id}', $cards('update'))
    ->add('DELETE', '/v1/cards/{id}', $cards('destroy'))

    // study: scheduling state, sessions, reviews
    ->add('GET',    '/v1/decks/{deck_id}/states', $reviews('statesForDeck'))
    ->add('POST',   '/v1/reviews',                $reviews('store'))
    ->add('GET',    '/v1/sessions',               $sessions('index'))
    ->add('POST',   '/v1/sessions',               $sessions('store'))
    ->add('GET',    '/v1/sessions/{id}',          $sessions('show'))
    ->add('PATCH',  '/v1/sessions/{id}',          $sessions('update'));

$router->dispatch(strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET'), Router::path());
