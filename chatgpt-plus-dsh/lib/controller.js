// Stateful core: sign-in attempts, the token lifecycle, the account's models, quota
// information and preferences. lib/index.js binds one instance to the plugin's lifetime
// through ctx.effect(); every timer and listener created here is released by dispose().
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import {
  CHATGPT_BACKEND_URL, CODEX_CLIENT_VERSION, CREDENTIAL_KEY, DATA_DIR_NAME, DEFAULTS, OAUTH_AUTHORIZE_URL,
  OAUTH_CALLBACK_HOST, OAUTH_CALLBACK_PATH, OAUTH_CALLBACK_PORT, OAUTH_TOKEN_URL, ORIGINATOR, PACKAGE_NAME,
  PACKAGE_VERSION, PROVIDER_ID, PROVIDER_NAME,
} from './constants.js'
import { ChatGptPlusError, SIGN_IN_HINT } from './errors.js'
import { FALLBACK_MODELS, fetchAccountModels, fetchUsage, genericModel, isModelEntry } from './models.js'
import {
  OAuthError, buildAuthorizeUrl, buildGrantPayload, createOAuthState, createPkcePair, exchangeAuthorizationCode,
  openBrowser as defaultOpenBrowser, parseCallbackInput, refreshAccessToken, startCallbackServer as defaultStartCallbackServer,
} from './oauth.js'
import { CredentialStoreUnavailableError, DataStore, TokenStore, normalizePreferences } from './store.js'
import { createDeferred, fingerprint, maskEmail, planLabel, resolveDshHome } from './util.js'

const SIGN_IN_AGAIN_HINT = 'Open DSH → Plugins → ChatGPT Plus and click “Sign in again”.'
const MAX_TIMER_MS = 6 * 60 * 60_000
const MODELS_RETRY_MS = 5 * 60_000

/** Error shown to the settings page (never forwarded to a model call). */
export class UserFacingError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'UserFacingError'
    this.code = code
    this.status = status
  }
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

function positiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  return Number.isInteger(value) && value > 0 && value <= max ? value : fallback
}

/** Validate the optional row config from the profile patch. */
export function normalizeConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    callbackHost: OAUTH_CALLBACK_HOST,
    callbackPort: Number.isInteger(config.callbackPort) && config.callbackPort >= 0 && config.callbackPort < 65536 ? config.callbackPort : OAUTH_CALLBACK_PORT,
    signInTimeoutMs: positiveInt(config.signInTimeoutMs, DEFAULTS.signInTimeoutMs, 30 * 60_000),
    tokenRequestTimeoutMs: positiveInt(config.tokenRequestTimeoutMs, DEFAULTS.tokenRequestTimeoutMs, 120_000),
    requestTimeoutMs: positiveInt(config.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 30 * 60_000),
    streamIdleTimeoutMs: positiveInt(config.streamIdleTimeoutMs, DEFAULTS.streamIdleTimeoutMs, 60 * 60_000),
    metadataTimeoutMs: positiveInt(config.metadataTimeoutMs, DEFAULTS.metadataTimeoutMs, 120_000),
    backgroundRefreshMarginMs: positiveInt(config.backgroundRefreshMarginMs, DEFAULTS.backgroundRefreshMarginMs),
    requestRefreshMarginMs: positiveInt(config.requestRefreshMarginMs, DEFAULTS.requestRefreshMarginMs),
    fallbackTokenLifetimeMs: positiveInt(config.fallbackTokenLifetimeMs, DEFAULTS.fallbackTokenLifetimeMs),
    modelsMaxAgeMs: positiveInt(config.modelsMaxAgeMs, DEFAULTS.modelsMaxAgeMs),
    usageMaxAgeMs: positiveInt(config.usageMaxAgeMs, DEFAULTS.usageMaxAgeMs),
    clientVersion: typeof config.clientVersion === 'string' && /^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/.test(config.clientVersion) ? config.clientVersion : CODEX_CLIENT_VERSION,
  }
}

function isTransient(error) {
  return error instanceof OAuthError && ['NETWORK', 'TIMEOUT', 'SERVER'].includes(error.code)
}

export class ChatGptPlusController {
  /**
   * @param {object} options
   * @param {object} options.credentials - ctx.credentials (DSH credential seam).
   * @param {() => object|undefined} [options.getDefaultModelService] - ctx.get('agentDefaultModel').
   */
  constructor({
    credentials,
    getDefaultModelService = () => undefined,
    logger = silentLogger,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    openBrowser = defaultOpenBrowser,
    startCallbackServer = defaultStartCallbackServer,
    dataDir,
    dataStore,
    config,
    endpoints = {},
  } = {}) {
    this.tokens = new TokenStore(credentials)
    this.getDefaultModelService = () => {
      try {
        return getDefaultModelService()
      } catch {
        return undefined
      }
    }
    this.logger = logger
    this.fetchImpl = fetchImpl
    this.now = now
    this.openBrowser = openBrowser
    this.startCallbackServer = startCallbackServer
    this.config = normalizeConfig(config)
    this.endpoints = {
      backendUrl: endpoints.backendUrl ?? CHATGPT_BACKEND_URL,
      authorizeUrl: endpoints.authorizeUrl ?? OAUTH_AUTHORIZE_URL,
      tokenUrl: endpoints.tokenUrl ?? OAUTH_TOKEN_URL,
    }
    this.data = dataStore ?? new DataStore(dataDir ?? join(resolveDshHome(), DATA_DIR_NAME))

    this.record = null
    this.recordInvalid = false
    this.preferences = normalizePreferences({})
    this.signIn = null
    this.lastError = null
    this.deadRefreshToken = null
    this.refreshFailures = 0
    this.refreshPromise = null
    this.refreshTimer = null
    this.models = { list: null, accountKey: null, fetchedAt: 0, error: null, errorAt: 0, loading: null }
    this.usage = { snapshot: null, fetchedAt: 0, error: null, loading: null }
    this.changeListeners = new Set()
    this.modelListeners = new Set()
    this.started = null
    this.disposed = false
  }

  // ---- lifecycle ---------------------------------------------------------

  /** Load persisted state. @returns {() => void} disposer for ctx.effect(). */
  start() {
    if (!this.started) {
      this.started = this.initialize().catch((error) => {
        this.setError('STARTUP', `ChatGPT Plus could not load its saved state: ${error?.message ?? error}`)
      })
    }
    return () => this.dispose()
  }

  ready() {
    return this.started ?? Promise.resolve()
  }

  async initialize() {
    this.preferences = await this.data.loadPreferences().catch(() => normalizePreferences({}))
    const cached = await this.data.loadModels().catch(() => undefined)
    if (cached) {
      const list = cached.models.filter(isModelEntry)
      if (list.length > 0) this.models = { ...this.models, list, accountKey: cached.accountId, fetchedAt: cached.fetchedAt }
    }
    this.data.prepare()
    await this.reloadRecord({ quiet: true })
    if (this.disposed) return
    this.scheduleRefresh()
    this.emitModelsChanged()
    if (this.record) this.refreshModelsInBackground()
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    if (this.signIn) this.finishSignIn(this.signIn, { error: new OAuthError('The plugin was unloaded.', 'CANCELLED') })
    this.changeListeners.clear()
    this.modelListeners.clear()
  }

  /** Subscribe to any state change. @returns unsubscribe. */
  onChange(listener) {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  /** Subscribe to changes of the advertised model list (sign-in/out, account, visibility). */
  onModelsChanged(listener) {
    this.modelListeners.add(listener)
    return () => this.modelListeners.delete(listener)
  }

  emitChange() {
    for (const listener of [...this.changeListeners]) {
      try {
        listener()
      } catch (error) {
        this.logger.debug('change listener failed: %s', error?.message ?? error)
      }
    }
  }

  emitModelsChanged() {
    for (const listener of [...this.modelListeners]) {
      try {
        listener()
      } catch (error) {
        this.logger.debug('models listener failed: %s', error?.message ?? error)
      }
    }
  }

  setError(code, message, scope = 'general') {
    this.lastError = { code, message, scope, at: this.now() }
    this.logger.warn('%s', message)
    this.emitChange()
  }

  clearError(scope) {
    if (this.lastError && (scope === undefined || this.lastError.scope === scope)) {
      this.lastError = null
      this.emitChange()
    }
  }

  // ---- credential record -------------------------------------------------

  isRefreshTokenDead(payload = this.record) {
    return !!payload && this.deadRefreshToken !== null && this.deadRefreshToken === fingerprint(payload.refresh_token)
  }

  /** Re-read the grant (startup, or `credentials/record-updated` from any process). */
  async reloadRecord({ quiet = false } = {}) {
    if (!this.tokens.available) {
      this.record = null
      if (!quiet) this.emitChange()
      return
    }
    try {
      const { payload, invalid } = await this.tokens.read()
      const before = this.record
      this.record = payload ?? null
      this.recordInvalid = invalid === true
      if (payload && this.deadRefreshToken && !this.isRefreshTokenDead(payload)) {
        this.deadRefreshToken = null
        this.refreshFailures = 0
        this.clearError('refresh')
        this.clearError('auth')
      }
      if (!quiet) {
        if ((before?.access_token ?? null) !== (payload?.access_token ?? null)) this.scheduleRefresh()
        if (!!before !== !!payload || before?.account_id !== payload?.account_id) this.emitModelsChanged()
        this.emitChange()
      }
    } catch (error) {
      this.setError('CREDENTIAL_STORE', `Could not read the ChatGPT sign-in from the DSH credential store: ${error?.message ?? error}`)
    }
  }

  isSignedIn() {
    return this.record !== null
  }

  get status() {
    if (this.signIn) return 'signing-in'
    if (!this.tokens.available || this.recordInvalid) return 'error'
    if (!this.record) return 'signed-out'
    if (this.isRefreshTokenDead() || this.lastError?.scope === 'auth') return 'expired'
    if (this.record.expires_at <= this.now() && (!this.preferences.autoRefresh || this.refreshFailures > 0)) return 'expired'
    return 'connected'
  }

  // ---- tokens ------------------------------------------------------------

  /** Whether a 401 from ChatGPT may be answered with one forced refresh-and-retry. */
  canRefreshAfterRejection() {
    return this.preferences.autoRefresh && this.record !== null && !this.isRefreshTokenDead()
  }

  /**
   * Access token for a model call, refreshed first when it is about to expire.
   * @returns {Promise<{accessToken: string, accountId: string}>}
   * @throws {ChatGptPlusError} MISSING_CREDENTIAL, INVALID_CREDENTIAL, TIMEOUT, TRANSPORT or SERVER.
   */
  async getAccessToken({ forceRefresh = false } = {}) {
    await this.ready()
    if (this.disposed) throw new ChatGptPlusError('The ChatGPT Plus plugin is being unloaded.', 'ABORTED')
    if (!this.tokens.available) throw new ChatGptPlusError(new CredentialStoreUnavailableError().message, 'MISSING_CREDENTIAL')
    let payload = this.record
    if (!payload) throw new ChatGptPlusError(`Not signed in to ChatGPT. ${SIGN_IN_HINT}`, 'MISSING_CREDENTIAL')
    if (this.isRefreshTokenDead(payload)) throw new ChatGptPlusError(`Your ChatGPT sign-in has expired or was revoked. ${SIGN_IN_AGAIN_HINT}`, 'INVALID_CREDENTIAL')
    const remaining = payload.expires_at - this.now()
    if (forceRefresh || remaining <= this.config.requestRefreshMarginMs) {
      if (!this.preferences.autoRefresh) {
        if (remaining > 0 && !forceRefresh) return { accessToken: payload.access_token, accountId: payload.account_id }
        throw new ChatGptPlusError('Your ChatGPT access token has expired and automatic refresh is turned off. Turn on “Refresh tokens automatically” or click “Refresh token” in DSH → Plugins → ChatGPT Plus.', 'INVALID_CREDENTIAL')
      }
      try {
        payload = await this.refreshTokens({ force: forceRefresh })
      } catch (error) {
        // A token that is still valid keeps working through a transient refresh failure.
        if (!forceRefresh && remaining > 5_000 && isTransient(error)) return { accessToken: payload.access_token, accountId: payload.account_id }
        throw this.toLlmError(error)
      }
    }
    return { accessToken: payload.access_token, accountId: payload.account_id }
  }

  toLlmError(error) {
    if (error instanceof ChatGptPlusError) return error
    if (error instanceof CredentialStoreUnavailableError) return new ChatGptPlusError(error.message, 'MISSING_CREDENTIAL')
    if (error instanceof OAuthError) {
      switch (error.code) {
        case 'INVALID_GRANT':
          return new ChatGptPlusError(`Your ChatGPT sign-in has expired or was revoked (the refresh token was rejected). ${SIGN_IN_AGAIN_HINT}`, 'INVALID_CREDENTIAL', { status: error.status })
        case 'TIMEOUT':
          return new ChatGptPlusError(error.message, 'TIMEOUT')
        case 'NETWORK':
          return new ChatGptPlusError(error.message, 'TRANSPORT')
        case 'SERVER':
          return new ChatGptPlusError(error.message, 'SERVER', { status: error.status })
        default:
          return new ChatGptPlusError(`${error.message} ${SIGN_IN_AGAIN_HINT}`, 'INVALID_CREDENTIAL', { status: error.status })
      }
    }
    return new ChatGptPlusError(`Could not obtain a ChatGPT access token: ${error?.message ?? error}`, 'INVALID_CREDENTIAL')
  }

  /**
   * Refresh the grant through the credential store's serialized read-modify-write, so two
   * DSH processes sharing one home never both spend the same refresh token. Concurrent
   * callers in this process share one in-flight refresh.
   * @param {{force?: boolean, margin?: number}} [options] - `force` refreshes even a fresh token;
   *   `margin` is the remaining lifetime under which the token counts as due (the background
   *   timer uses its own, larger margin than model requests).
   */
  refreshTokens({ force = false, margin = this.config.requestRefreshMarginMs } = {}) {
    if (this.refreshPromise) return this.refreshPromise
    const run = async () => {
      const before = this.record
      if (!before) throw new ChatGptPlusError(`Not signed in to ChatGPT. ${SIGN_IN_HINT}`, 'MISSING_CREDENTIAL')
      let tried = null
      try {
        const stored = await this.tokens.update(async (current) => {
          if (!current) throw new ChatGptPlusError(`Not signed in to ChatGPT. ${SIGN_IN_HINT}`, 'MISSING_CREDENTIAL')
          const fresh = current.expires_at - this.now() > margin
          // Another process (or an earlier call) rotated the token while we waited for the lock.
          if (fresh && current.access_token !== before.access_token) return undefined
          if (fresh && !force) return undefined
          if (this.isRefreshTokenDead(current)) throw new OAuthError('The saved refresh token was already rejected.', 'INVALID_GRANT')
          tried = current.refresh_token
          const json = await refreshAccessToken({
            refreshToken: current.refresh_token,
            fetchImpl: this.fetchImpl,
            tokenUrl: this.endpoints.tokenUrl,
            timeoutMs: this.config.tokenRequestTimeoutMs,
          })
          return buildGrantPayload(json, current, this.now(), this.config.fallbackTokenLifetimeMs)
        })
        if (!stored) throw new ChatGptPlusError(`Not signed in to ChatGPT. ${SIGN_IN_HINT}`, 'MISSING_CREDENTIAL')
        const accountChanged = before.account_id !== stored.account_id
        this.record = stored
        this.refreshFailures = 0
        this.clearError('refresh')
        this.clearError('auth')
        this.scheduleRefresh()
        if (accountChanged) this.emitModelsChanged()
        this.emitChange()
        return stored
      } catch (error) {
        if (error instanceof OAuthError && error.code === 'INVALID_GRANT') {
          this.deadRefreshToken = fingerprint(tried ?? before.refresh_token)
          this.setError('REFRESH_REJECTED', `ChatGPT rejected the saved sign-in (the refresh token expired or was revoked). ${SIGN_IN_AGAIN_HINT}`, 'refresh')
        } else if (!(error instanceof ChatGptPlusError && error.code === 'MISSING_CREDENTIAL')) {
          this.refreshFailures += 1
          this.setError('REFRESH_FAILED', `Token refresh failed: ${error?.message ?? error}`, 'refresh')
        }
        this.scheduleRefresh()
        throw error
      }
    }
    this.refreshPromise = run().finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  /** Arm the background refresh timer (only while signed in with auto-refresh on). */
  scheduleRefresh() {
    clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    if (this.disposed || !this.record || !this.preferences.autoRefresh || this.isRefreshTokenDead()) return
    let delay = this.record.expires_at - this.config.backgroundRefreshMarginMs - this.now()
    if (this.refreshFailures > 0) delay = Math.max(delay, Math.min(15 * 60_000, 30_000 * 2 ** (this.refreshFailures - 1)))
    delay = Math.min(Math.max(delay, 1_000), MAX_TIMER_MS)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      this.backgroundRefresh().catch(() => {})
    }, delay)
    this.refreshTimer.unref?.()
  }

  async backgroundRefresh() {
    if (this.disposed || !this.record) return
    if (this.record.expires_at - this.now() > this.config.backgroundRefreshMarginMs) {
      this.scheduleRefresh()
      return
    }
    try {
      await this.refreshTokens({ margin: this.config.backgroundRefreshMarginMs })
    } catch (error) {
      this.logger.warn('background token refresh failed: %s', error?.message ?? error)
    }
  }

  /** Manual “Refresh token” (works even when automatic refresh is off). */
  async refreshNow() {
    await this.ready()
    if (!this.record) throw new UserFacingError('NOT_SIGNED_IN', 'Sign in with ChatGPT first.')
    try {
      await this.refreshTokens({ force: true })
    } catch (error) {
      throw new UserFacingError(error?.code === 'INVALID_GRANT' ? 'REFRESH_REJECTED' : 'REFRESH_FAILED', this.toLlmError(error).message, 502)
    }
    return this.getStatus()
  }

  /** A 401 survived a fresh token: the grant is no longer accepted by ChatGPT. */
  noteAuthRejected() {
    this.setError('TOKEN_REJECTED', `ChatGPT no longer accepts this sign-in. ${SIGN_IN_AGAIN_HINT}`, 'auth')
  }

  // ---- sign-in -------------------------------------------------------------

  publicSignIn() {
    const attempt = this.signIn
    if (!attempt) return null
    return {
      phase: attempt.phase,
      authUrl: attempt.authUrl,
      redirectUri: attempt.redirectUri,
      startedAt: attempt.startedAt,
      expiresAt: attempt.expiresAt,
      callbackListening: attempt.callback !== null,
      portBusy: attempt.portBusy,
      callbackError: attempt.callbackError,
      browserOpened: attempt.browserOpened,
    }
  }

  /**
   * Start a sign-in: PKCE pair + state, the one-shot redirect listener, the authorize URL,
   * and (optionally) the system browser. Completion arrives via the listener or via
   * completeSignIn() with the pasted redirect URL.
   */
  async beginSignIn({ openBrowser = true, restart = false } = {}) {
    await this.ready()
    if (this.disposed) throw new UserFacingError('UNLOADING', 'The plugin is being unloaded.', 503)
    if (!this.tokens.available) throw new UserFacingError('CREDENTIAL_STORE_UNAVAILABLE', new CredentialStoreUnavailableError().message, 503)
    if (this.signIn && !restart && this.signIn.phase === 'waiting' && this.signIn.authUrl) return this.publicSignIn()
    if (this.signIn) this.finishSignIn(this.signIn, { error: new OAuthError('Sign-in was restarted.', 'CANCELLED') })

    const now = this.now()
    const attempt = {
      id: randomBytes(6).toString('hex'),
      state: createOAuthState(),
      pkce: createPkcePair(),
      phase: 'waiting',
      startedAt: now,
      expiresAt: now + this.config.signInTimeoutMs,
      callback: null,
      portBusy: false,
      callbackError: null,
      redirectUri: null,
      authUrl: null,
      browserOpened: null,
      timer: null,
      finished: false,
      done: createDeferred(),
    }
    this.signIn = attempt
    this.clearError('sign-in')
    this.emitChange()

    try {
      attempt.callback = await this.startCallbackServer({
        host: this.config.callbackHost,
        port: this.config.callbackPort,
        path: OAUTH_CALLBACK_PATH,
        expectedState: attempt.state,
        onResult: (params) => this.handleCallback(attempt, params),
      })
    } catch (error) {
      attempt.portBusy = error?.code === 'PORT_BUSY'
      attempt.callbackError = `${error?.message ?? error} After approving in the browser, copy the full address from the browser's address bar and paste it below.`
    }
    if (this.signIn !== attempt) {
      await attempt.callback?.close()
      throw new UserFacingError('CANCELLED', 'Sign-in was cancelled.', 409)
    }
    const port = attempt.callback?.port || this.config.callbackPort
    attempt.redirectUri = `http://localhost:${port}${OAUTH_CALLBACK_PATH}`
    attempt.authUrl = buildAuthorizeUrl({
      challenge: attempt.pkce.challenge,
      state: attempt.state,
      redirectUri: attempt.redirectUri,
      authorizeUrl: this.endpoints.authorizeUrl,
      originator: ORIGINATOR,
    })
    attempt.timer = setTimeout(() => {
      this.finishSignIn(attempt, { error: new OAuthError(`Sign-in timed out after ${Math.round(this.config.signInTimeoutMs / 60_000)} minutes. Click “Sign in with ChatGPT” to try again.`, 'TIMEOUT') })
    }, this.config.signInTimeoutMs)
    attempt.timer.unref?.()
    // CHATGPT_PLUS_DSH_NO_BROWSER=1 suppresses the launch on headless or remote hosts, where
    // the settings page's link (and the paste fallback) is the way to sign in.
    if (openBrowser && process.env.CHATGPT_PLUS_DSH_NO_BROWSER !== '1') {
      attempt.browserOpened = await Promise.resolve(this.openBrowser(attempt.authUrl)).catch(() => false)
    }
    this.emitChange()
    return this.publicSignIn()
  }

  /** Redirect delivered to the local listener; the returned outcome picks the browser page. */
  async handleCallback(attempt, params) {
    if (this.signIn !== attempt) return { ok: false, message: 'This sign-in attempt is no longer active. Return to DeepSeek Harness and start again.' }
    if (params.error) {
      const error = new OAuthError(params.error === 'access_denied'
        ? 'Sign-in was cancelled in the browser.'
        : `OpenAI returned an error: ${params.errorDescription || params.error}`, 'DENIED')
      this.finishSignIn(attempt, { error })
      return { ok: false, message: error.message }
    }
    if (!params.code) return { ok: false, message: 'The redirect did not contain an authorization code.' }
    try {
      await this.exchangeAndStore(attempt, params.code)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error?.message ?? String(error) }
    }
  }

  /** Manual completion with the redirect URL (or code) copied from the browser. */
  async completeSignIn(input) {
    await this.ready()
    const attempt = this.signIn
    if (!attempt) throw new UserFacingError('NO_SIGN_IN', 'No sign-in is in progress. Click “Sign in with ChatGPT” first.', 409)
    const parsed = parseCallbackInput(input)
    if (parsed.error) {
      const error = new OAuthError(parsed.error === 'access_denied' ? 'Sign-in was cancelled in the browser.' : `OpenAI returned an error: ${parsed.errorDescription || parsed.error}`, 'DENIED')
      this.finishSignIn(attempt, { error })
      throw new UserFacingError('DENIED', error.message)
    }
    if (parsed.state && parsed.state !== attempt.state) {
      throw new UserFacingError('STATE_MISMATCH', 'That address belongs to a different sign-in attempt. Click “Sign in with ChatGPT”, approve again and paste the new address.')
    }
    if (!parsed.code) {
      throw new UserFacingError('NO_CODE', `No authorization code found. Paste the full address shown by the browser after approving (it starts with ${attempt.redirectUri}?code=).`)
    }
    try {
      await this.exchangeAndStore(attempt, parsed.code)
    } catch (error) {
      throw new UserFacingError('SIGN_IN_FAILED', error?.message ?? String(error), 502)
    }
    return this.getStatus()
  }

  async exchangeAndStore(attempt, code) {
    if (attempt.phase === 'exchanging' || attempt.finished) return attempt.done.promise
    attempt.phase = 'exchanging'
    this.emitChange()
    try {
      const json = await exchangeAuthorizationCode({
        code,
        verifier: attempt.pkce.verifier,
        redirectUri: attempt.redirectUri,
        fetchImpl: this.fetchImpl,
        tokenUrl: this.endpoints.tokenUrl,
        timeoutMs: this.config.tokenRequestTimeoutMs,
      })
      const payload = buildGrantPayload(json, undefined, this.now(), this.config.fallbackTokenLifetimeMs)
      if (this.signIn !== attempt) throw new OAuthError('Sign-in was cancelled.', 'CANCELLED')
      const stored = await this.tokens.write(payload)
      const accountChanged = this.record?.account_id !== stored.account_id
      this.record = stored
      this.recordInvalid = false
      this.deadRefreshToken = null
      this.refreshFailures = 0
      this.lastError = null
      if (accountChanged) this.usage = { snapshot: null, fetchedAt: 0, error: null, loading: null }
      this.finishSignIn(attempt, { ok: true })
      this.scheduleRefresh()
      this.emitModelsChanged()
      this.refreshModels({ force: true }).catch(() => {})
      return true
    } catch (error) {
      this.finishSignIn(attempt, { error })
      throw error
    }
  }

  finishSignIn(attempt, { ok = false, error } = {}) {
    if (attempt.finished) return
    attempt.finished = true
    clearTimeout(attempt.timer)
    attempt.callback?.close()
    if (this.signIn === attempt) this.signIn = null
    if (ok) {
      attempt.done.resolve(true)
    } else {
      attempt.done.reject(error)
      if (error && error.code !== 'CANCELLED') this.setError('SIGN_IN_FAILED', error.message ?? String(error), 'sign-in')
    }
    this.emitChange()
  }

  async cancelSignIn() {
    await this.ready()
    if (this.signIn) this.finishSignIn(this.signIn, { error: new OAuthError('Sign-in was cancelled.', 'CANCELLED') })
    return this.getStatus()
  }

  /**
   * Local sign-out: delete the grant from the credential store and restore the DSH default
   * model if a ChatGPT model was made the default through this plugin. (The Codex CLI's
   * logout is local-only as well; OpenAI exposes no token revocation for this client.)
   */
  async signOut() {
    await this.ready()
    if (this.signIn) this.finishSignIn(this.signIn, { error: new OAuthError('Sign-in was cancelled.', 'CANCELLED') })
    let restoredDefault = null
    try {
      restoredDefault = await this.restorePreviousDefault()
    } catch (error) {
      this.logger.warn('could not restore the previous default model: %s', error?.message ?? error)
    }
    if (this.tokens.available) await this.tokens.remove()
    this.record = null
    this.recordInvalid = false
    this.deadRefreshToken = null
    this.refreshFailures = 0
    this.lastError = null
    this.usage = { snapshot: null, fetchedAt: 0, error: null, loading: null }
    this.scheduleRefresh()
    this.emitModelsChanged()
    this.emitChange()
    return { ...(await this.getStatus()), restoredDefault }
  }

  // ---- models ----------------------------------------------------------------

  accountModels() {
    if (!this.record || !Array.isArray(this.models.list) || this.models.list.length === 0) return null
    return this.models.accountKey === fingerprint(this.record.account_id) ? this.models.list : null
  }

  availableModels() {
    return this.accountModels() ?? FALLBACK_MODELS
  }

  isModelVisible(model) {
    const preference = this.preferences.modelVisibility[model.id]
    return typeof preference === 'boolean' ? preference : model.visibility !== 'hide'
  }

  visibleModels() {
    return this.availableModels().filter((model) => this.isModelVisible(model))
  }

  findModel(id) {
    return this.availableModels().find((m) => m.id === id) ?? FALLBACK_MODELS.find((m) => m.id === id) ?? genericModel(id)
  }

  preferredEffort() {
    return this.preferences.defaultEffort ?? undefined
  }

  refreshModelsInBackground() {
    if (!this.record || this.models.loading || this.disposed) return
    const own = this.accountModels()
    if (own && this.now() - this.models.fetchedAt < this.config.modelsMaxAgeMs) return
    if (this.models.errorAt && this.now() - this.models.errorAt < MODELS_RETRY_MS) return
    this.refreshModels().catch(() => {})
  }

  /** Fetch the account's model list (falls back to the built-in catalog on failure). */
  async refreshModels({ force = false } = {}) {
    await this.ready()
    if (!this.record) return
    const accountKey = fingerprint(this.record.account_id)
    if (!force && this.accountModels() && this.now() - this.models.fetchedAt < this.config.modelsMaxAgeMs) return
    if (this.models.loading) return this.models.loading
    this.models.loading = (async () => {
      try {
        const auth = await this.getAccessToken()
        const list = await fetchAccountModels(auth, {
          fetchImpl: this.fetchImpl,
          backendUrl: this.endpoints.backendUrl,
          clientVersion: this.config.clientVersion,
          timeoutMs: this.config.metadataTimeoutMs,
        })
        if (list.length === 0) throw new Error('the account returned an empty model list')
        const previous = this.accountModels()
        this.models = { list, accountKey, fetchedAt: this.now(), error: null, errorAt: 0, loading: this.models.loading }
        await this.data.saveModels({ accountId: accountKey, fetchedAt: this.models.fetchedAt, models: list }).catch((error) => {
          this.logger.debug('could not cache the model list: %s', error?.message ?? error)
        })
        if (JSON.stringify(previous) !== JSON.stringify(list)) this.emitModelsChanged()
      } catch (error) {
        this.models.error = `Could not load this account's model list (${error?.message ?? error}); showing the built-in list.`
        this.models.errorAt = this.now()
      } finally {
        this.models.loading = null
        this.emitChange()
      }
    })()
    return this.models.loading
  }

  // ---- usage / quota -----------------------------------------------------------

  usageSnapshot() {
    if (!this.record) return null
    return { ...(this.usage.snapshot ?? {}), fetchedAt: this.usage.fetchedAt || null, error: this.usage.error, loading: !!this.usage.loading }
  }

  /** Quota windows from GET /wham/usage (cached for a minute). */
  async getUsage({ force = false } = {}) {
    await this.ready()
    if (!this.record) return null
    if (!force && this.usage.fetchedAt && this.now() - this.usage.fetchedAt < this.config.usageMaxAgeMs) return this.usageSnapshot()
    if (!this.usage.loading) {
      this.usage.loading = (async () => {
        try {
          const auth = await this.getAccessToken()
          const snapshot = await fetchUsage(auth, {
            fetchImpl: this.fetchImpl,
            backendUrl: this.endpoints.backendUrl,
            timeoutMs: this.config.metadataTimeoutMs,
            now: this.now(),
          })
          this.usage = { snapshot, fetchedAt: this.now(), error: null, loading: this.usage.loading }
        } catch (error) {
          this.usage.error = `Usage information is unavailable: ${error?.message ?? error}`
        } finally {
          this.usage.loading = null
          this.emitChange()
        }
      })()
    }
    await this.usage.loading
    return this.usageSnapshot()
  }

  /** Passive quota update from response headers or a `codex.rate_limits` event. */
  noteRateLimits(partial) {
    if (!partial || !this.record) return
    const previous = this.usage.snapshot ?? {}
    this.usage.snapshot = {
      ...previous,
      ...(partial.primary ? { primary: partial.primary } : {}),
      ...(partial.secondary ? { secondary: partial.secondary } : {}),
      ...(partial.planType ? { planType: partial.planType, plan: partial.plan ?? planLabel(partial.planType) } : {}),
      updatedAt: this.now(),
      updatedFrom: partial.source,
    }
    this.emitChange()
  }

  // ---- preferences / default model -----------------------------------------------

  /**
   * Update preferences from the settings page. Only user-editable keys are accepted;
   * `modelVisibility` merges per model id.
   */
  async updatePreferences(patch = {}) {
    await this.ready()
    const source = patch !== null && typeof patch === 'object' ? patch : {}
    const merged = { ...this.preferences }
    if (typeof source.autoRefresh === 'boolean') merged.autoRefresh = source.autoRefresh
    if (source.defaultEffort === null || typeof source.defaultEffort === 'string') merged.defaultEffort = source.defaultEffort || null
    if (source.modelVisibility && typeof source.modelVisibility === 'object') merged.modelVisibility = { ...this.preferences.modelVisibility, ...source.modelVisibility }
    return this.savePreferences(merged)
  }

  async savePreferences(candidate) {
    const next = normalizePreferences(candidate)
    const autoChanged = next.autoRefresh !== this.preferences.autoRefresh
    const visibilityChanged = JSON.stringify(next.modelVisibility) !== JSON.stringify(this.preferences.modelVisibility)
    this.preferences = next
    try {
      await this.data.savePreferences(next)
    } catch (error) {
      this.logger.warn('could not save preferences: %s', error?.message ?? error)
      throw new UserFacingError('SAVE_FAILED', `Could not save preferences: ${error?.message ?? error}`, 500)
    }
    if (autoChanged) this.scheduleRefresh()
    if (visibilityChanged) this.emitModelsChanged()
    this.emitChange()
    return this.getStatus()
  }

  currentDefaultModel() {
    try {
      const selection = this.getDefaultModelService()?.currentSelection?.()
      if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        return { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) }
      }
    } catch {
      // Not every profile composes agent-default-model.
    }
    return null
  }

  /** Make a ChatGPT model DSH's default (agentDefaultModel.saveSelection). */
  async setDefaultModel({ model, reasoningEffort } = {}) {
    await this.ready()
    if (!this.record) throw new UserFacingError('NOT_SIGNED_IN', 'Sign in with ChatGPT first.')
    if (typeof model !== 'string' || model.length === 0 || model.length > 200) throw new UserFacingError('BAD_REQUEST', 'Choose a model.')
    const entry = this.findModel(model)
    const effort = typeof reasoningEffort === 'string' && reasoningEffort.length > 0 ? reasoningEffort : undefined
    if (effort && !entry.efforts.some((e) => e.id === effort)) {
      throw new UserFacingError('BAD_REQUEST', `${entry.name} does not support the “${effort}” reasoning effort.`)
    }
    const service = this.getDefaultModelService()
    if (!service || typeof service.saveSelection !== 'function') {
      throw new UserFacingError('UNAVAILABLE', 'This DSH profile has no default-model service; choose the model in the model picker instead.', 501)
    }
    const current = this.currentDefaultModel()
    if (current && current.provider !== PROVIDER_ID) await this.savePreferences({ ...this.preferences, previousDefault: current })
    await service.saveSelection({ provider: PROVIDER_ID, model, ...(effort ? { reasoningEffort: effort } : {}) })
    return this.getStatus()
  }

  async restorePreviousDefault() {
    const service = this.getDefaultModelService()
    const current = this.currentDefaultModel()
    const previous = this.preferences.previousDefault
    if (!service || typeof service.saveSelection !== 'function' || current?.provider !== PROVIDER_ID || !previous || previous.provider === PROVIDER_ID) return null
    await service.saveSelection(previous)
    await this.savePreferences({ ...this.preferences, previousDefault: null })
    return previous
  }

  // ---- public snapshot (no secrets) ------------------------------------------------

  async getStatus() {
    await this.ready()
    const record = this.record
    const own = this.accountModels()
    return {
      plugin: { name: PACKAGE_NAME, version: PACKAGE_VERSION },
      provider: { id: PROVIDER_ID, name: PROVIDER_NAME },
      status: this.status,
      account: record ? {
        email: maskEmail(record.email),
        planType: record.plan_type ?? null,
        plan: planLabel(record.plan_type),
        expiresAt: record.expires_at,
        refreshedAt: record.refreshed_at ?? null,
        signedInAt: record.obtained_at ?? null,
      } : null,
      signIn: this.publicSignIn(),
      error: this.lastError ? { code: this.lastError.code, message: this.lastError.message, at: this.lastError.at } : null,
      preferences: {
        autoRefresh: this.preferences.autoRefresh,
        modelVisibility: { ...this.preferences.modelVisibility },
        defaultEffort: this.preferences.defaultEffort,
      },
      models: {
        source: own ? 'account' : 'catalog',
        fetchedAt: own ? this.models.fetchedAt : null,
        error: record ? this.models.error : null,
        loading: !!this.models.loading,
        items: this.availableModels().map((m) => ({
          id: m.id,
          name: m.name,
          ...(m.description ? { description: m.description } : {}),
          visible: this.isModelVisible(m),
          hiddenByDefault: m.visibility === 'hide',
          efforts: m.efforts.map((e) => ({ id: e.id, name: e.name })),
          defaultEffort: m.defaultEffort ?? null,
          contextWindow: m.contextWindow ?? null,
        })),
      },
      defaultModel: this.currentDefaultModel(),
      usage: this.usageSnapshot(),
      storage: { credentialKey: CREDENTIAL_KEY, available: this.tokens.available },
      now: this.now(),
    }
  }
}

export function createController(options) {
  return new ChatGptPlusController(options)
}
