<?php
declare(strict_types=1);

/** Loads api/config.php once and hands back values by dotted path. */
final class Config
{
    private static ?array $data = null;

    private static function data(): array
    {
        if (self::$data === null) {
            $path = __DIR__ . '/../config.php';
            if (!is_file($path)) {
                http_response_code(500);
                header('Content-Type: application/json');
                echo json_encode([
                    'error' => [
                        'code'    => 'config_missing',
                        'message' => 'api/config.php not found. Copy config.example.php and fill it in.',
                    ],
                ]);
                exit;
            }
            self::$data = require $path;
        }
        return self::$data;
    }

    /** @param string $path dotted key, e.g. 'jwt.secret' */
    public static function get(string $path, mixed $default = null): mixed
    {
        $value = self::data();
        foreach (explode('.', $path) as $segment) {
            if (!is_array($value) || !array_key_exists($segment, $value)) {
                return $default;
            }
            $value = $value[$segment];
        }
        return $value;
    }

    public static function isProduction(): bool
    {
        return self::get('env', 'production') === 'production';
    }
}
