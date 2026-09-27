<?php
declare(strict_types=1);

require_once __DIR__ . '/../lib/db.php';
require_once __DIR__ . '/../lib/auth.php';
require_once __DIR__ . '/../lib/response.php';
require_once __DIR__ . '/../lib/validation.php';
require_once __DIR__ . '/../lib/ai/speech.php';

/**
 * Reading cards aloud when the device cannot.
 *
 * Returns audio rather than a URL on purpose: the cached file is not
 * web-readable, a URL would need its own signed-access story, and the browser
 * can play a blob just as happily. A cache hit costs one local file read, so
 * the extra round trip is cheaper than the redirect it replaces.
 */
final class SpeechController
{
    /** GET /v1/speech/status — whether cloud speech is available, and its budget. */
    public static function status(): never
    {
        $userId = Auth::requireUser();

        Response::json([
            'enabled'         => CloudSpeech::isConfigured(),
            'voices'          => CloudSpeech::VOICES,
            'default_voice'   => CloudSpeech::defaultVoice(),
            'max_chars'       => CloudSpeech::MAX_CHARS,
            'characters_left' => CloudSpeech::isConfigured() ? self::charactersLeft($userId) : 0,
            'monthly_quota'   => (int) Config::get('ai.tts.monthly_char_quota', 200000),
        ]);
    }

    /** POST /v1/speech — body: { text, voice?, speed? } → audio/mpeg */
    public static function speak(): never
    {
        $userId = Auth::requireUser();
        $body   = Response::body();

        if (!CloudSpeech::isConfigured()) {
            Response::error('tts_not_configured', 'Cloud speech is not set up on this server yet.', 503);
        }

        $text = trim((string) ($body['text'] ?? ''));
        if ($text === '') {
            Response::error('validation_failed', 'Nothing to read.', 422);
        }

        if (mb_strlen($text) > CloudSpeech::MAX_CHARS) {
            Response::error(
                'text_too_long',
                'That card is too long to read aloud (limit ' . CloudSpeech::MAX_CHARS . ' characters).',
                422
            );
        }

        $voice = (string) ($body['voice'] ?? CloudSpeech::defaultVoice());
        if (!in_array($voice, CloudSpeech::VOICES, true)) {
            $voice = CloudSpeech::defaultVoice();
        }

        // The API's own range. The study screen's slider is 0.5–2.
        $speed = max(0.25, min(4.0, round((float) ($body['speed'] ?? 1), 2)));

        // Checked before synthesis, but a cache hit costs nothing and is
        // allowed through even at zero remaining: re-reading a card you have
        // already paid for should never stop working mid-session.
        $remaining = self::charactersLeft($userId);

        try {
            $result = CloudSpeech::speak($userId, $text, $voice, $speed);
        } catch (AiError $e) {
            error_log('[smashcards] tts ' . $e->status . ': ' . $e->getMessage());

            $status = in_array($e->status, [429, 503, 529], true) ? 503 : 502;
            $detail = $e->status === 401
                ? 'The speech service rejected its API key.'
                : 'That card could not be read aloud.';

            Response::error('tts_failed', $detail, $status);
        } catch (Throwable $e) {
            error_log('[smashcards] tts ' . $e::class . ': ' . $e->getMessage());
            Response::error('tts_failed', 'That card could not be read aloud.', 502);
        }

        if ($result['characters'] > 0) {
            if ($result['characters'] > $remaining) {
                Response::error(
                    'quota_exceeded',
                    'You have used this month\'s read-aloud allowance.',
                    429
                );
            }
            self::recordUsage($userId, $result['characters']);
        }

        header('Content-Type: audio/mpeg');
        header('Content-Length: ' . (string) strlen($result['bytes']));
        header('X-Content-Type-Options: nosniff');
        // Private: this is the user's own deck content, rendered as audio.
        header('Cache-Control: private, max-age=86400');
        header('X-Smashcards-Cache: ' . ($result['cached'] ? 'hit' : 'miss'));

        echo $result['bytes'];
        exit;
    }

    // ------------------------------------------------------------ internals --

    private static function charactersLeft(int $userId): int
    {
        $quota = (int) Config::get('ai.tts.monthly_char_quota', 200000);

        $row = Db::one(
            'SELECT tts_characters FROM ai_usage WHERE user_id = ? AND period = ?',
            [$userId, gmdate('Y-m')]
        );

        return max(0, $quota - (int) ($row['tts_characters'] ?? 0));
    }

    private static function recordUsage(int $userId, int $characters): void
    {
        Db::run(
            'INSERT INTO ai_usage (user_id, period, tts_characters)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE tts_characters = tts_characters + VALUES(tts_characters)',
            [$userId, gmdate('Y-m'), $characters]
        );
    }
}
