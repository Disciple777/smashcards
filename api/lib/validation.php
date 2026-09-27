<?php
declare(strict_types=1);

/** Collects field errors so a bad form comes back in one response, not five. */
final class Validator
{
    /** @var array<string,string> */
    private array $errors = [];

    public function __construct(private array $data) {}

    public function email(string $field): self
    {
        $value = trim((string) ($this->data[$field] ?? ''));
        if ($value === '') {
            return $this->fail($field, 'Email is required.');
        }
        if (strlen($value) > 255 || !filter_var($value, FILTER_VALIDATE_EMAIL)) {
            return $this->fail($field, 'Enter a valid email address.');
        }
        return $this;
    }

    /**
     * Length floor only. Composition rules (a digit, a symbol) push users toward
     * predictable passwords; length is what actually resists guessing.
     */
    public function password(string $field, int $min = 8): self
    {
        $value = (string) ($this->data[$field] ?? '');
        if ($value === '') {
            return $this->fail($field, 'Password is required.');
        }
        if (strlen($value) < $min) {
            return $this->fail($field, "Password must be at least {$min} characters.");
        }
        // password_hash() with bcrypt silently truncates beyond 72 bytes.
        if (strlen($value) > 72) {
            return $this->fail($field, 'Password must be 72 characters or fewer.');
        }
        return $this;
    }

    public function text(string $field, int $min = 1, int $max = 255, bool $required = true): self
    {
        $value = trim((string) ($this->data[$field] ?? ''));
        if ($value === '') {
            return $required ? $this->fail($field, 'This field is required.') : $this;
        }
        $length = mb_strlen($value);
        if ($length < $min) {
            return $this->fail($field, "Must be at least {$min} characters.");
        }
        if ($length > $max) {
            return $this->fail($field, "Must be {$max} characters or fewer.");
        }
        return $this;
    }

    private function fail(string $field, string $message): self
    {
        $this->errors[$field] ??= $message;
        return $this;
    }

    public function fails(): bool
    {
        return $this->errors !== [];
    }

    /** @return array<string,string> */
    public function errors(): array
    {
        return $this->errors;
    }

    public static function str(array $data, string $key): string
    {
        return trim((string) ($data[$key] ?? ''));
    }
}
