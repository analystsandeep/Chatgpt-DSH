// OpenAI OAuth 2.0 Authorization Code flow with PKCE (RFC 7636, S256), as used by the
// official Codex CLI. Only Node built-ins are used; nothing here touches a shell.
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import {
  DEFAULTS, JWT_AUTH_CLAIM, JWT_PROFILE_CLAIM, OAUTH_AUTHORIZE_URL, OAUTH_CALLBACK_HOST,
  OAUTH_CALLBACK_PATH, OAUTH_CALLBACK_PORT, OAUTH_CLIENT_ID, OAUTH_REDIRECT_URI, OAUTH_SCOPE,
  OAUTH_TOKEN_URL, ORIGINATOR, USER_AGENT,
} from './constants.js'
import { base64url, decodeJwtPayload, escapeHtml, truncate } from './util.js'

export class OAuthError extends Error {
  /**
   * @param {string} message
   * @param {'INVALID_GRANT'|'REJECTED'|'SERVER'|'NETWORK'|'TIMEOUT'|'CANCELLED'|'BAD_RESPONSE'|'NO_ACCOUNT'|'STATE_MISMATCH'|'DENIED'|'PORT_BUSY'|'LISTEN_FAILED'} code
   */
  constructor(message, code, { status, cause, oauthError } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'OAuthError'
    this.code = code
    if (status !== undefined) this.status = status
    if (oauthError !== undefined) this.oauthError = oauthError
  }
}

/**
 * PKCE pair. The verifier is 32 random bytes in base64url (43 characters, inside the
 * 43–128 range of RFC 7636 §4.1); the challenge is base64url(SHA-256(verifier)).
 */
export function createPkcePair() {
  const verifier = base64url(randomBytes(32))
  return { verifier, challenge: pkceChallenge(verifier), method: 'S256' }
}

/** S256 transform: BASE64URL(SHA256(ASCII(code_verifier))), RFC 7636 §4.2. */
export function pkceChallenge(verifier) {
  return base64url(createHash('sha256').update(verifier, 'ascii').digest())
}

/** Unguessable `state` binding the browser redirect to this sign-in attempt (CSRF defence). */
export function createOAuthState() {
  return base64url(randomBytes(32))
}

export function buildAuthorizeUrl({
  challenge, state,
  originator = ORIGINATOR,
  redirectUri = OAUTH_REDIRECT_URI,
  authorizeUrl = OAUTH_AUTHORIZE_URL,
  clientId = OAUTH_CLIENT_ID,
}) {
  const url = new URL(authorizeUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', OAUTH_SCOPE)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('state', state)
  url.searchParams.set('originator', originator)
  return url.toString()
}

function fromParams(params) {
  const out = {}
  for (const [key, field] of [['code', 'code'], ['state', 'state'], ['error', 'error'], ['error_description', 'errorDescription']]) {
    const value = params.get(key)
    if (value) out[field] = value
  }
  return out
}

/**
 * Parse what a user pastes when the redirect could not reach the local listener:
 * the full redirect URL, a bare query string, `code#state`, or just the code.
 */
export function parseCallbackInput(input) {
  const value = String(input ?? '').trim()
  if (value.length === 0) return {}
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      const fromQuery = fromParams(url.searchParams)
      if (Object.keys(fromQuery).length > 0) return fromQuery
      return fromParams(new URLSearchParams(url.hash.replace(/^#/, '')))
    } catch {
      return {}
    }
  }
  if (/(^|[?&#])(code|error)=/.test(value)) return fromParams(new URLSearchParams(value.replace(/^[?#]/, '')))
  if (value.includes('#')) {
    const [code, state] = value.split('#', 2)
    return { ...(code ? { code } : {}), ...(state ? { state } : {}) }
  }
  if (/\s/.test(value)) return {}
  return { code: value }
}

async function postTokenRequest(params, { fetchImpl = globalThis.fetch, signal, timeoutMs = DEFAULTS.tokenRequestTimeoutMs, tokenUrl = OAUTH_TOKEN_URL, operation }) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response
  try {
    response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      body: new URLSearchParams(params).toString(),
      signal: combined,
    })
  } catch (error) {
    if (signal?.aborted) throw new OAuthError(`${operation} was cancelled.`, 'CANCELLED', { cause: error })
    if (timeout.aborted) throw new OAuthError(`${operation} timed out after ${Math.round(timeoutMs / 1000)}s waiting for auth.openai.com.`, 'TIMEOUT', { cause: error })
    const reason = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error)
    throw new OAuthError(`${operation} failed: could not reach auth.openai.com (${truncate(reason, 160)}).`, 'NETWORK', { cause: error })
  }
  let text = ''
  try {
    text = await response.text()
  } catch (error) {
    if (timeout.aborted) throw new OAuthError(`${operation} timed out after ${Math.round(timeoutMs / 1000)}s waiting for auth.openai.com.`, 'TIMEOUT', { cause: error })
    throw new OAuthError(`${operation} failed while reading the response.`, 'NETWORK', { cause: error })
  }
  let json
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }
  if (!response.ok) {
    const oauthError = typeof json?.error === 'string' ? json.error
      : typeof json?.error?.code === 'string' ? json.error.code : undefined
    const description = [json?.error_description, json?.error?.message, json?.message].find((v) => typeof v === 'string' && v.length > 0)
    // invalid_grant (and its OpenAI-specific variants) means the code or refresh token is
    // dead: expired, revoked, or already used. Retrying cannot help; the user must sign in.
    // auth.openai.com answers an unusable refresh token with HTTP 401 and
    // {"error":{"code":"token_expired","message":"Could not validate your token..."}}.
    const dead = response.status === 401 || /invalid_grant|token_expired|refresh_token_(?:expired|reused|invalidated)|token_revoked/i.test(oauthError ?? '')
    const code = dead ? 'INVALID_GRANT' : response.status >= 500 ? 'SERVER' : 'REJECTED'
    throw new OAuthError(
      `${operation} failed (HTTP ${response.status}${oauthError ? `, ${oauthError}` : ''})${description ? `: ${truncate(description, 300)}` : '.'}`,
      code, { status: response.status, oauthError })
  }
  if (!json || typeof json.access_token !== 'string' || json.access_token.length === 0) {
    throw new OAuthError(`${operation} returned an unexpected response (no access_token).`, 'BAD_RESPONSE', { status: response.status })
  }
  return json
}

export async function exchangeAuthorizationCode({ code, verifier, redirectUri = OAUTH_REDIRECT_URI, clientId = OAUTH_CLIENT_ID, ...options }) {
  const json = await postTokenRequest({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  }, { ...options, operation: 'Token exchange' })
  if (typeof json.refresh_token !== 'string' || json.refresh_token.length === 0) {
    throw new OAuthError('Token exchange returned no refresh token (offline access was not granted).', 'BAD_RESPONSE')
  }
  return json
}

export async function refreshAccessToken({ refreshToken, clientId = OAUTH_CLIENT_ID, ...options }) {
  return postTokenRequest({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  }, { ...options, operation: 'Token refresh' })
}

/**
 * Build the credential-record payload from a token-endpoint response. Refresh responses may
 * omit `refresh_token`/`id_token`; the previous values are kept in that case. Derived claims
 * (account id, email, plan) are cached for display and request routing only.
 */
export function buildGrantPayload(tokenJson, previous, now = Date.now(), fallbackLifetimeMs = DEFAULTS.fallbackTokenLifetimeMs) {
  const accessToken = tokenJson.access_token
  const refreshToken = typeof tokenJson.refresh_token === 'string' && tokenJson.refresh_token ? tokenJson.refresh_token : previous?.refresh_token
  const idToken = typeof tokenJson.id_token === 'string' && tokenJson.id_token ? tokenJson.id_token : previous?.id_token
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new OAuthError('The token response has no refresh token.', 'BAD_RESPONSE')
  }
  const accessClaims = decodeJwtPayload(accessToken) ?? {}
  const idClaims = decodeJwtPayload(idToken) ?? {}
  const auth = { ...(idClaims[JWT_AUTH_CLAIM] ?? {}), ...(accessClaims[JWT_AUTH_CLAIM] ?? {}) }
  const accountId = typeof auth.chatgpt_account_id === 'string' && auth.chatgpt_account_id ? auth.chatgpt_account_id : previous?.account_id
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new OAuthError('This sign-in did not return a ChatGPT account (no chatgpt_account_id claim). Sign in with a ChatGPT Plus, Pro, Business or Enterprise account.', 'NO_ACCOUNT')
  }
  let expiresAt
  if (typeof tokenJson.expires_in === 'number' && Number.isFinite(tokenJson.expires_in) && tokenJson.expires_in > 0) expiresAt = now + tokenJson.expires_in * 1000
  else if (typeof accessClaims.exp === 'number' && accessClaims.exp > 0) expiresAt = accessClaims.exp * 1000
  else expiresAt = now + fallbackLifetimeMs
  const email = [idClaims.email, accessClaims[JWT_PROFILE_CLAIM]?.email, previous?.email].find((v) => typeof v === 'string' && v.length > 0)
  const planType = [auth.chatgpt_plan_type, previous?.plan_type].find((v) => typeof v === 'string' && v.length > 0)
  return {
    v: 1,
    access_token: accessToken,
    refresh_token: refreshToken,
    ...(idToken ? { id_token: idToken } : {}),
    expires_at: Math.round(expiresAt),
    account_id: accountId,
    ...(email ? { email } : {}),
    ...(planType ? { plan_type: planType } : {}),
    obtained_at: typeof previous?.obtained_at === 'number' ? previous.obtained_at : now,
    refreshed_at: now,
  }
}

/** Validate a stored payload read back from the credential store. */
export function isGrantPayload(value) {
  return value !== null && typeof value === 'object'
    && typeof value.access_token === 'string' && value.access_token.length > 0
    && typeof value.refresh_token === 'string' && value.refresh_token.length > 0
    && typeof value.account_id === 'string' && value.account_id.length > 0
    && typeof value.expires_at === 'number' && Number.isFinite(value.expires_at)
}

function page(title, message, ok) {
  const color = ok ? '#087f5b' : '#d92d20'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>`
    + '<body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f7f7f8;color:#1f2328;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">'
    + '<main style="max-width:480px;padding:32px;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08)">'
    + `<h1 style="font-size:20px;margin:0 0 12px;color:${color}">${escapeHtml(title)}</h1>`
    + `<p style="font-size:14px;line-height:1.5;margin:0">${escapeHtml(message)}</p></main></body></html>`
}

function sendPage(res, status, title, message, ok) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    connection: 'close',
  })
  res.end(page(title, message, ok))
}

function listen(server, port, host) {
  return new Promise((resolveListen, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ port, host, exclusive: true })
  })
}

/**
 * Listen for the OAuth redirect on 127.0.0.1:<port><path> for one sign-in attempt.
 * Requests whose `state` does not match are refused, so a stale tab or a foreign page
 * cannot inject a code. `onResult({code}|{error, errorDescription})` decides the page shown.
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 * @throws {OAuthError} PORT_BUSY when the port is taken (e.g. Codex CLI or another DSH
 *   plugin is mid-sign-in), LISTEN_FAILED for any other bind failure.
 */
export async function startCallbackServer({
  host = OAUTH_CALLBACK_HOST,
  port = OAUTH_CALLBACK_PORT,
  path = OAUTH_CALLBACK_PATH,
  expectedState,
  onResult,
  resultTimeoutMs = 30_000,
}) {
  const sockets = new Set()
  const servers = []
  const handler = async (req, res) => {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      sendPage(res, 400, 'Bad request', 'The request could not be parsed.', false)
      return
    }
    if (req.method !== 'GET' || url.pathname !== path) {
      sendPage(res, 404, 'Not found', 'This address only handles the ChatGPT sign-in redirect for DeepSeek Harness.', false)
      return
    }
    const params = fromParams(url.searchParams)
    if (params.state !== expectedState) {
      sendPage(res, 400, 'Sign-in link expired', 'This sign-in response does not belong to the current attempt. Go back to DeepSeek Harness and click “Sign in with ChatGPT” again.', false)
      return
    }
    let outcome
    try {
      outcome = await Promise.race([
        Promise.resolve(onResult(params)),
        new Promise((r) => setTimeout(() => r({ ok: true, pending: true }), resultTimeoutMs).unref?.()),
      ])
    } catch (error) {
      outcome = { ok: false, message: String(error?.message ?? error) }
    }
    if (outcome?.ok) {
      sendPage(res, 200, 'Signed in to ChatGPT', outcome.pending
        ? 'DeepSeek Harness received the sign-in and is finishing it now. You can close this tab and return to DSH.'
        : 'You can close this tab and return to DeepSeek Harness. ChatGPT models are now available in the model picker.', true)
    } else {
      sendPage(res, 400, 'Sign-in failed', outcome?.message ?? 'The sign-in could not be completed. Return to DeepSeek Harness and try again.', false)
    }
  }

  const make = () => {
    const server = createServer((req, res) => {
      handler(req, res).catch(() => {
        if (!res.headersSent) sendPage(res, 500, 'Sign-in failed', 'Unexpected error.', false)
      })
    })
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    return server
  }

  const primary = make()
  try {
    await listen(primary, port, host)
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      throw new OAuthError(`Port ${port} on ${host} is already in use (another app such as the Codex CLI or another DSH plugin may be signing in).`, 'PORT_BUSY', { cause: error })
    }
    if (error?.code === 'EACCES') {
      // On Windows this usually means the port falls inside a range reserved by Hyper-V/WSL.
      throw new OAuthError(`Port ${port} on ${host} is not available (access denied; on Windows it may be reserved by Hyper-V or WSL).`, 'PORT_BUSY', { cause: error })
    }
    throw new OAuthError(`Could not listen on ${host}:${port} (${error?.code ?? error?.message ?? error}).`, 'LISTEN_FAILED', { cause: error })
  }
  servers.push(primary)
  const actualPort = primary.address()?.port ?? port

  // Browsers may resolve `localhost` to ::1 first. Listening there too is best effort: if
  // IPv6 is disabled or the port is taken on ::1, the IPv4 listener still serves the redirect.
  if (host === '127.0.0.1') {
    const secondary = make()
    try {
      await listen(secondary, actualPort, '::1')
      servers.push(secondary)
    } catch {
      secondary.close()
    }
  }

  let closed = false
  return {
    port: actualPort,
    close: () => {
      if (closed) return Promise.resolve()
      closed = true
      return Promise.all(servers.map((server) => new Promise((done) => {
        server.close(() => done())
        server.closeIdleConnections?.()
      }))).then(() => {
        for (const socket of sockets) socket.destroy()
      }).catch(() => {})
    },
  }
}

/**
 * Open the user's default browser on the authorize URL with child_process.spawn, without a
 * shell: no cmd.exe, PowerShell, sh, bash or tmux. On Windows `rundll32 url.dll,
 * FileProtocolHandler` receives the URL as a plain argument, so `&` in the query string needs
 * no escaping; `explorer.exe` is the fallback. Only our own https authorize URL is accepted.
 * @returns {Promise<boolean>} whether a launcher process could be started.
 */
export function openBrowser(url, { platform = process.platform, spawnImpl = spawn, allowedOrigin = new URL(OAUTH_AUTHORIZE_URL).origin } = {}) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return Promise.resolve(false)
  }
  if (parsed.protocol !== 'https:' || parsed.origin !== allowedOrigin) return Promise.resolve(false)
  const href = parsed.toString()
  const candidates = platform === 'win32'
    ? [['rundll32.exe', ['url.dll,FileProtocolHandler', href]], ['explorer.exe', [href]]]
    : platform === 'darwin'
      ? [['open', [href]]]
      : [['xdg-open', [href]]]
  const attempt = (index) => {
    if (index >= candidates.length) return Promise.resolve(false)
    const [command, args] = candidates[index]
    return new Promise((done) => {
      let child
      try {
        child = spawnImpl(command, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false })
      } catch {
        done(attempt(index + 1))
        return
      }
      child.once('error', () => done(attempt(index + 1)))
      child.once('spawn', () => {
        child.unref?.()
        done(true)
      })
    })
  }
  return attempt(0)
}
