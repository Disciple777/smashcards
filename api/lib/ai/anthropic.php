<?php
declare(strict_types=1);

require_once __DIR__ . '/provider.php';

/**
 * Claude, via the Messages API.
 *
 * Raw HTTP rather than the official PHP SDK: the SDK installs through Composer,
 * and this API is deliberately dependency-free so it can be dropped onto shared
 * hosting as plain files.
 *
 * NOTE ON BILLING: a Claude.ai subscription does not include API access. This
 * provider needs separate API credit from console.anthropic.com, and returns a
 * 401 without it.
 */
final class AnthropicProvider extends AiProvider
{
    private const ENDPOINT = 'https://api.anthropic.com/v1/messages';
    private const API_VERSION = '2023-06-01';

    public function label(): string
    {
        return 'Claude (' . $this->model() . ')';
    }

    public function extract(string $text, int $targetCards, string $depthGuidance): array
    {
        $response = $this->post(
            self::ENDPOINT,
            [
                'x-api-key: ' . $this->apiKey(),
                'anthropic-version: ' . self::API_VERSION,
            ],
            [
                'model'      => $this->model() ?: 'claude-opus-5',
                'max_tokens' => 16000,
                'system'     => $this->systemPrompt($targetCards, $depthGuidance),
                'output_config' => [
                    'effort' => (string) ($this->settings['effort'] ?? 'medium'),
                    // Structured output: the reply is guaranteed to match the
                    // schema, so nothing downstream has to scrape prose.
                    'format' => [
                        'type'   => 'json_schema',
                        'schema' => $this->schema(),
                    ],
                ],
                'messages' => [[
                    'role'    => 'user',
                    'content' => "Make flashcards from the following text.\n\n<text>\n{$text}\n</text>",
                ]],
            ]
        );

        // A safety decline arrives as HTTP 200 with no usable content.
        if (($response['stop_reason'] ?? '') === 'refusal') {
            return ['cards' => [], 'usage' => $this->usage($response), 'refused' => true];
        }

        $body = '';
        foreach ($response['content'] ?? [] as $block) {
            if (($block['type'] ?? '') === 'text') {
                $body .= (string) $block['text'];
            }
        }

        return [
            'cards'   => $this->parseCards($body),
            'usage'   => $this->usage($response),
            'refused' => false,
        ];
    }

    private function usage(array $response): array
    {
        return [
            'input_tokens'  => (int) ($response['usage']['input_tokens'] ?? 0),
            'output_tokens' => (int) ($response['usage']['output_tokens'] ?? 0),
        ];
    }
}
