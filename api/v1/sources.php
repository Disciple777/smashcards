<?php
declare(strict_types=1);

require_once __DIR__ . '/../lib/db.php';
require_once __DIR__ . '/../lib/auth.php';
require_once __DIR__ . '/../lib/guard.php';
require_once __DIR__ . '/../lib/response.php';
require_once __DIR__ . '/../lib/storage.php';
require_once __DIR__ . '/../lib/ai/transcribe.php';
require_once __DIR__ . '/../lib/ai/vision.php';

/**
 * Study sources — the material cards are generated from, kept afterwards.
 *
 * A source is created *before* any cards exist and survives independently of
 * them, which is the whole point: generation can fail, or produce cards the
 * user later deletes, and the chapter they uploaded is still there to read.
 *
 * Three kinds, one row shape:
 *   text     — a pasted passage. No file.
 *   document — a PDF, .txt or .md. The file is kept; so is its text.
 *   audio    — a recording. The file is kept, and so is its transcript, so the
 *              two halves never drift apart.
 *
 * PDF text is extracted in the browser (pdf.js) and posted alongside the file.
 * That is deliberate: a dependency-free PHP PDF parser would be a fragile
 * reimplementation of font decoding, while the browser already ships a good
 * one, it costs no server CPU, and it works with every AI provider rather than
 * only the ones that accept PDF uploads. The trade-off is that a scanned PDF
 * with no text layer yields nothing — which the client detects and explains,
 * rather than silently storing an empty source.
 */
final class SourcesController
{
    private const DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'txt', 'md', 'markdown', 'text'];

    /**
     * Formats whose text is extracted in the browser and posted alongside the
     * file. Everything else is read here, from the bytes on disk.
     */
    private const CLIENT_EXTRACTED = ['pdf', 'docx'];

    /** How much of content_text the list view carries, for a one-line preview. */
    private const PREVIEW_CHARS = 240;

    /** GET /v1/decks/{deck_id}/sources */
    public static function index(array $params): never
    {
        $userId = Auth::requireUser();
        $deck   = Guard::deck($params['deck_id'], $userId, forWrite: false);

        $rows = Db::all(
            'SELECT s.*, (SELECT COUNT(*) FROM cards c WHERE c.source_id = s.id) AS card_count
               FROM sources s
              WHERE s.deck_id = ?
              ORDER BY s.created_at DESC, s.id DESC',
            [(int) $deck['id']]
        );

        Response::json(['sources' => array_map([self::class, 'shape'], $rows)]);
    }

    /** GET /v1/sources/{id} — the full text or transcript. */
    public static function show(array $params): never
    {
        $userId = Auth::requireUser();
        $source = self::find($params['id'], $userId);

        $shaped = self::shape($source);
        $shaped['content_text'] = $source['content_text'];

        Response::json(['source' => $shaped]);
    }

    /**
     * GET /v1/sources/{id}/file — the original upload, streamed back.
     *
     * Owner-only, and the only route that can read the storage directory at
     * all: the files themselves are not web-reachable.
     */
    public static function download(array $params): never
    {
        $userId = Auth::requireUser();
        $source = self::find($params['id'], $userId);

        $key = (string) ($source['storage_key'] ?? '');
        if ($key === '' || !Storage::exists($key)) {
            Response::error('not_found', 'That source has no stored file.', 404);
        }

        $name = (string) ($source['original_name'] ?? 'source');

        header('Content-Type: ' . ($source['mime_type'] ?: 'application/octet-stream'));
        header('Content-Length: ' . (string) filesize(Storage::pathFor($key)));
        // A quoted, ASCII-stripped filename for old clients, plus the RFC 5987
        // form so accented names survive. inline, not attachment: a PDF or an
        // audio file is usually something to look at or play, not to re-download.
        header(sprintf(
            'Content-Disposition: inline; filename="%s"; filename*=UTF-8\'\'%s',
            preg_replace('/[^\x20-\x7e]/', '_', str_replace('"', '', $name)),
            rawurlencode($name)
        ));
        // Uploaded content is never executed or sniffed into something else.
        header('X-Content-Type-Options: nosniff');
        header('Content-Security-Policy: default-src \'none\'; media-src \'self\'; object-src \'none\'');

        Storage::stream($key);
        exit;
    }

    /**
     * POST /v1/decks/{deck_id}/sources
     *
     * Either multipart with a `file` (plus `text` for a PDF's extracted text),
     * or a JSON body with `text` for a pasted passage.
     */
    public static function store(array $params): never
    {
        $userId = Auth::requireUser();
        $deck   = Guard::deck($params['deck_id'], $userId);

        self::assertPostSurvivedTheUploadLimit();

        if (!Storage::isWritable()) {
            error_log('[smashcards] storage root is not writable: ' . Storage::root());
            Response::error('storage_unavailable', 'Uploads are not available on this server yet.', 503);
        }

        $upload = $_FILES['file'] ?? null;

        if (!is_array($upload) || ($upload['error'] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_NO_FILE) {
            self::storeText($userId, (int) $deck['id']);
        }

        self::storeUpload($userId, $deck, $upload);
    }

    /** DELETE /v1/sources/{id} — the row and the file. Cards keep their text. */
    public static function destroy(array $params): never
    {
        $userId = Auth::requireUser();
        $source = self::find($params['id'], $userId);

        $key = (string) ($source['storage_key'] ?? '');
        if ($key !== '') {
            Storage::delete($key);
        }

        // cards.source_id is ON DELETE SET NULL — cards made from this source
        // survive it, they just stop pointing at material that no longer exists.
        Db::run('DELETE FROM sources WHERE id = ?', [(int) $source['id']]);

        Response::json(['deleted' => true, 'id' => (int) $source['id']]);
    }

    /**
     * GET /v1/sources/limits — what this server will actually accept.
     *
     * Reported rather than assumed: upload_max_filesize and post_max_size are
     * host settings that cannot be read from the browser, and a UI that offers
     * a 25MB upload on a server capped at 8MB fails after the upload, not
     * before it. The client caps its own file picker with these numbers.
     */
    public static function limits(): never
    {
        $userId = Auth::requireUser();

        $phpCeiling = min(
            self::bytesFromIni('upload_max_filesize'),
            self::bytesFromIni('post_max_size')
        );

        $documentCap = (int) Config::get('uploads.max_document_bytes', 20 * 1024 * 1024);
        $audioCap    = min(
            (int) Config::get('uploads.max_audio_bytes', Transcriber::PROVIDER_MAX_BYTES),
            Transcriber::PROVIDER_MAX_BYTES
        );

        Response::json([
            'storage_ready' => Storage::isWritable(),
            'documents' => [
                'enabled'    => true,
                'max_bytes'  => min($documentCap, $phpCeiling),
                'extensions' => self::DOCUMENT_EXTENSIONS,
            ],
            'audio' => [
                'enabled'    => Transcriber::isConfigured(),
                'max_bytes'  => min($audioCap, $phpCeiling),
                'extensions' => Transcriber::EXTENSIONS,
                'label'      => Transcriber::isConfigured() ? Transcriber::label() : null,
                'minutes_left' => Transcriber::isConfigured() ? self::transcriptionMinutesLeft($userId) : 0,
            ],
            // Reading scanned pages: the client only offers it when a PDF turns
            // out to have no text layer, and only when it is available here.
            'ocr' => [
                'enabled'   => Vision::isConfigured(),
                'max_pages' => Vision::maxPages(),
                'label'     => Vision::isConfigured() ? Vision::label() : null,
            ],
            'max_text_chars' => (int) Config::get('uploads.max_text_chars', 500000),
            'php_max_upload_bytes' => $phpCeiling,
        ]);
    }

    // ------------------------------------------------------------ internals --

    /** A pasted passage: no file, but still a first-class, re-readable source. */
    private static function storeText(int $userId, int $deckId): never
    {
        // A multipart request whose file part was dropped still has its fields
        // in $_POST, where php://input is empty — so both are consulted rather
        // than reporting "no text" to someone who plainly sent some.
        $body = $_POST !== [] ? $_POST : Response::body();
        $text = trim((string) ($body['text'] ?? ''));

        if ($text === '') {
            Response::error('validation_failed', 'Add some text, or choose a file to upload.', 422, [
                'text' => 'This field is required.',
            ]);
        }

        $text  = self::capText($text);
        $title = self::titleFrom((string) ($body['title'] ?? ''), $text);

        $id = Db::insert(
            'INSERT INTO sources (user_id, deck_id, kind, title, byte_size, content_text)
             VALUES (?, ?, \'text\', ?, ?, ?)',
            [$userId, $deckId, $title, strlen($text), $text]
        );

        self::respondWith($id, 201);
    }

    private static function storeUpload(int $userId, array $deck, array $upload): never
    {
        self::assertUploadSucceeded((int) ($upload['error'] ?? UPLOAD_ERR_NO_FILE));

        $originalName = self::cleanFilename((string) ($upload['name'] ?? 'upload'));
        $extension    = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
        $bytes        = (int) ($upload['size'] ?? 0);
        $temporary    = (string) ($upload['tmp_name'] ?? '');

        $isDocument = in_array($extension, self::DOCUMENT_EXTENSIONS, true);
        $isAudio    = in_array($extension, Transcriber::EXTENSIONS, true);

        if (!$isDocument && !$isAudio) {
            Response::error('unsupported_file', 'That file type is not supported. Upload a PDF, a text file, or an audio recording.', 422);
        }

        if ($isAudio && !Transcriber::isConfigured()) {
            Response::error('audio_not_configured', 'Audio import is not set up on this server yet.', 503);
        }

        self::assertWithinSizeLimit($bytes, $isAudio);

        // The declared extension decides how the file is handled, so it is
        // checked against what the bytes actually are before anything is stored.
        self::assertContentMatchesExtension($temporary, $extension, $isAudio);

        $deckId = (int) $deck['id'];

        if ($isAudio) {
            self::storeAudio($userId, $deckId, $deck, $upload, $originalName, $extension, $bytes);
        }

        self::storeDocument($userId, $deckId, $upload, $originalName, $extension, $bytes);
    }

    private static function storeDocument(
        int $userId,
        int $deckId,
        array $upload,
        string $originalName,
        string $extension,
        int $bytes
    ): never {
        $clientExtracted = in_array($extension, self::CLIENT_EXTRACTED, true);
        $ocrUsage = ['input_tokens' => 0, 'output_tokens' => 0];

        if ($clientExtracted) {
            // Extracted in the browser and posted alongside the file. Empty
            // means there was no text layer to extract — a scan, in practice.
            $text = trim((string) ($_POST['text'] ?? ''));
            $extractedBy = $extension === 'pdf' ? 'pdfjs' : 'docx';

            if ($text === '' && $extension === 'pdf' && self::hasPageImages()) {
                // A scan: the client rendered the pages and sent them to be read.
                [$text, $ocrUsage] = self::readPageImages($userId);
                $extractedBy = 'ocr:' . Vision::model();
            }

            if ($text === '') {
                Response::error(
                    $extension === 'pdf' ? 'pdf_has_no_text' : 'document_has_no_text',
                    $extension === 'pdf'
                        ? 'No text could be read from that PDF. Its pages are images rather than text — '
                          . 'turn on "Read scanned pages" and try again.'
                        : 'No text could be read from that document.',
                    422
                );
            }
        } else {
            // A plain-text file is read here rather than trusted from the
            // client: the bytes on disk are the authority for what it says.
            $raw = (string) file_get_contents((string) $upload['tmp_name']);
            if (!mb_check_encoding($raw, 'UTF-8')) {
                // Windows text files are very often cp1252, which is not valid
                // UTF-8 and would otherwise be stored as mojibake.
                $raw = (string) mb_convert_encoding($raw, 'UTF-8', 'Windows-1252');
            }
            $text = trim($raw);
            if ($text === '') {
                Response::error('empty_file', 'That file is empty.', 422);
            }
            $extractedBy = 'file';
        }

        $text = self::capText($text);
        $key  = self::putFile($userId, $upload, $extension);

        $id = Db::insert(
            'INSERT INTO sources (user_id, deck_id, kind, title, original_name, mime_type, byte_size, storage_key, content_text, extracted_by)
             VALUES (?, ?, \'document\', ?, ?, ?, ?, ?, ?, ?)',
            [
                $userId,
                $deckId,
                self::titleFrom($originalName, $text),
                $originalName,
                self::documentMimeFor($extension),
                $bytes,
                $key,
                $text,
                $extractedBy,
            ]
        );

        self::respondWith($id, 201);
    }

    private static function storeAudio(
        int $userId,
        int $deckId,
        array $deck,
        array $upload,
        string $originalName,
        string $extension,
        int $bytes
    ): never {
        self::assertTranscriptionQuota($userId);

        // Transcription is slow — minutes for a long recording — and the
        // default limit would kill the request mid-call and leave the user
        // with an uploaded file and no transcript.
        @set_time_limit((int) Config::get('ai.transcription.timeout_seconds', 300) + 60);

        // Stored first, so a transcription failure still leaves the recording
        // safely on the server rather than discarding an upload the user may
        // have waited a long time to send.
        $key = self::putFile($userId, $upload, $extension);

        try {
            $result = Transcriber::transcribe(
                Storage::pathFor($key),
                $originalName,
                self::languageOf($deck)
            );
        } catch (AiError $e) {
            Storage::delete($key);
            error_log('[smashcards] transcribe ' . $e->status . ': ' . $e->getMessage());

            $status = in_array($e->status, [429, 503, 529], true) ? 503 : 502;
            $detail = $e->status === 401
                ? 'The transcription service rejected its API key.'
                : 'That recording could not be transcribed. Please try again.';
            Response::error('transcription_failed', $detail, $status);
        } catch (Throwable $e) {
            // Same reasoning as the card-generation catch: a surprise from the
            // service must not become a blank 500, and must not strand the
            // uploaded recording on disk with no row pointing at it.
            Storage::delete($key);
            error_log('[smashcards] transcribe ' . $e::class . ': ' . $e->getMessage());
            Response::error('transcription_failed', 'That recording could not be transcribed. Please try again.', 502);
        }

        if ($result['text'] === '') {
            Storage::delete($key);
            Response::error('transcription_empty', 'No speech could be heard in that recording.', 422);
        }

        $text = self::capText($result['text']);

        $id = Db::insert(
            'INSERT INTO sources (user_id, deck_id, kind, title, original_name, mime_type, byte_size, storage_key, content_text, extracted_by, duration_seconds)
             VALUES (?, ?, \'audio\', ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                $userId,
                $deckId,
                self::titleFrom($originalName, $text),
                $originalName,
                self::audioMimeFor($extension),
                $bytes,
                $key,
                $text,
                Transcriber::model(),
                $result['duration_seconds'],
            ]
        );

        self::respondWith($id, 201);
    }

    /** True when the client sent rendered page images for a scanned PDF. */
    private static function hasPageImages(): bool
    {
        return isset($_FILES['pages']) && is_array($_FILES['pages']['tmp_name'] ?? null);
    }

    /**
     * Reads rendered page images and returns their text, in page order.
     *
     * One request per page rather than one for the whole document: a single
     * oversized request is the thing most likely to time out or be truncated,
     * and page-at-a-time means a document that fails on page 14 still returns
     * thirteen usable pages instead of nothing.
     *
     * @return array{0: string, 1: array{input_tokens:int, output_tokens:int}}
     */
    private static function readPageImages(int $userId): array
    {
        if (!Vision::isConfigured()) {
            Response::error('ocr_not_configured', 'Reading scanned pages is not set up on this server yet.', 503);
        }

        $pages = $_FILES['pages'];
        $count = count($pages['tmp_name']);

        if ($count > Vision::maxPages()) {
            Response::error(
                'too_many_pages',
                'That document has more pages than can be read at once (limit '
                    . Vision::maxPages() . '). Split it and try again.',
                422
            );
        }

        @set_time_limit((int) Config::get('ai.ocr.timeout_seconds', 120) * 2 + $count * 30);

        $texts = [];
        $usage = ['input_tokens' => 0, 'output_tokens' => 0];

        for ($i = 0; $i < $count; $i++) {
            if ((int) $pages['error'][$i] !== UPLOAD_ERR_OK) continue;

            try {
                $page = Vision::readPage(
                    (string) $pages['tmp_name'][$i],
                    self::imageMimeFor((string) ($pages['type'][$i] ?? ''))
                );
            } catch (Throwable $e) {
                error_log('[smashcards] ocr page ' . $i . ' ' . $e::class . ': ' . $e->getMessage());

                // A page that cannot be read must not discard the rest of the
                // document — but an outright rejected key should stop here
                // rather than burning through every remaining page.
                if ($e instanceof AiError && $e->status === 401) {
                    Response::error('ocr_failed', 'The OCR service rejected its API key.', 502);
                }
                continue;
            }

            $usage['input_tokens']  += $page['usage']['input_tokens'];
            $usage['output_tokens'] += $page['usage']['output_tokens'];

            if ($page['text'] !== '') {
                $texts[] = $page['text'];
            }
        }

        // Recorded for visibility in the usage screen; OCR is billed in tokens,
        // not in the characters the monthly quota counts.
        self::recordOcrUsage($userId, $usage);

        return [trim(implode("\n\n", $texts)), $usage];
    }

    private static function recordOcrUsage(int $userId, array $usage): void
    {
        Db::run(
            'INSERT INTO ai_usage (user_id, period, characters_used, requests, input_tokens, output_tokens, last_provider)
             VALUES (?, ?, 0, 1, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               requests      = requests + 1,
               input_tokens  = input_tokens + VALUES(input_tokens),
               output_tokens = output_tokens + VALUES(output_tokens),
               last_provider = VALUES(last_provider)',
            [$userId, gmdate('Y-m'), $usage['input_tokens'], $usage['output_tokens'], 'openai']
        );
    }

    /** Only the two formats the client renders pages to are accepted. */
    private static function imageMimeFor(string $declared): string
    {
        return $declared === 'image/png' ? 'image/png' : 'image/jpeg';
    }

    private static function documentMimeFor(string $extension): string
    {
        return match ($extension) {
            'pdf'  => 'application/pdf',
            'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            default => 'text/plain',
        };
    }

    private static function putFile(int $userId, array $upload, string $extension): string
    {
        try {
            return Storage::put($userId, (string) $upload['tmp_name'], $extension);
        } catch (RuntimeException $e) {
            error_log('[smashcards] storage: ' . $e->getMessage());
            Response::error('storage_failed', 'The file could not be stored. Please try again.', 500);
        }
    }

    private static function respondWith(int $id, int $status): never
    {
        $row = Db::one(
            'SELECT s.*, (SELECT COUNT(*) FROM cards c WHERE c.source_id = s.id) AS card_count
               FROM sources s WHERE s.id = ?',
            [$id]
        );

        Response::json(['source' => self::shape($row ?? [])], $status);
    }

    /**
     * Loads a source the caller owns.
     *
     * Owner-only even when the deck is public: a public deck shares its cards,
     * not the private material they were made from. Someone else's source id
     * is a 404, the same as everywhere else in this API.
     */
    public static function find(int|string $sourceId, int $userId): array
    {
        $source = Db::one('SELECT * FROM sources WHERE id = ?', [Guard::id($sourceId)]);

        if ($source === null || (int) $source['user_id'] !== $userId) {
            Response::error('not_found', 'Source not found.', 404);
        }

        return $source;
    }

    public static function shape(array $source): array
    {
        if ($source === []) {
            return [];
        }

        $text = (string) ($source['content_text'] ?? '');

        return [
            'id'               => (int) $source['id'],
            'deck_id'          => (int) $source['deck_id'],
            'kind'             => $source['kind'],
            'title'            => $source['title'],
            'original_name'    => $source['original_name'],
            'mime_type'        => $source['mime_type'],
            'byte_size'        => (int) $source['byte_size'],
            'has_file'         => ($source['storage_key'] ?? null) !== null,
            'extracted_by'     => $source['extracted_by'],
            'duration_seconds' => $source['duration_seconds'] === null ? null : (int) $source['duration_seconds'],
            'text_chars'       => mb_strlen($text),
            'preview'          => mb_substr($text, 0, self::PREVIEW_CHARS),
            'card_count'       => (int) ($source['card_count'] ?? 0),
            'created_at'       => $source['created_at'],
        ];
    }

    /** Minutes of audio left in this calendar month. */
    public static function transcriptionMinutesLeft(int $userId): int
    {
        $quota = (int) Config::get('ai.transcription.monthly_minutes_quota', 180);

        $row = Db::one(
            "SELECT COALESCE(SUM(duration_seconds), 0) AS seconds
               FROM sources
              WHERE user_id = ? AND kind = 'audio'
                AND created_at >= ?",
            [$userId, gmdate('Y-m-01 00:00:00')]
        );

        $used = (int) ceil(((int) ($row['seconds'] ?? 0)) / 60);

        return max(0, $quota - $used);
    }

    private static function assertTranscriptionQuota(int $userId): void
    {
        if (self::transcriptionMinutesLeft($userId) <= 0) {
            Response::error(
                'quota_exceeded',
                'You have used this month\'s audio transcription allowance.',
                429
            );
        }
    }

    /**
     * A POST larger than post_max_size arrives with $_POST and $_FILES both
     * empty and no error flag anywhere — PHP discards the body before the
     * script runs. Without this check that looks exactly like "no file was
     * chosen", which is a baffling thing to tell someone who just waited
     * through a 30MB upload.
     */
    private static function assertPostSurvivedTheUploadLimit(): void
    {
        $declared = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
        $ceiling  = self::bytesFromIni('post_max_size');

        if ($declared > 0 && $ceiling > 0 && $declared > $ceiling && $_FILES === [] && $_POST === []) {
            Response::error(
                'file_too_large',
                'That file is larger than this server accepts (' . self::humanBytes($ceiling) . ').',
                413
            );
        }
    }

    private static function assertUploadSucceeded(int $error): void
    {
        if ($error === UPLOAD_ERR_OK) {
            return;
        }

        [$code, $message, $status] = match ($error) {
            UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE => [
                'file_too_large',
                'That file is larger than this server accepts ('
                    . self::humanBytes(self::bytesFromIni('upload_max_filesize')) . ').',
                413,
            ],
            UPLOAD_ERR_PARTIAL => ['upload_incomplete', 'The upload was interrupted. Please try again.', 400],
            UPLOAD_ERR_NO_TMP_DIR, UPLOAD_ERR_CANT_WRITE => [
                'storage_unavailable',
                'The server could not write the upload.',
                503,
            ],
            default => ['upload_failed', 'The upload failed. Please try again.', 400],
        };

        Response::error($code, $message, $status);
    }

    private static function assertWithinSizeLimit(int $bytes, bool $isAudio): void
    {
        $cap = $isAudio
            ? min(
                (int) Config::get('uploads.max_audio_bytes', Transcriber::PROVIDER_MAX_BYTES),
                Transcriber::PROVIDER_MAX_BYTES
            )
            : (int) Config::get('uploads.max_document_bytes', 20 * 1024 * 1024);

        if ($bytes > $cap) {
            Response::error(
                'file_too_large',
                'That file is larger than the ' . self::humanBytes($cap) . ' limit for '
                    . ($isAudio ? 'audio' : 'documents') . '.',
                413
            );
        }
    }

    /**
     * Checks the bytes against the extension.
     *
     * The extension decides whether a file is transcribed or read as text, so
     * it must not be the only thing vouching for what the file is. This is a
     * sanity check, not a security boundary — nothing uploaded is ever
     * executed, and the storage directory is not web-readable — but it turns a
     * confusing downstream failure into a clear message here.
     */
    private static function assertContentMatchesExtension(string $path, string $extension, bool $isAudio): void
    {
        if (!function_exists('finfo_open')) {
            return; // fileinfo is not guaranteed on shared hosting
        }

        $finfo = finfo_open(FILEINFO_MIME_TYPE);
        if ($finfo === false) {
            return;
        }

        $detected = (string) finfo_file($finfo, $path);
        finfo_close($finfo);

        if ($extension === 'pdf' && $detected !== 'application/pdf') {
            Response::error('unsupported_file', 'That file is not a readable PDF.', 422);
        }

        // A .docx is a ZIP archive, and fileinfo reports it either by its full
        // Office type or simply as a zip depending on the magic database.
        if ($extension === 'docx' && !in_array($detected, [
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/zip',
            'application/octet-stream',
        ], true)) {
            Response::error(
                'unsupported_file',
                'That file is not a readable Word document. If it is the older .doc format, '
                . 'open it in Word and save it again as .docx.',
                422
            );
        }

        if ($isAudio && !str_starts_with($detected, 'audio/') && !str_starts_with($detected, 'video/')
            && $detected !== 'application/octet-stream') {
            Response::error('unsupported_file', 'That file does not look like an audio recording.', 422);
        }
    }

    /**
     * Keeps the stored text inside MEDIUMTEXT and inside anything sane to display.
     *
     * Line endings are normalised on the way in: a multipart form field arrives
     * with CRLF by specification, so text extracted in the browser would
     * otherwise be stored with carriage returns the browser never had.
     */
    private static function capText(string $text): string
    {
        $text = str_replace(["\r\n", "\r"], "\n", $text);
        $max  = (int) Config::get('uploads.max_text_chars', 500000);

        return mb_strlen($text) > $max ? mb_substr($text, 0, $max) : $text;
    }

    private static function titleFrom(string $preferred, string $text): string
    {
        $title = trim($preferred);

        if ($title === '') {
            // The first line of the material reads better as a label than
            // "Untitled" does, and needs nothing from the user.
            $firstLine = trim((string) strtok($text, "\n"));
            $title = $firstLine === '' ? 'Pasted text' : $firstLine;
        }

        return mb_substr($title, 0, 255);
    }

    /** The original name, kept for display only — never used to build a path. */
    private static function cleanFilename(string $name): string
    {
        $name = str_replace(["\0", "\n", "\r", '/', '\\'], '', $name);
        $name = trim(basename($name));

        return $name === '' ? 'upload' : mb_substr($name, 0, 255);
    }

    private static function languageOf(array $deck): ?string
    {
        // Whisper wants a bare ISO-639-1 code; the deck stores BCP-47 ('es-ES').
        $tag = (string) ($deck['language_front'] ?? '');
        $base = strtolower(substr($tag, 0, 2));

        return preg_match('/^[a-z]{2}$/', $base) === 1 ? $base : null;
    }

    private static function audioMimeFor(string $extension): string
    {
        return match ($extension) {
            'mp3', 'mpga', 'mpeg' => 'audio/mpeg',
            'm4a', 'mp4'          => 'audio/mp4',
            'wav'                 => 'audio/wav',
            'webm'                => 'audio/webm',
            'ogg', 'oga'          => 'audio/ogg',
            'flac'                => 'audio/flac',
            default               => 'application/octet-stream',
        };
    }

    private static function bytesFromIni(string $directive): int
    {
        $value = trim((string) ini_get($directive));
        if ($value === '') {
            return 0;
        }

        $unit   = strtolower(substr($value, -1));
        $number = (int) $value;

        return match ($unit) {
            'g'     => $number * 1024 * 1024 * 1024,
            'm'     => $number * 1024 * 1024,
            'k'     => $number * 1024,
            default => $number,
        };
    }

    private static function humanBytes(int $bytes): string
    {
        if ($bytes >= 1024 * 1024) {
            return round($bytes / 1024 / 1024, 1) . 'MB';
        }

        return max(1, (int) round($bytes / 1024)) . 'KB';
    }
}
