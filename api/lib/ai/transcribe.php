<?php
declare(strict_types=1);

require_once __DIR__ . '/provider.php';

/**
 * Speech-to-text for uploaded audio.
 *
 * Separate from AiProvider on purpose: card generation has three interchangeable
 * providers, transcription realistically has one. Neither DeepSeek nor Anthropic
 * accepts audio, so an audio upload is transcribed by OpenAI and the resulting
 * transcript is then handed to whichever card-generation provider the user
 * picked. That keeps "which model writes my cards" a free choice even though
 * "which model hears my recording" is not.
 *
 * Configured, like everything else here, by the presence of a key: with no
 * OpenAI key the audio option reports itself unavailable and the UI hides it,
 * exactly as the whole AI feature does when no provider is set up.
 */
final class Transcriber
{
    /** OpenAI rejects anything larger, so we reject it first, with a clearer message. */
    public const PROVIDER_MAX_BYTES = 25 * 1024 * 1024;

    /** Formats the API accepts. Anything else is refused before it is stored. */
    public const EXTENSIONS = ['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm'];

    public static function isConfigured(): bool
    {
        return self::apiKey() !== '';
    }

    public static function model(): string
    {
        return (string) Config::get('ai.transcription.model', 'whisper-1');
    }

    public static function label(): string
    {
        return 'OpenAI (' . self::model() . ')';
    }

    /**
     * @return array{text: string, duration_seconds: ?int}
     * @throws AiError
     */
    public static function transcribe(string $path, string $filename, ?string $language = null): array
    {
        if (!self::isConfigured()) {
            throw new AiError('no transcription key configured', 503);
        }

        $fields = [
            'model' => self::model(),
            // verbose_json is the only format that reports duration, which is
            // what the per-minute quota is counted in.
            'response_format' => 'verbose_json',
            'file' => new CURLFile($path, 'application/octet-stream', $filename),
        ];

        // A language hint measurably improves accuracy and stops short clips
        // being auto-detected as the wrong language. The deck already knows it.
        if ($language !== null && $language !== '') {
            $fields['language'] = $language;
        }

        $url = rtrim((string) Config::get('ai.transcription.base_url', 'https://api.openai.com/v1'), '/')
             . '/audio/transcriptions';

        $curl = curl_init($url);
        curl_setopt_array($curl, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $fields,   // cURL builds the multipart body
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER     => ['Authorization: Bearer ' . self::apiKey()],
            CURLOPT_TIMEOUT        => (int) Config::get('ai.transcription.timeout_seconds', 300),
            CURLOPT_CONNECTTIMEOUT => 15,
        ]);

        $raw    = curl_exec($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_HTTP_CODE);
        $error  = curl_error($curl);
        curl_close($curl);

        if ($raw === false) {
            throw new AiError('unreachable: ' . $error, 0);
        }

        $decoded = json_decode((string) $raw, true);
        if (!is_array($decoded)) {
            throw new AiError('the transcription service returned a non-JSON response', $status);
        }

        if ($status < 200 || $status >= 300) {
            throw new AiError((string) ($decoded['error']['message'] ?? "HTTP {$status}"), $status);
        }

        $duration = isset($decoded['duration']) ? (int) round((float) $decoded['duration']) : null;

        return [
            'text'             => trim((string) ($decoded['text'] ?? '')),
            'duration_seconds' => $duration,
        ];
    }

    /**
     * The transcription key.
     *
     * Falls back to the OpenAI card-generation key so that a server already set
     * up for OpenAI gets audio for free, with no second key to configure — but
     * a dedicated key can still be set if the two should be billed apart.
     */
    private static function apiKey(): string
    {
        $key = (string) Config::get('ai.transcription.api_key', '');
        if ($key === '' || str_starts_with($key, 'CHANGE_ME')) {
            $key = (string) Config::get('ai.providers.openai.api_key', '');
        }

        return str_starts_with($key, 'CHANGE_ME') ? '' : $key;
    }
}
