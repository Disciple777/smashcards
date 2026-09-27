<?php
declare(strict_types=1);

require_once __DIR__ . '/response.php';

/**
 * Tiny pattern router. Patterns use {name} for a path segment, which is
 * captured and passed to the handler as an associative array.
 */
final class Router
{
    /** @var array<int,array{verb:string,pattern:string,handler:callable}> */
    private array $routes = [];

    public function add(string $verb, string $pattern, callable $handler): self
    {
        $this->routes[] = ['verb' => strtoupper($verb), 'pattern' => $pattern, 'handler' => $handler];
        return $this;
    }

    /**
     * Strips the script's own directory off the request URI, so the API works
     * whether it is deployed at the domain root or under a subdirectory such as
     * /smashcards/api. Falls back to trimming everything up to the last "/api".
     */
    public static function path(): string
    {
        $uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
        $uri = rawurldecode($uri);

        // e.g. "/smashcards/api" — the directory index.php lives in.
        $base = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '')), '/');

        if ($base !== '' && $base !== '/' && str_starts_with($uri, $base)) {
            $uri = substr($uri, strlen($base));
        } elseif (preg_match('#^.*/api(?=/|$)#', $uri, $m) === 1) {
            $uri = substr($uri, strlen($m[0]));
        }

        $uri = '/' . trim($uri, '/');
        return $uri;
    }

    public function dispatch(string $verb, string $path): never
    {
        $pathMatchedOtherVerb = false;

        foreach ($this->routes as $route) {
            $regex = '#^' . preg_replace('#\{([a-z_]+)\}#i', '(?P<$1>[^/]+)', $route['pattern']) . '$#';

            if (preg_match($regex, $path, $matches) !== 1) {
                continue;
            }

            if ($route['verb'] !== $verb) {
                $pathMatchedOtherVerb = true;
                continue;
            }

            $params = array_filter($matches, 'is_string', ARRAY_FILTER_USE_KEY);
            ($route['handler'])($params);
        }

        if ($pathMatchedOtherVerb) {
            Response::error('method_not_allowed', "$verb is not supported for $path.", 405);
        }

        Response::error('not_found', "No route for $verb $path.", 404);
    }
}
