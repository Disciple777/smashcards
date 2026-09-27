<?php
/**
 * Copy to config.php and fill in. config.php is gitignored — it holds secrets.
 * On Hostinger, DB credentials come from hPanel → Databases → MySQL Databases.
 */
return [
    'db' => [
        'host'     => 'localhost',
        'name'     => 'u123456789_smashcards',
        'user'     => 'u123456789_admin',
        'password' => '',
        'charset'  => 'utf8mb4',
    ],

    // Generate with: php -r "echo bin2hex(random_bytes(32));"
    // Changing this invalidates every issued token.
    'jwt' => [
        'secret'          => 'CHANGE_ME_TO_A_64_CHAR_RANDOM_HEX_STRING',
        'issuer'          => 'smashcards',
        'access_ttl'      => 900,      // 15 minutes
        'refresh_ttl'     => 2592000,  // 30 days
        'leeway'          => 60,       // clock-skew tolerance, seconds
    ],

    // Exact origins allowed to call this API cross-origin. No wildcards:
    // the API sends credentials-bearing headers.
    'cors' => [
        'allowed_origins' => [
            'http://localhost:5173',   // Vite dev server
            'http://127.0.0.1:5173',
            // 'https://smashcards.example.com',  // production front end
        ],
    ],

    // Card generation (phase 3).
    //
    // Three providers are supported. Set 'provider' to the one you want; any
    // provider with an empty api_key is simply unavailable, and if the chosen
    // one is unconfigured the API falls back to whichever is. Leave all three
    // empty to disable the feature cleanly (the endpoint answers 503 and the
    // UI hides itself).
    //
    // NOTE: a Claude.ai subscription does NOT include API access. The
    // anthropic provider needs separate credit from console.anthropic.com.
    'ai' => [
        'provider' => 'deepseek',              // anthropic | openai | deepseek

        'max_chars_per_request' => 20000,      // roughly 3,000 words
        'monthly_char_quota'    => 200000,     // per user, per calendar month
        'timeout_seconds'       => 120,

        'providers' => [
            'anthropic' => [
                'api_key' => '',               // console.anthropic.com
                'model'   => 'claude-opus-5',
                'effort'  => 'medium',         // low | medium | high | xhigh | max
            ],
            'openai' => [
                'api_key' => '',               // platform.openai.com
                'model'   => 'gpt-4o-mini',
            ],
            'deepseek' => [
                'api_key' => '',               // platform.deepseek.com
                'model'   => 'deepseek-chat',
            ],
        ],

        // Speech-to-text for uploaded audio. Neither DeepSeek nor Anthropic
        // accepts audio, so this is OpenAI only — but the transcript it
        // produces is then handed to whichever provider above the user picked.
        //
        // api_key is optional: leave it empty and the OpenAI key above is used,
        // so a server already set up for OpenAI gets audio import with no extra
        // configuration. With no OpenAI key at all, audio upload reports itself
        // unavailable and the UI hides it.
        'transcription' => [
            'api_key' => '',                   // optional; defaults to the OpenAI key
            'model'   => 'whisper-1',
            'timeout_seconds'        => 300,   // a long recording is not quick
            'monthly_minutes_quota'  => 180,   // per user, per calendar month
        ],

        // Reading scanned pages (OCR). A scanned PDF has no text layer, so the
        // browser renders its pages to images and a vision model reads them.
        //
        // Opt-in per upload, and only ever used when a PDF turns out to have no
        // text of its own — a normal PDF never touches this. Same key story as
        // transcription: empty means "use the OpenAI key", and with no OpenAI
        // key at all the option is not offered.
        //
        // max_pages is the real cost control: each page is one vision request.
        'ocr' => [
            'api_key' => '',                   // optional; defaults to the OpenAI key
            'model'   => 'gpt-4o-mini',
            'max_pages'       => 20,
            'timeout_seconds' => 120,
        ],

        // Reading cards aloud when the device cannot.
        //
        // Browser speech only covers languages the device has a voice installed
        // for — usually just its display language — so a deck in anything else
        // is read in the wrong accent or not at all. This removes the device
        // from the question, and every synthesis is cached, so a deck costs
        // something once and is then free to re-read for ever.
        //
        // Same key story as the rest: empty means "use the OpenAI key", and
        // with no OpenAI key the app falls back to browser voices silently.
        'tts' => [
            'api_key' => '',                   // optional; defaults to the OpenAI key
            'model'   => 'tts-1',              // tts-1 is fast; tts-1-hd is richer
            'voice'   => 'alloy',              // alloy, echo, fable, onyx, nova, shimmer
            'monthly_char_quota' => 200000,    // per user, per calendar month
            'timeout_seconds'    => 60,
        ],
    ],

    // Uploaded study material — documents and recordings kept for reference.
    //
    // 'path' is where the files live. The default sits beside the API and is
    // created on first upload with a deny-all .htaccess, so nothing needs
    // setting up by hand. Point it outside the web root if the host allows it.
    //
    // The real ceiling is usually PHP's own upload_max_filesize / post_max_size,
    // whichever is smaller — the API reports the effective limit to the client
    // rather than guessing, so the file picker can refuse an oversized file
    // before the upload instead of after it.
    'uploads' => [
        'path'                => '',           // default: api/storage
        'max_document_bytes'  => 20971520,     // 20MB
        'max_audio_bytes'     => 26214400,     // 25MB — the transcription API's own cap
        'max_text_chars'      => 500000,       // how much extracted text is kept
    ],

    // Ops endpoints (api/ops/*). These replace SSH on this host: one applies
    // migrations, the other inspects the database. Both refuse to run when
    // their key is empty, so leaving these blank disables them rather than
    // exposing them. Use the SAME values as MIGRATE_KEY / OPS_KEY in .env.deploy.
    // Generate: php -r "echo bin2hex(random_bytes(24));"
    'ops' => [
        'migrate_key'  => '',
        'selftest_key' => '',
    ],

    // 'production' hides error detail from responses. Use 'development' locally.
    'env' => 'production',
];
