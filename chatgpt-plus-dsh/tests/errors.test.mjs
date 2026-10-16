// Error handling: refresh failures, network timeouts, invalid tokens, quota and rate limits.
import {
  CREDENTIAL_KEY, FakeCredentials, accessTokenFor, collect, fakeJwt, grantPayload, isResponsesEndpoint, isTokenEndpoint, jsonResponse,
  mockFetch, sampleTurnEvents, sseResponse, tempDir, tokenResponse,
} from './helpers.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatGptPlusController } from '../lib/controller.js'
import { ChatGptPlusError, classifyHttpError, classifyStreamFailure, parseRetryAfter } from '../lib/errors.js'
import { OAuthError, exchangeAuthorizationCode, refreshAccessToken } from '../lib/oauth.js'
import { createChatGptAdapter } from '../lib/provider.js'
import { DataStore, TokenStore } from '../lib/store.js'

// A request that never answers. A real pending socket keeps Node's event loop alive; these
// doubles hold a ref'd timer for the same reason (AbortSignal.timeout timers are unref'd, so
// without it Node 20 would exit the loop before the timeout under test fires).
function hangingFetch(url, init) {
  return new Promise((resolve, reject) => {
    const keepAlive = setTimeout(() => {}, 60_000)
    init.signal.addEventListener('abort', () => {
      clearTimeout(keepAlive)
      reject(init.signal.reason ?? new DOMException('aborted', 'AbortError'))
    }, { once: true })
  })
}

// A 200 response whose event stream sends one heartbeat and then stalls.
function stalledStream() {
  let keepAlive
  const body = new ReadableStream({
    start(controller) {
      keepAlive = setTimeout(() => {}, 60_000)
      controller.enqueue(new TextEncoder().encode(': ping\n\n'))
    },
    cancel() {
      clearTimeout(keepAlive)
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/**
 * The rule @deepseek-ai/dsh-llm's normalizeLlmFailure uses to keep an adapter's structured
 * failure: an own data property `failure` (valid snapshot) whose code equals an own data
 * property `code`. Anything else degrades to {message, code: 'UNKNOWN'}.
 */
function carriedFailure(error) {
  const failure = Object.getOwnPropertyDescriptor(error, 'failure')
  const code = Object.getOwnPropertyDescriptor(error, 'code')
  if (!failure || !('value' in failure) || !code || !('value' in code)) return undefined
  const f = failure.value
  if (typeof f.message !== 'string' || !f.message || typeof f.code !== 'string' || !f.code || f.code !== code.value) return undefined
  if (f.status !== undefined && !(Number.isInteger(f.status) && f.status >= 100 && f.status <= 599)) return undefined
  if (f.providerRetryAfterMs !== undefined && !(Number.isFinite(f.providerRetryAfterMs) && f.providerRetryAfterMs > 0)) return undefined
  return f
}

function setup({ grant = grantPayload(), fetchImpl, autoRefresh } = {}) {
  const credentials = new FakeCredentials()
  const data = tempDir()
  const controller = new ChatGptPlusController({ credentials, fetchImpl, dataDir: data.dir, config: { callbackPort: 0, tokenRequestTimeoutMs: 200, requestTimeoutMs: 300, streamIdleTimeoutMs: 300 } })
  return {
    credentials,
    controller,
    async start() {
      if (grant) await new TokenStore(credentials).write(grant)
      // Saved before start, so the startup model-list request already sees the preference.
      if (autoRefresh === false) await new DataStore(data.dir).savePreferences({ autoRefresh: false })
      controller.start()
      await controller.ready()
    },
    cleanup() {
      controller.dispose()
      data.cleanup()
    },
  }
}

test('ChatGptPlusError carries code/status/retry-after the way DSH keeps adapter failures', () => {
  const error = new ChatGptPlusError('limit', 'RATE_LIMIT', { status: 429, retryAfterMs: 1500, requestId: 'req-1' })
  assert.deepEqual(carriedFailure(error), { message: 'limit', code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 1500, requestId: 'req-1' })
  assert.ok(Object.isFrozen(error.failure))
  assert.deepEqual(carriedFailure(new ChatGptPlusError('x', 'AUTH', { status: 99, retryAfterMs: -5 })), { message: 'x', code: 'AUTH' })
})

test('refresh failure (invalid_grant) marks the sign-in expired and never retries the dead token', async () => {
  const fetchImpl = mockFetch([{ match: isTokenEndpoint, respond: () => jsonResponse({ error: 'invalid_grant', error_description: 'Refresh token has been revoked' }, 400) }])
  const env = setup({ grant: grantPayload({ expires_at: Date.now() - 1000 }), fetchImpl })
  try {
    await env.start()
    await assert.rejects(env.controller.getAccessToken(), (error) => {
      assert.equal(error.code, 'INVALID_CREDENTIAL')
      assert.match(error.message, /Sign in again/)
      assert.ok(carriedFailure(error))
      return true
    })
    assert.equal(env.controller.status, 'expired')
    assert.equal((await env.controller.getStatus()).error.code, 'REFRESH_REJECTED')
    await assert.rejects(env.controller.getAccessToken(), (e) => e.code === 'INVALID_CREDENTIAL')
    assert.equal(fetchImpl.calls.filter((c) => isTokenEndpoint(c.url)).length, 1, 'a rejected refresh token is not sent again')
    assert.equal(env.credentials.records.has(CREDENTIAL_KEY), true, 'the record is kept so the UI can offer “Sign in again”')
    assert.equal(env.controller.refreshTimer, null, 'no background retries for a dead token')
  } finally {
    env.cleanup()
  }
})

// DSH 0.2.1-alpha.3's chat view (dsh-client-ui-chat failureMessage) replaces the adapter's
// message with fixed text for these codes; every other code is shown verbatim.
const DSH_FIXED_TEXT_CODES = new Set(['ACCOUNT_SIGNED_OUT', 'INTERRUPTED', 'ACCOUNT_SIGN_IN_REQUIRED', 'QUOTA', 'ACCOUNT_QUOTA', 'AUTH'])

test('sign-in problems use codes whose message DSH shows verbatim (never “API key is invalid”)', async () => {
  const produced = []
  const missing = setup({ grant: null, fetchImpl: mockFetch([]) })
  try {
    await missing.start()
    await missing.controller.getAccessToken().catch((e) => produced.push(e))
  } finally {
    missing.cleanup()
  }
  const dead = setup({ grant: grantPayload({ expires_at: Date.now() - 1 }), fetchImpl: mockFetch([{ match: isTokenEndpoint, respond: () => jsonResponse({ error: { code: 'token_expired', message: 'Could not validate your token.' } }, 401) }]) })
  try {
    await dead.start()
    await dead.controller.getAccessToken().catch((e) => produced.push(e))
    await dead.controller.getAccessToken().catch((e) => produced.push(e))
  } finally {
    dead.cleanup()
  }
  const off = setup({ grant: grantPayload({ expires_at: Date.now() - 1 }), fetchImpl: mockFetch([]), autoRefresh: false })
  try {
    await off.start()
    await off.controller.getAccessToken().catch((e) => produced.push(e))
  } finally {
    off.cleanup()
  }
  produced.push(classifyHttpError(401, '', new Headers()))
  assert.equal(produced.length, 5)
  for (const error of produced) {
    assert.ok(!DSH_FIXED_TEXT_CODES.has(error.code), `${error.code} would be rendered as fixed text`)
    assert.match(error.message, /Sign in|sign-in|Refresh token/i)
  }
})

test('refresh rejected with the body auth.openai.com actually returns (401 token_expired)', async () => {
  const body = { error: { message: 'Could not validate your token. Please try signing in again.', type: 'invalid_request_error', param: null, code: 'token_expired' } }
  for (const status of [401, 400]) {
    const fetchImpl = mockFetch([{ match: isTokenEndpoint, respond: () => jsonResponse(body, status) }])
    await assert.rejects(refreshAccessToken({ refreshToken: 'r', fetchImpl }), (e) => e.code === 'INVALID_GRANT' && /Could not validate your token/.test(e.message))
  }
  // The responses endpoint's real answer to an unusable access token.
  const auth = classifyHttpError(401, JSON.stringify({ detail: 'Could not parse your authentication token. Please try signing in again.' }), new Headers())
  assert.equal(auth.code, 'INVALID_CREDENTIAL')
})

test('network timeout on refresh: expired token → TIMEOUT error, still-valid token keeps working', async () => {
  const hang = hangingFetch
  const expired = setup({ grant: grantPayload({ expires_at: Date.now() - 1000 }), fetchImpl: mockFetch([{ match: isTokenEndpoint, respond: hang }]) })
  try {
    await expired.start()
    const started = Date.now()
    await assert.rejects(expired.controller.getAccessToken(), (error) => error.code === 'TIMEOUT' && /timed out/.test(error.message))
    assert.ok(Date.now() - started < 3000)
    assert.equal(expired.controller.status, 'expired')
  } finally {
    expired.cleanup()
  }
  const valid = setup({ grant: grantPayload({ expires_at: Date.now() + 60_000 }), fetchImpl: mockFetch([{ match: isTokenEndpoint, respond: hang }]) })
  try {
    await valid.start()
    const auth = await valid.controller.getAccessToken()
    assert.ok(auth.accessToken, 'transient refresh failure does not block a token that is still valid')
  } finally {
    valid.cleanup()
  }
})

test('network failures are classified (DNS/connection → NETWORK, 5xx → SERVER)', async () => {
  const offline = mockFetch([{ match: isTokenEndpoint, respond: () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e } }])
  await assert.rejects(refreshAccessToken({ refreshToken: 'r', fetchImpl: offline }), (e) => e instanceof OAuthError && e.code === 'NETWORK' && /ENOTFOUND/.test(e.message))
  const down = mockFetch([{ match: isTokenEndpoint, respond: () => jsonResponse({ error: 'server_error' }, 503) }])
  await assert.rejects(refreshAccessToken({ refreshToken: 'r', fetchImpl: down }), (e) => e.code === 'SERVER')
})

test('invalid token: a 401 triggers one forced refresh and the request is retried', async () => {
  let responses = 0
  const fetchImpl = mockFetch([
    { match: isTokenEndpoint, respond: () => tokenResponse({ refreshToken: 'rt-after-401' }) },
    { match: isResponsesEndpoint, respond: () => (++responses === 1 ? jsonResponse({ error: { message: 'token expired' } }, 401) : sseResponse(sampleTurnEvents())) },
  ])
  const env = setup({ fetchImpl })
  try {
    await env.start()
    const adapter = createChatGptAdapter({ controller: env.controller, fetchImpl })
    const chunks = await collect(adapter.stream({ provider: 'chatgpt-plus', model: 'gpt-5.5', messages: [] }))
    assert.equal(chunks.at(-1).type, 'finish')
    const relevant = fetchImpl.calls.filter((c) => isTokenEndpoint(c.url) || isResponsesEndpoint(c.url))
    assert.deepEqual(relevant.map((c) => (isTokenEndpoint(c.url) ? 'token' : 'responses')), ['responses', 'token', 'responses'])
    const [first, , second] = relevant
    assert.notEqual(first.init.headers.authorization, second.init.headers.authorization)
    assert.equal(env.credentials.records.get(CREDENTIAL_KEY).payload.refresh_token, 'rt-after-401')
  } finally {
    env.cleanup()
  }
})

test('invalid token: a 401 that survives the refresh surfaces INVALID_CREDENTIAL and asks to sign in again', async () => {
  const fetchImpl = mockFetch([
    { match: isTokenEndpoint, respond: () => tokenResponse() },
    { match: isResponsesEndpoint, respond: () => jsonResponse({ error: { message: 'invalid token' } }, 401) },
  ])
  const env = setup({ fetchImpl })
  try {
    await env.start()
    const adapter = createChatGptAdapter({ controller: env.controller, fetchImpl })
    await assert.rejects(collect(adapter.stream({ provider: 'chatgpt-plus', model: 'gpt-5.5', messages: [] })), (e) => e.code === 'INVALID_CREDENTIAL' && e.status === 401 && /Sign in/.test(e.message))
    assert.equal(env.controller.status, 'expired')
    assert.equal((await env.controller.getStatus()).error.code, 'TOKEN_REJECTED')
  } finally {
    env.cleanup()
  }
})

test('invalid token: a sign-in without a ChatGPT account claim is refused (NO_ACCOUNT)', async () => {
  const noAccount = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 600 })
  const fetchImpl = mockFetch([{ match: isTokenEndpoint, respond: () => jsonResponse({ access_token: noAccount, refresh_token: 'r', id_token: fakeJwt({ email: 'x@y.z' }), expires_in: 600 }) }])
  const env = setup({ grant: null, fetchImpl })
  try {
    await env.start()
    await env.controller.beginSignIn({ openBrowser: false })
    await assert.rejects(env.controller.completeSignIn('code-123'), (e) => /no ChatGPT account|did not return a ChatGPT account/i.test(e.message))
    assert.equal(env.credentials.records.has(CREDENTIAL_KEY), false)
    assert.equal(env.controller.status, 'signed-out')
  } finally {
    env.cleanup()
  }
})

test('token exchange rejects responses without access or refresh tokens', async () => {
  const empty = mockFetch([{ match: isTokenEndpoint, respond: () => jsonResponse({ token_type: 'Bearer' }) }])
  await assert.rejects(exchangeAuthorizationCode({ code: 'c', verifier: 'v', fetchImpl: empty }), (e) => e.code === 'BAD_RESPONSE')
  const noRefresh = mockFetch([{ match: isTokenEndpoint, respond: () => jsonResponse({ access_token: accessTokenFor(), expires_in: 60 }) }])
  await assert.rejects(exchangeAuthorizationCode({ code: 'c', verifier: 'v', fetchImpl: noRefresh }), (e) => e.code === 'BAD_RESPONSE' && /refresh token/.test(e.message))
  const invalidCode = mockFetch([{ match: isTokenEndpoint, respond: () => jsonResponse({ error: 'invalid_grant', error_description: 'Invalid authorization code' }, 400) }])
  await assert.rejects(exchangeAuthorizationCode({ code: 'c', verifier: 'v', fetchImpl: invalidCode }), (e) => e.code === 'INVALID_GRANT' && /Invalid authorization code/.test(e.message))
})

test('auto-refresh off: an expired token fails clearly instead of refreshing', async () => {
  const fetchImpl = mockFetch([{ match: isTokenEndpoint, respond: () => tokenResponse() }])
  const env = setup({ grant: grantPayload({ expires_at: Date.now() - 1 }), fetchImpl, autoRefresh: false })
  try {
    await env.start()
    await assert.rejects(env.controller.getAccessToken(), (e) => e.code === 'INVALID_CREDENTIAL' && /automatic refresh is turned off/.test(e.message))
    const tokenCalls = () => fetchImpl.calls.filter((c) => isTokenEndpoint(c.url)).length
    assert.equal(tokenCalls(), 0)
    assert.equal(env.controller.status, 'expired')
    // The manual “Refresh token now” still works.
    await env.controller.refreshNow()
    assert.equal(tokenCalls(), 1)
    assert.equal(env.controller.status, 'connected')
  } finally {
    env.cleanup()
  }
})

test('quota exhaustion vs rate limiting are distinguished with actionable messages', () => {
  const now = 1_760_000_000_000
  const quota = classifyHttpError(429, JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'plus', resets_at: now / 1000 + 2 * 3600 + 15 * 60 } }), new Headers(), { now })
  assert.equal(quota.code, 'QUOTA')
  assert.match(quota.message, /ChatGPT Plus usage limit/)
  assert.match(quota.message, /resets in about 2h 15m/)
  assert.equal(quota.failure.providerRetryAfterMs, (2 * 3600 + 15 * 60) * 1000)

  const notIncluded = classifyHttpError(403, JSON.stringify({ error: { code: 'usage_not_included', plan_type: 'free' } }), new Headers())
  assert.equal(notIncluded.code, 'QUOTA')
  assert.match(notIncluded.message, /does not include Codex/)

  const limited = classifyHttpError(429, JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Slow down' } }), new Headers({ 'retry-after': '12', 'x-request-id': 'req-42' }))
  assert.equal(limited.code, 'RATE_LIMIT')
  assert.equal(limited.failure.providerRetryAfterMs, 12_000)
  assert.equal(limited.failure.requestId, 'req-42')
  assert.match(limited.message, /Retry in about 12s/)
})

test('HTTP error taxonomy', () => {
  const h = new Headers()
  assert.equal(classifyHttpError(400, JSON.stringify({ error: { code: 'context_length_exceeded', message: 'Your input exceeds the context window' } }), h).code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(classifyHttpError(400, JSON.stringify({ detail: "The 'gpt-x' model is not supported when using Codex with a ChatGPT account." }), h).code, 'UNKNOWN_MODEL')
  assert.equal(classifyHttpError(404, '', h, { model: 'gpt-x' }).code, 'UNKNOWN_MODEL')
  assert.equal(classifyHttpError(400, JSON.stringify({ error: { message: 'Unknown parameter' } }), h).code, 'INVALID_REQUEST')
  assert.equal(classifyHttpError(401, '', h).code, 'INVALID_CREDENTIAL')
  const blocked = classifyHttpError(403, '<html><title>Attention Required! | Cloudflare</title></html>', h)
  assert.equal(blocked.code, 'HTTP_403')
  assert.match(blocked.message, /Cloudflare/)
  assert.equal(classifyHttpError(502, 'bad gateway', h).code, 'SERVER')
  assert.equal(classifyHttpError(418, '', h).code, 'HTTP_418')
  assert.equal(parseRetryAfter(new Headers({ 'retry-after-ms': '250' })), 250)
  assert.equal(parseRetryAfter(new Headers({ 'retry-after': new Date(Date.now() + 5000).toUTCString() })) > 3000, true)
})

test('in-stream failures (response.failed / error events) map to the same taxonomy', async () => {
  assert.equal(classifyStreamFailure({ code: 'rate_limit_exceeded', message: 'Rate limit reached' }).code, 'RATE_LIMIT')
  assert.equal(classifyStreamFailure({ code: 'usage_limit_reached', message: 'limit', resets_in_seconds: 60 }).code, 'QUOTA')
  assert.equal(classifyStreamFailure({ code: 'context_length_exceeded' }).code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(classifyStreamFailure({ code: 'server_error', message: 'oops' }).code, 'SERVER')

  const fetchImpl = mockFetch([{ match: isResponsesEndpoint, respond: () => sseResponse([
    { type: 'response.created', response: { id: 'r' } },
    { type: 'response.failed', response: { status: 'failed', error: { code: 'rate_limit_exceeded', message: 'Rate limit reached for gpt-5.5' } } },
  ]) }])
  const env = setup({ fetchImpl })
  try {
    await env.start()
    const adapter = createChatGptAdapter({ controller: env.controller, fetchImpl })
    await assert.rejects(collect(adapter.stream({ provider: 'chatgpt-plus', model: 'gpt-5.5', messages: [] })), (e) => e.code === 'RATE_LIMIT' && carriedFailure(e) !== undefined)
  } finally {
    env.cleanup()
  }
})

test('request timeouts: no response headers → TIMEOUT; stalled stream → TIMEOUT; cancel → ABORTED', async () => {
  const hang = hangingFetch
  const stalledBody = stalledStream
  for (const [label, respond, expected] of [['headers', hang, /did not respond within/], ['idle', stalledBody, /stalled/]]) {
    const fetchImpl = mockFetch([{ match: isResponsesEndpoint, respond }])
    const env = setup({ fetchImpl })
    try {
      await env.start()
      const adapter = createChatGptAdapter({ controller: env.controller, fetchImpl, requestTimeoutMs: 150, streamIdleTimeoutMs: 150 })
      await assert.rejects(collect(adapter.stream({ provider: 'chatgpt-plus', model: 'gpt-5.5', messages: [] })), (e) => e.code === 'TIMEOUT' && expected.test(e.message), label)
    } finally {
      env.cleanup()
    }
  }
  const fetchImpl = mockFetch([{ match: isResponsesEndpoint, respond: hang }])
  const env = setup({ fetchImpl })
  try {
    await env.start()
    const adapter = createChatGptAdapter({ controller: env.controller, fetchImpl })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 30)
    await assert.rejects(collect(adapter.stream({ provider: 'chatgpt-plus', model: 'gpt-5.5', messages: [], signal: controller.signal })), (e) => e.code === 'ABORTED')
  } finally {
    env.cleanup()
  }
})

test('transport failure before streaming is TRANSPORT (retryable by DSH)', async () => {
  const fetchImpl = mockFetch([{ match: isResponsesEndpoint, respond: () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNRESET' }; throw e } }])
  const env = setup({ fetchImpl })
  try {
    await env.start()
    const adapter = createChatGptAdapter({ controller: env.controller, fetchImpl })
    await assert.rejects(collect(adapter.stream({ provider: 'chatgpt-plus', model: 'gpt-5.5', messages: [] })), (e) => e.code === 'TRANSPORT' && /ECONNRESET/.test(e.message))
  } finally {
    env.cleanup()
  }
})

test('not signed in: model calls fail with MISSING_CREDENTIAL and a sign-in hint', async () => {
  const env = setup({ grant: null, fetchImpl: mockFetch([]) })
  try {
    await env.start()
    const adapter = createChatGptAdapter({ controller: env.controller })
    await assert.rejects(collect(adapter.stream({ provider: 'chatgpt-plus', model: 'gpt-5.5', messages: [] })), (e) => e.code === 'MISSING_CREDENTIAL' && /Sign in with ChatGPT/.test(e.message))
  } finally {
    env.cleanup()
  }
})
