/**
 * The only place in the app that talks HTTP.
 *
 * Handles token storage and silent refresh: when an access token expires
 * mid-session, one 401 triggers a refresh and the original request is retried
 * once. Concurrent 401s share a single refresh rather than stampeding.
 */

const STORAGE_KEY = 'smashcards.auth';

/**
 * Always relative. In production the app and API share an origin
 * (guatermelon.com/smashcards/ and .../smashcards/api). In development Vite
 * proxies this same path to production, so the browser sees same-origin
 * requests either way and CORS never enters the picture.
 *
 * VITE_API_BASE overrides it for pointing at a staging API.
 */
const DEFAULT_BASE = '/smashcards/api';

export class ApiError extends Error {
  constructor(message, { status, code, fields } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields ?? {};
  }

  /** True when the server rejected specific form fields. */
  get isValidation() {
    return this.status === 422 || this.code === 'validation_failed';
  }
}

export class ApiClient {
  constructor(baseUrl = import.meta.env?.VITE_API_BASE || DEFAULT_BASE) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.tokens = readTokens();
    this.refreshPromise = null;
    this.onAuthChange = null;
  }

  isAuthenticated() {
    return Boolean(this.tokens?.access_token);
  }

  setTokens(tokens) {
    this.tokens = tokens;
    if (tokens) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
    this.onAuthChange?.(tokens);
  }

  /**
   * Ends the session on the server as well as on this device.
   *
   * The local tokens are cleared first and unconditionally: a network failure
   * must never leave someone still logged in on a shared machine because the
   * revoke call did not get through.
   */
  async logout() {
    const refresh = this.tokens?.refresh_token;
    this.setTokens(null);

    if (!refresh) return;

    try {
      await this.request('POST', '/v1/auth/logout', {
        body: { refresh_token: refresh },
        auth: false,
      });
    } catch {
      // The token stays valid until it expires, which is the old behaviour —
      // no worse than before, and not worth blocking the UI over.
    }
  }

  /** Signs out every device. Needs a live access token. */
  logoutEverywhere() {
    return this.post('/v1/auth/logout-all', {});
  }

  // ------------------------------------------------------------- requests --

  async request(method, path, { body, auth = true, retrying = false } = {}) {
    // FormData carries its own multipart Content-Type, including a boundary
    // only the browser can generate — setting the header by hand breaks it.
    const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;

    const headers = {};
    if (body !== undefined && !isFormData) headers['Content-Type'] = 'application/json';
    if (auth && this.tokens?.access_token) {
      headers.Authorization = `Bearer ${this.tokens.access_token}`;
    }

    let response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : (isFormData ? body : JSON.stringify(body)),
      });
    } catch (cause) {
      // fetch only rejects on network failure, never on a 4xx/5xx.
      throw new ApiError('Could not reach the server. Check your connection.', { status: 0, code: 'network' });
    }

    // An expired access token: refresh once, then replay the request.
    if (response.status === 401 && auth && !retrying && this.tokens?.refresh_token) {
      const refreshed = await this.refreshTokens();
      if (refreshed) {
        return this.request(method, path, { body, auth, retrying: true });
      }
    }

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new ApiError('The server returned a malformed response.', {
          status: response.status,
          code: 'bad_response',
        });
      }
    }

    if (!response.ok) {
      const error = payload?.error ?? {};
      throw new ApiError(error.message || `Request failed (${response.status}).`, {
        status: response.status,
        code: error.code,
        fields: error.fields,
      });
    }

    return payload;
  }

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, { body }); }
  patch(path, body) { return this.request('PATCH', path, { body }); }
  delete(path) { return this.request('DELETE', path); }

  /** Shared across concurrent 401s so only one refresh is ever in flight. */
  refreshTokens() {
    if (!this.refreshPromise) {
      this.refreshPromise = this.request('POST', '/v1/auth/refresh', {
        body: { refresh_token: this.tokens.refresh_token },
        auth: false,
      })
        .then((tokens) => {
          this.setTokens(tokens);
          return true;
        })
        .catch(() => {
          // The refresh token is dead too — the session is genuinely over.
          this.setTokens(null);
          return false;
        })
        .finally(() => {
          this.refreshPromise = null;
        });
    }
    return this.refreshPromise;
  }

  // ---------------------------------------------------------------- auth --

  async register(email, password, displayName) {
    const tokens = await this.request('POST', '/v1/auth/register', {
      body: { email, password, display_name: displayName },
      auth: false,
    });
    this.setTokens(tokens);
    return tokens.user;
  }

  async login(email, password) {
    const tokens = await this.request('POST', '/v1/auth/login', {
      body: { email, password },
      auth: false,
    });
    this.setTokens(tokens);
    return tokens.user;
  }

  async me() {
    const { user } = await this.get('/v1/auth/me');
    return user;
  }

  // --------------------------------------------------------------- decks --

  async listDecks() {
    return (await this.get('/v1/decks')).decks;
  }

  async getDeck(id) {
    return (await this.get(`/v1/decks/${id}`)).deck;
  }

  async createDeck(deck) {
    return (await this.post('/v1/decks', deck)).deck;
  }

  async updateDeck(id, changes) {
    return (await this.patch(`/v1/decks/${id}`, changes)).deck;
  }

  deleteDeck(id) {
    return this.delete(`/v1/decks/${id}`);
  }

  async listPublicDecks(query = '') {
    const q = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
    return (await this.get(`/v1/decks/public${q}`)).decks;
  }

  /** Copies a public (or your own) deck into your account. Returns the new deck. */
  async cloneDeck(id) {
    return (await this.post(`/v1/decks/${id}/clone`)).deck;
  }

  /** Creates (or returns the existing) share link. Returns just the token. */
  async createShareLink(deckId) {
    return (await this.post(`/v1/decks/${deckId}/share`)).share_token;
  }

  revokeShareLink(deckId) {
    return this.delete(`/v1/decks/${deckId}/share`);
  }

  async getSharedDeck(token) {
    return (await this.get(`/v1/shared/${token}`)).deck;
  }

  /** Clones a deck reached by its share link. Returns the new deck. */
  async cloneSharedDeck(token) {
    return (await this.post(`/v1/shared/${token}/clone`)).deck;
  }

  // ------------------------------------------------------------- folders --

  async listFolders() {
    return (await this.get('/v1/folders')).folders;
  }

  async createFolder(folder) {
    return (await this.post('/v1/folders', folder)).folder;
  }

  async updateFolder(id, changes) {
    return (await this.patch(`/v1/folders/${id}`, changes)).folder;
  }

  deleteFolder(id) {
    return this.delete(`/v1/folders/${id}`);
  }

  // --------------------------------------------------------------- cards --

  // ------------------------------------------------- AI extraction (phase 3)

  /** Current month's generation allowance, and whether the feature is on. */
  aiStatus() {
    return this.get('/v1/ai/usage');
  }

  /**
   * Generates staged cards. They are not in the deck yet.
   *
   * Pass `text` for a passage (which the server saves as a source), or
   * `source_id` to generate from material already uploaded. `offset` resumes
   * partway through a source too long for one request.
   * `provider` is optional; omitting it uses the server's configured default.
   */
  extractCards(deckId, { text, source_id, offset, density, depth, provider }) {
    return this.post(`/v1/decks/${deckId}/ai/extract`, {
      text,
      source_id,
      offset,
      density,
      depth,
      provider,
    });
  }

  /** Moves reviewed staged cards into the deck. */
  approveCards(deckId, cardIds) {
    return this.post(`/v1/decks/${deckId}/cards/approve`, { card_ids: cardIds });
  }

  async listStagedCards(deckId) {
    const { cards } = await this.get(`/v1/decks/${deckId}/cards?status=staged`);
    return cards;
  }

  async listCards(deckId) {
    return (await this.get(`/v1/decks/${deckId}/cards`)).cards;
  }

  async createCard(deckId, card) {
    return (await this.post(`/v1/decks/${deckId}/cards`, card)).card;
  }

  async updateCard(id, changes) {
    return (await this.patch(`/v1/cards/${id}`, changes)).card;
  }

  deleteCard(id) {
    return this.delete(`/v1/cards/${id}`);
  }

  bulkImport(deckId, cards) {
    return this.post(`/v1/decks/${deckId}/cards/bulk`, { cards });
  }

  // ------------------------------------------------------------- sources --

  /** What this server accepts: size ceilings, file types, whether audio is on. */
  sourceLimits() {
    return this.get('/v1/sources/limits');
  }

  async listSources(deckId) {
    return (await this.get(`/v1/decks/${deckId}/sources`)).sources;
  }

  /** The full text or transcript, which the list view deliberately omits. */
  async getSource(id) {
    return (await this.get(`/v1/sources/${id}`)).source;
  }

  /** @param {FormData} form  the file, plus `text` for a PDF's extracted text */
  async uploadSource(deckId, form) {
    return (await this.request('POST', `/v1/decks/${deckId}/sources`, { body: form })).source;
  }

  deleteSource(id) {
    return this.delete(`/v1/sources/${id}`);
  }

  /**
   * The stored original, as a Blob.
   *
   * Stored files are not web-readable and the route needs an Authorization
   * header, so a plain <a href> cannot reach one — the bytes are fetched here
   * and handed to the page as an object URL instead.
   */
  async fetchSourceFile(id, { retrying = false } = {}) {
    const response = await fetch(`${this.baseUrl}/v1/sources/${id}/file`, {
      headers: this.tokens?.access_token
        ? { Authorization: `Bearer ${this.tokens.access_token}` }
        : {},
    });

    if (response.status === 401 && !retrying && this.tokens?.refresh_token) {
      if (await this.refreshTokens()) {
        return this.fetchSourceFile(id, { retrying: true });
      }
    }

    if (!response.ok) {
      throw new ApiError('That file could not be opened.', { status: response.status });
    }

    return response.blob();
  }

  // -------------------------------------------------------- cloud speech --

  /** Whether the server can read cards aloud, and how much budget is left. */
  speechStatus() {
    return this.get('/v1/speech/status');
  }

  /**
   * Synthesised audio for one card side, as a Blob.
   *
   * Audio rather than a URL: the server caches the file outside the web root,
   * so there is nothing to link to, and a blob plays just as well.
   */
  async synthesiseSpeech({ text, voice, speed }, { retrying = false } = {}) {
    const response = await fetch(`${this.baseUrl}/v1/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.tokens?.access_token ? { Authorization: `Bearer ${this.tokens.access_token}` } : {}),
      },
      body: JSON.stringify({ text, voice, speed }),
    });

    if (response.status === 401 && !retrying && this.tokens?.refresh_token) {
      if (await this.refreshTokens()) {
        return this.synthesiseSpeech({ text, voice, speed }, { retrying: true });
      }
    }

    if (!response.ok) {
      throw new ApiError('That card could not be read aloud.', { status: response.status });
    }

    return response.blob();
  }

  // --------------------------------------------------------------- study --

  async getStates(deckId) {
    return (await this.get(`/v1/decks/${deckId}/states`)).states;
  }

  async startSession(deckId, mode) {
    return (await this.post('/v1/sessions', { deck_id: deckId, mode })).session;
  }

  async endSession(sessionId) {
    return (await this.patch(`/v1/sessions/${sessionId}`, {})).session;
  }

  submitReview(review) {
    return this.post('/v1/reviews', review);
  }
}

function readTokens() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export const api = new ApiClient();
