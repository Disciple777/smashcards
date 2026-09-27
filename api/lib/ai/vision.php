<?php
declare(strict_types=1);

require_once __DIR__ . '/provider.php';

/**
 * OCR for scanned pages, by asking a vision model to read them.
 *
 * A scanned PDF has no text layer — its pages are photographs — so pdf.js
 * returns nothing and there is nothing to make cards from. The browser renders
 * each page to an image and this reads it back as text.
 *
 * A vision model rather than a bundled OCR engine: tesseract.js would mean
 * multiple megabytes of WebAssembly and language data downloaded before a
 * single page could be read, and it copes badly with the columns, tables and
 * handwriting that scanned study material is full of. This reuses the OpenAI
 * key already configured for transcription, and degrades the same way — with
 * no key, the offer is never made.
 */
final class Vision
{
    public static function isConfigured(): bool
    {
        return self::apiKey() !== '';
    }

    public static function model(): string
    {
        return (string) Config::get('ai.ocr.model', 'gpt-4o-mini');
    }

    public static function label(): string
    {
        return 'OpenAI (' . self::model() . ')';
    }

    /** How many pages one request may read, so a 600-page scan cannot run away. */
    public static function maxPages(): int
    {
        return max(1, (int) Config::get('ai.ocr.max_pages', 20));
    }

    /**
     * Reads one page image and returns its text.
     *
     * @return array{text: string, usage: array{input_tokens:int, output_tokens:int}}
     * @throws AiError
     */
    public static function readPage(string $path, string $mimeType): array
    {
        if (!self::isConfigured()) {
            throw new AiError('no OCR key configured', 503);
        }

        $bytes = file_get_contents($path);
        if ($bytes === false) {
            throw new AiError('could not read the page image', 500);
        }

        $dataUrl = 'data:' . $mimeType . ';base64,' . base64_encode($bytes);

        $body = [
            'model' => self::model(),
            'messages' => [
                [
                    'role' => 'system',
                    'content' =>
                        "You transcribe scanned pages. Reply with the page's text and nothing else.\n"
                        . "- Transcribe exactly what is written. Never summarise, correct or explain.\n"
                        . "- Keep the reading order: headings, then body, column by column.\n"
                        . "- Render a table as one line per row, cells separated by ' | '.\n"
                        . "- Skip page numbers, running headers and decorative marks.\n"
                        . "- If the page has no legible text, reply with nothing at all.",
                ],
                [
                    // The user turn carries an image part, so its content is a
                    // list of typed parts rather than the plain string used
                    // everywhere else in this codebase.
                    'role' => 'user',
                    'content' => [
                        ['type' => 'text', 'text' => 'Transcribe this page.'],
                        ['type' => 'image_url', 'image_url' => ['url' => $dataUrl]],
                    ],
                ],
            ],
            // Generous: a dense page of text can run long, and a truncated
            // transcription silently loses the bottom of the page.
            'max_tokens' => 4000,
            // Transcription is not a creative task.
            'temperature' => 0,
        ];

        $response = self::post($body);

        $text = (string) ($response['choices'][0]['message']['content'] ?? '');

        return [
            'text'  => trim($text),
            'usage' => [
                'input_tokens'  => (int) ($response['usage']['prompt_tokens'] ?? 0),
                'output_tokens' => (int) ($response['usage']['completion_tokens'] ?? 0),
            ],
        ];
    }

    private static function post(array $body): array
    {
        $url = rtrim((string) Config::get('ai.ocr.base_url', 'https://api.openai.com/v1'), '/')
             . '/chat/completions';

        $curl = curl_init($url);
        curl_setopt_array($curl, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => json_encode($body, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER     => [
                'Content-Type: application/json',
                'Authorization: Bearer ' . self::apiKey(),
            ],
            CURLOPT_TIMEOUT        => (int) Config::get('ai.ocr.timeout_seconds', 120),
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
            throw new AiError('the OCR service returned a non-JSON response', $status);
        }

        if ($status < 200 || $status >= 300) {
            // Only ever index into arrays — an error body shaped
            // {"error": "a string"} would otherwise raise a TypeError.
            $error = $decoded['error'] ?? null;
            $message = is_array($error) ? ($error['message'] ?? null) : $error;

            throw new AiError(is_string($message) && $message !== '' ? $message : "HTTP {$status}", $status);
        }

        return $decoded;
    }

    /** Falls back to the OpenAI key, like transcription does. */
    private static function apiKey(): string
    {
        $key = (string) Config::get('ai.ocr.api_key', '');
        if ($key === '' || str_starts_with($key, 'CHANGE_ME')) {
            $key = (string) Config::get('ai.providers.openai.api_key', '');
        }

        return str_starts_with($key, 'CHANGE_ME') ? '' : $key;
    }
}
