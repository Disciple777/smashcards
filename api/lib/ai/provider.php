<?php
declare(strict_types=1);

require_once __DIR__ . '/../config.php';

/**
 * Card generation, one interface, several providers.
 *
 * All three providers get an identical system prompt and are asked for the same
 * JSON shape, so switching provider changes cost and quality but never the
 * contract with the rest of the API. That also makes them comparable: generate
 * the same passage twice and the only variable is the model.
 */
abstract class AiProvider
{
    public function __construct(protected array $settings) {}

    /** Human-readable name, for the UI and for error messages. */
    abstract public function label(): string;

    /**
     * @return array{cards: array<int,array{0:string,1:string}>, usage: array, refused: bool}
     * @throws AiError
     */
    abstract public function extract(string $text, int $targetCards, string $depthGuidance): array;

    public function model(): string
    {
        return (string) ($this->settings['model'] ?? '');
    }

    protected function apiKey(): string
    {
        return (string) ($this->settings['api_key'] ?? '');
    }

    /** The instructions every provider receives, verbatim. */
    protected function systemPrompt(int $targetCards, string $depthGuidance): string
    {
        return <<<PROMPT
        You turn study material into flashcards.

        Rules:
        - Each card is one question and one answer. No multi-part questions.
        - Questions must be answerable from the supplied text alone.
        - Never invent facts that are not in the text.
        - Answers are short: a phrase or a sentence, not a paragraph.
        - Do not write questions about the document itself ("what does this
          passage discuss"). Ask about the subject matter.
        - Skip filler, headings, and navigation text.
        - Write the cards in the same language as the source text.

        {$depthGuidance}

        Aim for about {$targetCards} cards. Fewer is fine if the text is thin —
        quality over quantity. Never pad.

        Reply with JSON only, in exactly this shape:
        {"cards": [{"question": "...", "answer": "..."}]}
        PROMPT;
    }

    /** The JSON Schema shared by every provider that supports one. */
    protected function schema(): array
    {
        return [
            'type'       => 'object',
            'properties' => [
                'cards' => [
                    'type'  => 'array',
                    'items' => [
                        'type'       => 'object',
                        'properties' => [
                            'question' => ['type' => 'string'],
                            'answer'   => ['type' => 'string'],
                        ],
                        'required'             => ['question', 'answer'],
                        'additionalProperties' => false,
                    ],
                ],
            ],
            'required'             => ['cards'],
            'additionalProperties' => false,
        ];
    }

    /**
     * One JSON POST. Shared so every provider gets the same timeout handling
     * and the same guarantee that a key never lands in an error message.
     *
     * @param array<int,string> $headers
     */
    protected function post(string $url, array $headers, array $body): array
    {
        $payload = json_encode($body, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);

        $curl = curl_init($url);
        curl_setopt_array($curl, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $payload,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER     => array_merge(['Content-Type: application/json'], $headers),
            CURLOPT_TIMEOUT        => (int) Config::get('ai.timeout_seconds', 120),
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
            throw new AiError('the provider returned a non-JSON response', $status);
        }

        if ($status < 200 || $status >= 300) {
            throw new AiError(self::errorMessageFrom($decoded, $status), $status);
        }

        return $decoded;
    }

    /**
     * Pulls a human-readable message out of a provider's error body.
     *
     * Providers disagree about the shape: OpenAI and DeepSeek usually send
     * {"error": {"message": "..."}}, but not always — some failures come back
     * as {"error": "a plain string"}, and indexing *that* with ['message']
     * throws a TypeError. TypeError extends Error, not Exception, so it slipped
     * past every `catch (RuntimeException)` upstream and surfaced as a blank
     * 500 instead of the honest "the provider rejected its key" this is for.
     * So: only ever index into arrays, and fall back to the status code.
     */
    private static function errorMessageFrom(array $decoded, int $status): string
    {
        $error = $decoded['error'] ?? null;

        foreach ([is_array($error) ? ($error['message'] ?? null) : $error, $decoded['message'] ?? null] as $candidate) {
            if (is_string($candidate) && trim($candidate) !== '') {
                return $candidate;
            }
        }

        return "HTTP {$status}";
    }

    /**
     * Pulls the card list out of a model's JSON reply.
     *
     * Tolerant on purpose: providers without strict schema support sometimes
     * wrap JSON in prose or a ```json fence, and a single stray character
     * should not throw away a whole generation.
     */
    protected function parseCards(string $text): array
    {
        $text = trim($text);

        if (str_starts_with($text, '```')) {
            $text = preg_replace('/^```[a-z]*\s*|\s*```$/i', '', $text) ?? $text;
        }

        $decoded = json_decode($text, true);

        // Fall back to the outermost {...} if there is text around the JSON.
        if (!is_array($decoded)) {
            $start = strpos($text, '{');
            $end   = strrpos($text, '}');
            if ($start !== false && $end !== false && $end > $start) {
                $decoded = json_decode(substr($text, $start, $end - $start + 1), true);
            }
        }

        if (!is_array($decoded) || !is_array($decoded['cards'] ?? null)) {
            return [];
        }

        $cards = [];
        $seen  = [];

        foreach ($decoded['cards'] as $card) {
            if (!is_array($card)) continue;

            $question = trim((string) ($card['question'] ?? ''));
            $answer   = trim((string) ($card['answer'] ?? ''));

            if ($question === '' || $answer === '') continue;
            if (mb_strlen($question) > 2000 || mb_strlen($answer) > 2000) continue;

            // Models restate the same fact more than once on long passages.
            $key = mb_strtolower($question);
            if (isset($seen[$key])) continue;
            $seen[$key] = true;

            $cards[] = [$question, $answer];
        }

        return $cards;
    }
}

final class AiError extends RuntimeException
{
    public function __construct(string $message, public readonly int $status)
    {
        parent::__construct($message);
    }
}

/**
 * Builds the configured provider.
 *
 * Provider choice lives in config, but a request may name another *already
 * configured* provider — handy for comparing output and cost on the same text
 * without a redeploy. An unconfigured provider is never selectable.
 */
final class AiProviders
{
    public const SUPPORTED = ['anthropic', 'openai', 'deepseek'];

    public static function make(?string $requested = null): AiProvider
    {
        $name = $requested ?? (string) Config::get('ai.provider', 'anthropic');

        if (!in_array($name, self::SUPPORTED, true)) {
            throw new AiError("unknown provider '{$name}'", 400);
        }
        if (!self::isConfigured($name)) {
            throw new AiError("provider '{$name}' has no API key configured", 503);
        }

        $settings = (array) Config::get("ai.providers.{$name}", []);

        require_once __DIR__ . '/anthropic.php';
        require_once __DIR__ . '/openai.php';

        return match ($name) {
            'anthropic' => new AnthropicProvider($settings),
            'openai'    => new OpenAiProvider($settings),
            'deepseek'  => new DeepSeekProvider($settings),
        };
    }

    public static function isConfigured(string $name): bool
    {
        $key = (string) Config::get("ai.providers.{$name}.api_key", '');
        return $key !== '' && !str_starts_with($key, 'CHANGE_ME');
    }

    /** @return array<int,string> providers with a usable key */
    public static function available(): array
    {
        return array_values(array_filter(self::SUPPORTED, [self::class, 'isConfigured']));
    }

    public static function active(): ?string
    {
        $configured = (string) Config::get('ai.provider', 'anthropic');

        if (self::isConfigured($configured)) {
            return $configured;
        }

        // Falling back beats failing outright when one key is missing.
        return self::available()[0] ?? null;
    }
}
