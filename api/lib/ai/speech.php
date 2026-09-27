<?php
declare(strict_types=1);

require_once __DIR__ . '/provider.php';
require_once __DIR__ . '/../storage.php';

/**
 * Cloud text-to-speech, cached.
 *
 * Browser speech can only read languages the device has a voice installed for,
 * and that set is much smaller than people expect — a Windows machine usually
 * ships voices for its display language and nothing else, so a French deck on
 * an English machine is read by an English voice, in an English accent, or not
 * at all. Nothing in the app can fix that, because the voices simply are not
 * there. This removes the device from the question.
 *
 * Every synthesis is cached on disk, keyed by a hash of everything that affects
 * the audio. Flashcards are read over and over, so after the first pass a deck
 * costs nothing further and plays back instantly from local storage.
 */
final class CloudSpeech
{
    /** The voices the API offers. Each one speaks every supported language. */
    public const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];

    /** Long enough for any sensible card; a whole chapter is not a card. */
    public const MAX_CHARS = 1200;

    public static function isConfigured(): bool
    {
        return self::apiKey() !== '';
    }

    public static function model(): string
    {
        return (string) Config::get('ai.tts.model', 'tts-1');
    }

    public static function defaultVoice(): string
    {
        $voice = (string) Config::get('ai.tts.voice', 'alloy');

        return in_array($voice, self::VOICES, true) ? $voice : 'alloy';
    }

    /**
     * Returns MP3 bytes for the text, synthesising only on a cache miss.
     *
     * @return array{bytes: string, cached: bool, characters: int}
     * @throws AiError
     */
    public static function speak(int $userId, string $text, string $voice, float $speed): array
    {
        $key = self::cacheKey($userId, $text, $voice, $speed);

        if (Storage::exists($key)) {
            $bytes = @file_get_contents(Storage::pathFor($key));
            if ($bytes !== false && $bytes !== '') {
                return ['bytes' => $bytes, 'cached' => true, 'characters' => 0];
            }
        }

        $bytes = self::synthesise($text, $voice, $speed);

        try {
            Storage::write($key, $bytes);
        } catch (RuntimeException $e) {
            // A cache that cannot be written is a performance problem, not a
            // correctness one — the audio is already in hand.
            error_log('[smashcards] tts cache write failed: ' . $e->getMessage());
        }

        return ['bytes' => $bytes, 'cached' => false, 'characters' => mb_strlen($text)];
    }

    /**
     * Everything that changes the audio goes into the key.
     *
     * Scoped per user rather than shared: identical text really would produce
     * identical audio, but a shared cache makes "has anyone else ever
     * synthesised this exact sentence" observable through timing, and audio
     * files are small enough that the saving is not worth the question.
     */
    private static function cacheKey(int $userId, string $text, string $voice, float $speed): string
    {
        $hash = hash('sha256', implode("\0", [self::model(), $voice, (string) $speed, $text]));

        return "tts/{$userId}/{$hash}.mp3";
    }

    private static function synthesise(string $text, string $voice, float $speed): string
    {
        if (!self::isConfigured()) {
            throw new AiError('no speech key configured', 503);
        }

        $url = rtrim((string) Config::get('ai.tts.base_url', 'https://api.openai.com/v1'), '/')
             . '/audio/speech';

        $curl = curl_init($url);
        curl_setopt_array($curl, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => json_encode([
                'model'           => self::model(),
                'input'           => $text,
                'voice'           => $voice,
                'speed'           => $speed,
                'response_format' => 'mp3',
            ], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER     => [
                'Content-Type: application/json',
                'Authorization: Bearer ' . self::apiKey(),
            ],
            CURLOPT_TIMEOUT        => (int) Config::get('ai.tts.timeout_seconds', 60),
            CURLOPT_CONNECTTIMEOUT => 15,
        ]);

        $raw    = curl_exec($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_HTTP_CODE);
        $error  = curl_error($curl);
        curl_close($curl);

        if ($raw === false) {
            throw new AiError('unreachable: ' . $error, 0);
        }

        if ($status < 200 || $status >= 300) {
            // A failure comes back as JSON even though success is binary.
            $decoded = json_decode((string) $raw, true);
            $detail  = is_array($decoded) ? ($decoded['error']['message'] ?? null) : null;

            throw new AiError(is_string($detail) && $detail !== '' ? $detail : "HTTP {$status}", $status);
        }

        // A JSON body on a 2xx means the API reported something instead of
        // sending audio; treating it as MP3 would hand the browser garbage.
        if ($raw === '' || str_starts_with(ltrim($raw), '{')) {
            throw new AiError('the speech service returned no audio', 502);
        }

        return $raw;
    }

    /** Falls back to the OpenAI key, like transcription and OCR. */
    private static function apiKey(): string
    {
        $key = (string) Config::get('ai.tts.api_key', '');
        if ($key === '' || str_starts_with($key, 'CHANGE_ME')) {
            $key = (string) Config::get('ai.providers.openai.api_key', '');
        }

        return str_starts_with($key, 'CHANGE_ME') ? '' : $key;
    }
}
