// Shared offline test fixtures. Nothing here touches the network, the real DSH home, the
// real credential store or a real browser:
//   * DSH_HOME points at a throw-away temp directory for the whole test process;
//   * CHATGPT_PLUS_DSH_NO_BROWSER=1 stops the controller from launching a browser;
//   * OAuth callback listeners bind an ephemeral port (callbackPort: 0), never 1455.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The real fetch, captured before any test replaces globalThis.fetch; used to talk to local
// test servers only.
export const realFetch = globalThis.fetch

const processHome = mkdtempSync(join(tmpdir(), 'cgp-test-home-'))
process.env.DSH_HOME = processHome
process.env.CHATGPT_PLUS_DSH_NO_BROWSER = '1'
process.on('exit', () => {
  try {
    rmSync(processHome, { recursive: true, force: true })
  } catch {
    // Best effort cleanup of the temp home.
  }
})

export const CREDENTIAL_KEY = 'chatgpt-plus/account'

export function tempDir(prefix = 'cgp-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')

/** Unsigned JWT with the given claims (the plugin only decodes claims, OpenAI verifies). */
export function fakeJwt(claims) {
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.c2lnbmF0dXJl`
}

export function accessTokenFor({ accountId = 'acct-test-1', plan = 'plus', expiresInSeconds = 3600, now = Date.now() } = {}) {
  // `jti` makes every token unique, like real access tokens, even when minted in the same second.
  return fakeJwt({ exp: Math.floor(now / 1000) + expiresInSeconds, jti: randomUUID(), 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: plan } })
}

export function idTokenFor({ email = 'jane.doe@example.com', accountId = 'acct-test-1', plan = 'plus' } = {}) {
  return fakeJwt({ email, 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: plan } })
}

export function grantPayload(overrides = {}) {
  const now = Date.now()
  return {
    v: 1,
    access_token: accessTokenFor(),
    refresh_token: 'rt-initial',
    id_token: idTokenFor(),
    expires_at: now + 3600_000,
    account_id: 'acct-test-1',
    email: 'jane.doe@example.com',
    plan_type: 'plus',
    obtained_at: now,
    refreshed_at: now,
    ...overrides,
  }
}

/**
 * In-memory stand-in for ctx.credentials with the semantics of
 * @deepseek-ai/dsh-credentials-local: `<scope>/<id>` keys, serialized read-modify-write,
 * payloads that must survive a JSON round trip, `undefined` from mutate = no write.
 */
export class FakeCredentials {
  constructor() {
    this.records = new Map()
    this.queue = Promise.resolve()
    this.writes = 0
    this.deletes = 0
  }

  serialize(operation) {
    const task = this.queue.then(operation)
    this.queue = task.then(() => {}, () => {})
    return task
  }

  async readRecord(key) {
    const record = this.records.get(key)
    return record === undefined ? undefined : structuredClone(record)
  }

  async describeRecord(key) {
    const record = this.records.get(key)
    return { configured: record !== undefined, ...(record ? { kind: record.kind } : {}), writable: true }
  }

  async listRecords() {
    return [...this.records].map(([key, record]) => ({ key, kind: record.kind }))
  }

  modifyRecord(key, mutate) {
    return this.serialize(async () => {
      if (!/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(key)) throw new TypeError(`invalid credential key ${key}`)
      const current = this.records.get(key)
      const next = await mutate(current === undefined ? undefined : structuredClone(current))
      if (next === undefined) return current === undefined ? undefined : structuredClone(current)
      const roundTripped = JSON.parse(JSON.stringify(next))
      this.records.set(key, roundTripped)
      this.writes += 1
      return structuredClone(roundTripped)
    })
  }

  deleteRecord(key) {
    return this.serialize(async () => {
      this.records.delete(key)
      this.deletes += 1
    })
  }
}

/**
 * Tiny fetch router. Each route: { match(url, init) → boolean, respond(url, init) → Response }.
 * Unmatched requests fail loudly with status 599.
 */
export function mockFetch(routes) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const href = String(url)
    calls.push({ url: href, init, body: typeof init.body === 'string' ? init.body : init.body?.toString?.() })
    for (const route of routes) {
      if (route.match(href, init)) return route.respond(href, init)
    }
    return new Response(`unmocked ${href}`, { status: 599 })
  }
  fetchImpl.calls = calls
  return fetchImpl
}

/**
 * Replace globalThis.fetch for code paths that use the default fetch (apply() wiring).
 * Unmocked requests fail with status 599, so no test can reach the real network.
 * @returns restore function.
 */
export function installGlobalFetch(fetchImpl = mockFetch([])) {
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl
  return () => {
    globalThis.fetch = original
  }
}

export const isTokenEndpoint = (url) => url === 'https://auth.openai.com/oauth/token'
export const isResponsesEndpoint = (url) => url.startsWith('https://chatgpt.com/backend-api/codex/responses')
export const isModelsEndpoint = (url) => url.startsWith('https://chatgpt.com/backend-api/codex/models')
export const isUsageEndpoint = (url) => url.startsWith('https://chatgpt.com/backend-api/wham/usage')

export function tokenResponse({ accountId = 'acct-test-1', plan = 'plus', email = 'jane.doe@example.com', refreshToken = 'rt-rotated', expiresIn = 3600, includeRefresh = true, includeId = true } = {}) {
  return new Response(JSON.stringify({
    access_token: accessTokenFor({ accountId, plan, expiresInSeconds: expiresIn }),
    ...(includeRefresh ? { refresh_token: refreshToken } : {}),
    ...(includeId ? { id_token: idTokenFor({ email, accountId, plan }) } : {}),
    expires_in: expiresIn,
    token_type: 'Bearer',
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

export function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })
}

/** SSE response from event objects (or raw strings for malformed-input tests). */
export function sseResponse(events, { status = 200, headers = {}, chunkSize } = {}) {
  const encoder = new TextEncoder()
  const text = events.map((e) => (typeof e === 'string' ? e : `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)).join('')
  const bytes = encoder.encode(text)
  const body = new ReadableStream({
    start(controller) {
      const size = chunkSize ?? bytes.length
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size))
      controller.close()
    },
  })
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream', ...headers } })
}

/** A typical successful turn: reasoning summary, text, one tool call, usage. */
export function sampleTurnEvents({ model = 'gpt-5.5' } = {}) {
  return [
    { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } },
    { type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0 },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'Plan: ' },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'read the file.' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Plan: read the file.' }], encrypted_content: 'gAAAA-encrypted' } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'Reading ' },
    { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'it now.' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Reading it now.' }] } },
    { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '"notes.txt"}' },
    { type: 'response.function_call_arguments.done', output_index: 2, arguments: '{"path":"notes.txt"}' },
    { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"notes.txt"}' } },
    { type: 'response.completed', response: { id: 'resp_1', status: 'completed', model, usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 400 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 20 }, total_tokens: 1050 } } },
  ]
}

export async function collect(iterable) {
  const items = []
  for await (const item of iterable) items.push(item)
  return items
}

/** Default-model service double (ctx.get('agentDefaultModel')). */
export function defaultModelService(initial = { provider: 'deepseek-official', model: 'deepseek-flash' }) {
  const service = {
    selection: { ...initial },
    saved: [],
    currentSelection() {
      return { ...service.selection }
    },
    async saveSelection(next) {
      service.saved.push({ ...next })
      service.selection = { ...next }
    },
  }
  return service
}

/**
 * Cordis-like context double. Records effects in registration order and disposes them in
 * reverse order on unload(), like a fiber does. `llm.registerAdapter` applies the same
 * registration-time checks as dsh-llm's LlmRuntime.
 */
export function mockContext({ credentials = new FakeCredentials(), web = true, agentDefaultModel = defaultModelService(), authorized = true } = {}) {
  const effects = []
  const listeners = new Map()
  const registrations = []
  const routes = []

  function effect(execute, label) {
    const result = execute()
    const disposers = typeof result === 'function' ? [result] : result && typeof result[Symbol.iterator] === 'function' ? [...result] : null
    if (!disposers || disposers.some((d) => typeof d !== 'function')) throw new TypeError(`effect ${label} returned an invalid shape`)
    const entry = { label, disposers, active: true }
    effects.push(entry)
    return () => {
      if (!entry.active) return
      entry.active = false
      for (const dispose of [...disposers].reverse()) dispose()
    }
  }

  const ctx = {
    credentials,
    llm: {
      registerAdapter(providers, adapter) {
        if (providers.length === 0) throw new Error('INVALID_ADAPTER: no providers')
        for (const provider of providers) {
          const info = adapter.providerInfo(provider)
          if (info.id !== provider || typeof info.name !== 'string' || info.name.length === 0) throw new Error('INVALID_ADAPTER: bad providerInfo')
          adapter.providerRetryPolicy(provider)
        }
        const registration = { providers: [...providers], adapter, disposed: false, replaced: 0 }
        registrations.push(registration)
        const handle = () => {
          registration.disposed = true
        }
        handle.replace = (next) => {
          if (registration.disposed) throw new Error('REGISTRATION_DISPOSED')
          registration.providers = [...next]
          registration.replaced += 1
        }
        return handle
      },
    },
    effect,
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(listener)
      return effect(() => () => listeners.get(name).delete(listener), `ctx.on(${name})`)
    },
    inject(deps, callback) {
      if (!web || !deps.every((d) => d === 'webServer' || d === 'connection')) return
      const child = {
        effect,
        webServer: {
          register(route) {
            const entry = { ...route, disposed: false }
            routes.push(entry)
            return () => {
              entry.disposed = true
            }
          },
        },
        connection: {
          requestRejection: (req) => (authorized && req.headers?.cookie === 'dsh-session=ok' ? undefined : 401),
        },
      }
      callback(child)
    },
    get(name) {
      return name === 'agentDefaultModel' ? agentDefaultModel : undefined
    },
  }

  return {
    ctx,
    effects,
    listeners,
    registrations,
    routes,
    agentDefaultModel,
    emit(name, ...args) {
      for (const listener of listeners.get(name) ?? []) listener(...args)
    },
    async unload() {
      for (const entry of [...effects].reverse()) {
        if (!entry.active) continue
        entry.active = false
        for (const dispose of [...entry.disposers].reverse()) await dispose()
      }
    },
  }
}

/** Wait until `predicate()` is truthy (polling), or fail after `timeoutMs`. */
export async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 10, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`timed out waiting for ${message}`)
}

/** Serve one registered web route (from mockContext().routes) on a real local HTTP server. */
export async function serveRoute(route) {
  const server = createServer((req, res) => {
    route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    request(path, { method = 'GET', body, cookie = 'dsh-session=ok', headers = {} } = {}) {
      const hasBody = body !== undefined
      return realFetch(`${base}${route.path}${path}`, {
        method,
        headers: { ...(cookie ? { cookie } : {}), ...(hasBody ? { 'content-type': 'application/json' } : {}), ...headers },
        body: hasBody ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      })
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
