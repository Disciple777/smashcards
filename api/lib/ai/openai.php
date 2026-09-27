<?php
declare(strict_types=1);

require_once __DIR__ . '/provider.php';

/**
 * Providers that speak the OpenAI chat-completions protocol.
 *
 * DeepSeek deliberately mirrors that API, so one implementation covers both —
 * only the base URL, the default model, and the strictness of JSON support
 * differ. Those are the subclass's job.
 */
abstract class OpenAiCompatibleProvider extends AiProvider
{
    abstract protected function baseUrl(): string;

    abstract protected function defaultModel(): string;

    /**
     * Whether the provider enforces a JSON Schema server-side.
     *
     * When false the request asks only for "some JSON object" and the schema is
     * carried in the prompt instead, so the reply still parses — it is just not
     * guaranteed. parseCards() is tolerant for exactly this reason.
     */
    protected function supportsJsonSchema(): bool
    {
        return false;
    }

    public function extract(string $text, int $targetCards, string $depthGuidance): array
    {
        $body = [
            'model'    => $this->model() ?: $this->defaultModel(),
            'messages' => [
                ['role' => 'system', 'content' => $this->systemPrompt($targetCards, $depthGuidance)],
                ['role' => 'user',   'content' => "Make flashcards from the following text.\n\n<text>\n{$text}\n</text>"],
            ],
            'max_tokens' => 8000,
            // Extraction is not a creative task; low temperature keeps it
            // anchored to the source text rather than embellishing it.
            'temperature' => 0.2,
        ];

        $body['response_format'] = $this->supportsJsonSchema()
            ? [
                'type' => 'json_schema',
                'json_schema' => [
                    'name'   => 'flashcards',
                    'strict' => true,
                    'schema' => $this->schema(),
                ],
            ]
            : ['type' => 'json_object'];

        $response = $this->post(
            rtrim($this->baseUrl(), '/') . '/chat/completions',
            ['Authorization: Bearer ' . $this->apiKey()],
            $body
        );

        $choice = $response['choices'][0] ?? null;
        $content = (string) ($choice['message']['content'] ?? '');

        // Some providers signal a policy decline through finish_reason.
        $refused = in_array($choice['finish_reason'] ?? '', ['content_filter'], true);

        return [
            'cards'   => $refused ? [] : $this->parseCards($content),
            'usage'   => [
                'input_tokens'  => (int) ($response['usage']['prompt_tokens'] ?? 0),
                'output_tokens' => (int) ($response['usage']['completion_tokens'] ?? 0),
            ],
            'refused' => $refused,
        ];
    }
}

final class OpenAiProvider extends OpenAiCompatibleProvider
{
    public function label(): string
    {
        return 'OpenAI (' . ($this->model() ?: $this->defaultModel()) . ')';
    }

    protected function baseUrl(): string
    {
        return (string) ($this->settings['base_url'] ?? 'https://api.openai.com/v1');
    }

    protected function defaultModel(): string
    {
        return 'gpt-4o-mini';
    }

    /** Current OpenAI chat models enforce a JSON Schema server-side. */
    protected function supportsJsonSchema(): bool
    {
        return (bool) ($this->settings['json_schema'] ?? true);
    }
}

final class DeepSeekProvider extends OpenAiCompatibleProvider
{
    public function label(): string
    {
        return 'DeepSeek (' . ($this->model() ?: $this->defaultModel()) . ')';
    }

    protected function baseUrl(): string
    {
        return (string) ($this->settings['base_url'] ?? 'https://api.deepseek.com/v1');
    }

    protected function defaultModel(): string
    {
        return 'deepseek-chat';
    }

    /**
     * DeepSeek supports `json_object` but not, at the time of writing, the
     * `json_schema` variant — so the schema travels in the prompt. Flip
     * `json_schema` to true in config if that changes.
     */
    protected function supportsJsonSchema(): bool
    {
        return (bool) ($this->settings['json_schema'] ?? false);
    }
}
