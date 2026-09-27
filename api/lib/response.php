<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';

/** JSON-only responses. This API never renders HTML. */
final class Response
{
    public static function json(mixed $data, int $status = 200): never
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    /** @param array<string,string> $fields per-field validation messages */
    public static function error(string $code, string $message, int $status = 400, array $fields = []): never
    {
        $error = ['code' => $code, 'message' => $message];
        if ($fields !== []) {
            $error['fields'] = $fields;
        }
        self::json(['error' => $error], $status);
    }

    /** Emits CORS headers and short-circuits preflight requests. */
    public static function cors(): void
    {
        $origin  = $_SERVER['HTTP_ORIGIN'] ?? '';
        $allowed = Config::get('cors.allowed_origins', []);

        if ($origin !== '' && in_array($origin, $allowed, true)) {
            header('Access-Control-Allow-Origin: ' . $origin);
            header('Vary: Origin');
            header('Access-Control-Allow-Headers: Content-Type, Authorization');
            header('Access-Control-Allow-Methods: GET, POST, PATCH, PUT, DELETE, OPTIONS');
            header('Access-Control-Max-Age: 86400');
        }

        if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
            // Preflight: headers above are the whole answer.
            http_response_code($origin !== '' && in_array($origin, $allowed, true) ? 204 : 403);
            exit;
        }
    }

    /** Decodes the JSON request body, rejecting anything that is not an object. */
    public static function body(): array
    {
        $raw = file_get_contents('php://input') ?: '';
        if (trim($raw) === '') {
            return [];
        }
        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            self::error('invalid_json', 'Request body must be a JSON object.', 400);
        }
        return $decoded;
    }
}
