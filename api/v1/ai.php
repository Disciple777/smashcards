<?php
declare(strict_types=1);

require_once __DIR__ . '/../lib/db.php';
require_once __DIR__ . '/../lib/auth.php';
require_once __DIR__ . '/../lib/guard.php';
require_once __DIR__ . '/../lib/response.php';
require_once __DIR__ . '/../lib/validation.php';
require_once __DIR__ . '/../lib/ai/provider.php';
require_once __DIR__ . '/sources.php';

/**
 * Phase 3 — turning study material into candidate cards.
 *
 * Generated cards are written with status='staged', never 'active'. They do not
 * appear in a deck's card list and are never studied until the user approves
 * them on the review screen. That is a hard rule from the roadmap: AI output is
 * never auto-committed.
 *
 * Every generation runs from a *source* (see sources.php) — an uploaded
 * document, a transcribed recording, or a pasted passage. Text posted directly
 * to this endpoint is saved as a source first, before the model is called, so
 * the material survives even when generation fails, and a card can always be
 * traced back to the paragraph it came from.
 */
final class AiController
{
    /** POST /v1/decks/{deck_id}/ai/extract */
    public static function extract(array $params): never
    {
        $userId = Auth::requireUser();
        $deck   = Guard::deck($params['deck_id'], $userId);
        $body   = Response::body();

        if (AiProviders::active() === null) {
            Response::error(
                'ai_not_configured',
                'Card generation is not set up on this server yet.',
                503
            );
        }

        $maxChars = (int) Config::get('ai.max_chars_per_request', 20000);

        // Either generate from material already saved, or from text posted here
        // — which is saved as a source before anything else happens.
        [$source, $fullText] = isset($body['source_id'])
            ? self::sourceFor($body['source_id'], $userId, (int) $deck['id'])
            : self::sourceFromPastedText($body, $userId, (int) $deck['id'], $maxChars);

        // A long document or a lecture transcript is bigger than one request
        // can carry, so a slice is taken from `offset` and the response says
        // where the next slice starts. That turns "too long, split it up
        // yourself" into a Generate-more button.
        $totalChars = mb_strlen($fullText);
        $offset     = max(0, min((int) ($body['offset'] ?? 0), max(0, $totalChars - 1)));
        $text       = trim(mb_substr($fullText, $offset, $maxChars));

        if ($text === '') {
            Response::error('source_exhausted', 'There is no more text left in that material.', 422);
        }

        // Roughly cards per 1000 words, and how deep the questions should go.
        //
        // The default is resolved once, into a variable. Testing `$body['depth']
        // ?? 'mixed'` and then *returning* `$body['depth']` read the key twice:
        // with no depth sent, the test passed on the default while the value
        // came back null, and null met a `string` parameter under strict_types
        // — a TypeError, outside any try, surfacing as a blank 500.
        $requestedDepth = (string) ($body['depth'] ?? 'mixed');

        $density = self::clamp((float) ($body['density'] ?? 8), 1, 30);
        $depth   = in_array($requestedDepth, ['recall', 'concept', 'mixed'], true)
            ? $requestedDepth
            : 'mixed';

        $requested = isset($body['provider']) ? (string) $body['provider'] : null;

        try {
            $provider = AiProviders::make($requested);
        } catch (AiError $e) {
            Response::error('provider_unavailable', $e->getMessage(), $e->status ?: 400);
        }

        $charge = mb_strlen($text);
        self::assertWithinQuota($userId, $charge);

        [$targetCards, $depthGuidance] = self::shapeRequest($text, $density, $depth);

        try {
            $result = $provider->extract($text, $targetCards, $depthGuidance);
        } catch (AiError $e) {
            // The message can contain provider detail but never a key — keys are
            // only ever sent as headers and are not echoed in errors.
            error_log('[smashcards] ai ' . $e->status . ': ' . $e->getMessage());

            // Rate limits and overload deserve an honest "retry", not a generic
            // failure that makes the user think their text was the problem.
            $status = in_array($e->status, [429, 503, 529], true) ? 503 : 502;
            $detail = $e->status === 401
                ? 'The AI provider rejected its API key.'
                : 'Card generation failed. Please try again.';
            Response::error('ai_failed', $detail, $status);
        } catch (Throwable $e) {
            // Throwable, not RuntimeException: a malformed provider reply can
            // raise a TypeError, which is an Error rather than an Exception and
            // would otherwise escape as a blank 500 telling the user nothing.
            // Whatever a provider does, the failure belongs to the provider.
            error_log('[smashcards] ai ' . $e::class . ': ' . $e->getMessage());
            Response::error('ai_failed', 'Card generation failed. Please try again.', 502);
        }

        $providerName = $requested ?? AiProviders::active();

        if ($result['refused']) {
            self::recordUsage($userId, $charge, $result['usage'], $providerName);
            Response::error('ai_refused', 'That text could not be turned into cards.', 422);
        }

        if ($result['cards'] === []) {
            self::recordUsage($userId, $charge, $result['usage'], $providerName);
            Response::error('ai_empty', 'No cards could be made from that text.', 422);
        }

        $staged = self::stage((int) $deck['id'], $result['cards'], (int) $source['id']);
        self::recordUsage($userId, $charge, $result['usage'], $providerName);

        $consumedTo = $offset + mb_strlen($text);

        Response::json([
            'staged'   => $staged,
            'provider' => ['name' => $providerName, 'label' => $provider->label()],
            'usage'    => self::usageFor($userId),
            'source'   => SourcesController::shape($source),
            // Where this generation reached, so the client can offer to carry
            // on through a document too long for a single request.
            'range'    => [
                'offset'      => $offset,
                'chars_used'  => mb_strlen($text),
                'chars_total' => $totalChars,
                'next_offset' => $consumedTo < $totalChars ? $consumedTo : null,
            ],
        ], 201);
    }

    /** GET /v1/ai/usage — what is left this month. */
    public static function usage(): never
    {
        $userId = Auth::requireUser();

        $available = AiProviders::available();

        Response::json([
            'configured' => $available !== [],
            'provider'   => AiProviders::active(),
            'providers'  => array_map(static fn(string $name): array => [
                'name'  => $name,
                'label' => AiProviders::make($name)->label(),
            ], $available),
            'usage'  => self::usageFor($userId),
            'limits' => [
                'max_chars_per_request' => (int) Config::get('ai.max_chars_per_request', 20000),
                'monthly_char_quota'    => (int) Config::get('ai.monthly_char_quota', 200000),
            ],
        ]);
    }

    /**
     * POST /v1/decks/{deck_id}/cards/approve — body: { card_ids: [...] }
     * Moves staged cards into the deck proper.
     */
    public static function approve(array $params): never
    {
        $userId = Auth::requireUser();
        $deck   = Guard::deck($params['deck_id'], $userId);
        $body   = Response::body();

        $ids = $body['card_ids'] ?? null;
        if (!is_array($ids) || $ids === []) {
            Response::error('validation_failed', 'card_ids must be a non-empty array.', 422);
        }

        $deckId   = (int) $deck['id'];
        $approved = 0;
        $pdo      = Db::conn();

        $pdo->beginTransaction();
        try {
            // Scoping the UPDATE to the deck means a card id from another deck
            // simply matches nothing, rather than being approved into this one.
            $stmt = $pdo->prepare(
                "UPDATE cards SET status = 'active'
                  WHERE id = ? AND deck_id = ? AND status = 'staged'"
            );
            foreach ($ids as $id) {
                $stmt->execute([Guard::id($id), $deckId]);
                $approved += $stmt->rowCount();
            }
            $pdo->commit();
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        Db::run('UPDATE decks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [$deckId]);

        Response::json(['approved' => $approved, 'deck_id' => $deckId]);
    }

    // ------------------------------------------------------------ internals --

    /**
     * Loads saved material to generate from.
     *
     * @return array{0: array<string,mixed>, 1: string} the source row and its text
     */
    private static function sourceFor(mixed $sourceId, int $userId, int $deckId): array
    {
        $source = SourcesController::find($sourceId, $userId);

        // A source belongs to one deck; generating from another deck's material
        // is a 404 rather than a silent cross-deck read.
        if ((int) $source['deck_id'] !== $deckId) {
            Response::error('not_found', 'Source not found.', 404);
        }

        $text = trim((string) ($source['content_text'] ?? ''));
        if ($text === '') {
            Response::error('source_empty', 'That material has no text to make cards from.', 422);
        }

        return [$source, $text];
    }

    /**
     * Saves a pasted passage as a source, then returns it.
     *
     * Saving happens before the model is called on purpose: generation can fail
     * or be refused, and losing the user's pasted chapter to a provider timeout
     * is exactly the behaviour this replaces.
     *
     * @return array{0: array<string,mixed>, 1: string}
     */
    private static function sourceFromPastedText(array $body, int $userId, int $deckId, int $maxChars): array
    {
        $text = trim((string) ($body['text'] ?? ''));

        if ($text === '') {
            Response::error('validation_failed', 'Paste some text to make cards from.', 422, [
                'text' => 'This field is required.',
            ]);
        }

        // The per-request cap still applies to a single paste; anything longer
        // belongs to the upload path, where slicing and resuming are available.
        if (mb_strlen($text) > $maxChars) {
            Response::error('text_too_long', "Send at most {$maxChars} characters at a time.", 422, [
                'text' => 'Too long — split it into smaller chunks.',
            ]);
        }

        $title = trim((string) ($body['title'] ?? ''));
        if ($title === '') {
            $firstLine = trim((string) strtok($text, "\n"));
            $title = $firstLine === '' ? 'Pasted text' : $firstLine;
        }

        $id = Db::insert(
            'INSERT INTO sources (user_id, deck_id, kind, title, byte_size, content_text)
             VALUES (?, ?, \'text\', ?, ?, ?)',
            [$userId, $deckId, mb_substr($title, 0, 255), strlen($text), $text]
        );

        $source = Db::one('SELECT * FROM sources WHERE id = ?', [$id]);

        return [$source ?? [], $text];
    }

    /**
     * Turns the request knobs into the two things every provider needs:
     * a target card count and a sentence of depth guidance.
     *
     * @return array{0:int,1:string}
     */
    private static function shapeRequest(string $text, float $density, string $depth): array
    {
        // str_word_count is byte-oriented and undercounts accented text, but
        // this only sets a soft target, so a rough figure is good enough.
        $wordCount = max(1, str_word_count(strip_tags($text)));
        $target    = (int) max(1, min(60, round(($wordCount / 1000) * $density)));

        $guidance = match ($depth) {
            'recall'  => 'Favour direct factual recall: definitions, dates, names, formulas.',
            'concept' => 'Favour conceptual understanding: why something happens, how ideas relate, '
                       . 'what follows from a principle. Avoid trivia.',
            default   => 'Mix factual recall with a few conceptual questions.',
        };

        return [$target, $guidance];
    }

    /** @return array<int,array<string,mixed>> the staged card rows */
    private static function stage(int $deckId, array $candidates, ?int $sourceId = null): array
    {
        $row      = Db::one('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM cards WHERE deck_id = ?', [$deckId]);
        $position = (int) $row['next'];
        $ids      = [];
        $pdo      = Db::conn();

        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare(
                "INSERT INTO cards (deck_id, question_text, answer_text, source_type, source_id, status, position)
                 VALUES (?, ?, ?, 'ai', ?, 'staged', ?)"
            );
            foreach ($candidates as [$question, $answer]) {
                $stmt->execute([$deckId, $question, $answer, $sourceId, $position++]);
                $ids[] = (int) $pdo->lastInsertId();
            }
            $pdo->commit();
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        require_once __DIR__ . '/cards.php';

        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $rows = Db::all("SELECT * FROM cards WHERE id IN ($placeholders) ORDER BY position ASC", $ids);

        return array_map([CardsController::class, 'shape'], $rows);
    }

    private static function assertWithinQuota(int $userId, int $charge): void
    {
        $quota = (int) Config::get('ai.monthly_char_quota', 200000);
        $used  = self::usageFor($userId)['characters_used'];

        if ($used + $charge > $quota) {
            Response::error(
                'quota_exceeded',
                'You have used this month\'s card generation allowance.',
                429,
                ['remaining' => (string) max(0, $quota - $used)]
            );
        }
    }

    private static function recordUsage(int $userId, int $charge, array $usage, ?string $provider): void
    {
        // A single UPSERT so concurrent requests cannot lose an increment.
        // last_provider is informational: which provider was billed most recently.
        Db::run(
            'INSERT INTO ai_usage (user_id, period, characters_used, requests, input_tokens, output_tokens, last_provider)
             VALUES (?, ?, ?, 1, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               characters_used = characters_used + VALUES(characters_used),
               requests        = requests + 1,
               input_tokens    = input_tokens + VALUES(input_tokens),
               output_tokens   = output_tokens + VALUES(output_tokens),
               last_provider   = VALUES(last_provider)',
            [
                $userId,
                self::period(),
                $charge,
                (int) ($usage['input_tokens'] ?? 0),
                (int) ($usage['output_tokens'] ?? 0),
                $provider,
            ]
        );
    }

    private static function usageFor(int $userId): array
    {
        $row = Db::one(
            'SELECT characters_used, requests FROM ai_usage WHERE user_id = ? AND period = ?',
            [$userId, self::period()]
        );

        $quota = (int) Config::get('ai.monthly_char_quota', 200000);
        $used  = (int) ($row['characters_used'] ?? 0);

        return [
            'period'           => self::period(),
            'characters_used'  => $used,
            'characters_left'  => max(0, $quota - $used),
            'requests'         => (int) ($row['requests'] ?? 0),
            'monthly_quota'    => $quota,
        ];
    }

    private static function period(): string
    {
        return gmdate('Y-m');
    }

    private static function clamp(float $value, float $min, float $max): float
    {
        return max($min, min($max, $value));
    }
}
