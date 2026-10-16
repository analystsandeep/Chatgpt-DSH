// Plugin lifecycle through apply(): ctx.effect disposers on unload, sign-in end to end,
// and reuse of the stored credential after a restart.
import {
  CREDENTIAL_KEY, FakeCredentials, grantPayload, installGlobalFetch, isModelsEndpoint, isTokenEndpoint, jsonResponse, mockContext,
  mockFetch, realFetch, serveRoute as serve, tokenResponse, waitFor,
} from './helpers.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { apply } from '../lib/index.js'
import { TokenStore } from '../lib/store.js'

async function json(response) {
  const body = await response.json()
  assert.equal(body.ok, true, JSON.stringify(body.error))
  return body.data
}

function backend() {
  return mockFetch([
    { match: isTokenEndpoint, respond: () => tokenResponse({ refreshToken: 'rt-from-signin' }) },
    { match: isModelsEndpoint, respond: () => jsonResponse({ models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }], default_reasoning_level: 'medium', visibility: 'list', priority: 1 }] }) },
  ])
}

test('unloading the plugin runs every ctx.effect disposer', async () => {
  const restore = installGlobalFetch(backend())
  const harness = mockContext()
  try {
    apply(harness.ctx, { callbackPort: 0 })
    const labels = harness.effects.map((e) => e.label)
    assert.ok(labels.some((l) => /token lifecycle/.test(l)))
    assert.ok(labels.some((l) => /llm route/.test(l)))
    assert.ok(labels.some((l) => /settings endpoints/.test(l)))
    assert.ok(labels.some((l) => /credentials\/record-updated/.test(l)))

    // Open a sign-in so a redirect listener and its timeout timer exist.
    const http = await serve(harness.routes[0])
    const started = await json(await http.request('/signin', { method: 'POST', body: { openBrowser: false } }))
    const redirect = started.signIn.redirectUri
    assert.match(redirect, /^http:\/\/localhost:\d+\/auth\/callback$/)
    const port = Number(new URL(redirect).port)
    assert.equal((await realFetch(`http://127.0.0.1:${port}/auth/callback?state=nope`)).status, 400)
    await http.close()

    await harness.unload()
    assert.ok(harness.effects.every((e) => !e.active))
    assert.equal(harness.registrations[0].disposed, true, 'llm route unregistered')
    assert.equal(harness.routes[0].disposed, true, 'web route removed')
    assert.equal(harness.listeners.get('credentials/record-updated').size, 0, 'event listener removed')
    // Windows retries a refused loopback connection for ~2s before failing, hence the budget.
    await waitFor(async () => {
      try {
        await realFetch(`http://127.0.0.1:${port}/auth/callback`)
        return false
      } catch {
        return true
      }
    }, { timeoutMs: 15_000, message: 'redirect listener closed' })
  } finally {
    await harness.unload()
    restore()
  }
})

test('the background refresh timer dies with the plugin', async () => {
  const fetchImpl = backend()
  const restore = installGlobalFetch(fetchImpl)
  const credentials = new FakeCredentials()
  await new TokenStore(credentials).write(grantPayload({ expires_at: Date.now() + 1500 }))
  const live = mockContext({ credentials })
  const unloaded = mockContext({ credentials: Object.assign(new FakeCredentials(), {}) })
  await new TokenStore(unloaded.ctx.credentials).write(grantPayload({ expires_at: Date.now() + 1500 }))
  try {
    // The background margin (1s) is larger than the per-request margin (0.1s), so only the
    // timer can trigger this refresh, not the model-list request made at startup.
    const config = { callbackPort: 0, backgroundRefreshMarginMs: 1000, requestRefreshMarginMs: 100 }
    apply(live.ctx, config)
    apply(unloaded.ctx, config)
    await new Promise((r) => setTimeout(r, 50))
    await unloaded.unload()
    await waitFor(() => credentials.records.get(CREDENTIAL_KEY).payload.refresh_token === 'rt-from-signin', { timeoutMs: 4000, message: 'background refresh while loaded' })
    assert.equal(unloaded.ctx.credentials.records.get(CREDENTIAL_KEY).payload.refresh_token, 'rt-initial', 'no refresh after unload')
    assert.equal(fetchImpl.calls.filter((c) => isTokenEndpoint(c.url)).length, 1)
  } finally {
    await live.unload()
    await unloaded.unload()
    restore()
  }
})

test('sign-in end to end: endpoints → browser redirect → tokens stored → models offered', async () => {
  const fetchImpl = backend()
  const restore = installGlobalFetch(fetchImpl)
  const harness = mockContext()
  try {
    apply(harness.ctx, { callbackPort: 0 })
    const http = await serve(harness.routes[0])
    assert.equal((await json(await http.request('/status'))).status, 'signed-out')

    const started = await json(await http.request('/signin', { method: 'POST', body: { openBrowser: false } }))
    assert.equal(started.status, 'signing-in')
    assert.equal(started.signIn.callbackListening, true)
    const authUrl = new URL(started.signIn.authUrl)
    const state = authUrl.searchParams.get('state')
    const challenge = authUrl.searchParams.get('code_challenge')
    assert.equal(authUrl.searchParams.get('redirect_uri'), started.signIn.redirectUri)

    // The browser comes back to the redirect listener.
    const page = await realFetch(`${started.signIn.redirectUri.replace('localhost', '127.0.0.1')}?code=auth-code-1&state=${encodeURIComponent(state)}`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /Signed in to ChatGPT/)

    const status = await json(await http.request('/status'))
    assert.equal(status.status, 'connected')
    assert.equal(status.account.email, 'ja•••@example.com')
    assert.equal(status.account.plan, 'Plus')
    assert.equal(status.signIn, null)

    // PKCE binding: the verifier sent with the code hashes to the challenge in the URL.
    const exchange = fetchImpl.calls.find((c) => isTokenEndpoint(c.url))
    const form = new URLSearchParams(exchange.body)
    assert.equal(form.get('grant_type'), 'authorization_code')
    assert.equal(form.get('code'), 'auth-code-1')
    assert.equal(form.get('redirect_uri'), started.signIn.redirectUri)
    assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), challenge)

    const record = harness.ctx.credentials.records.get(CREDENTIAL_KEY)
    assert.equal(record.kind, 'grant')
    assert.equal(record.payload.refresh_token, 'rt-from-signin')
    await waitFor(async () => (await harness.registrations[0].adapter.listModels('chatgpt-plus')).length > 0, { message: 'models after sign-in' })
    assert.ok(harness.registrations[0].replaced >= 1)
    await http.close()
  } finally {
    await harness.unload()
    restore()
  }
})

test('busy redirect port: the pasted redirect address completes the sign-in', async () => {
  const blocker = createServer(() => {})
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const busyPort = blocker.address().port
  const restore = installGlobalFetch(backend())
  const harness = mockContext()
  try {
    apply(harness.ctx, { callbackPort: busyPort })
    const http = await serve(harness.routes[0])
    const started = await json(await http.request('/signin', { method: 'POST', body: { openBrowser: false } }))
    assert.equal(started.signIn.portBusy, true)
    assert.equal(started.signIn.callbackListening, false)
    assert.match(started.signIn.callbackError, /already in use/)
    const state = new URL(started.signIn.authUrl).searchParams.get('state')

    const mismatch = await http.request('/signin/complete', { method: 'POST', body: { input: `http://localhost:${busyPort}/auth/callback?code=x&state=other` } })
    assert.equal(mismatch.status, 400)
    assert.equal((await mismatch.json()).error.code, 'STATE_MISMATCH')

    const done = await json(await http.request('/signin/complete', { method: 'POST', body: { input: `http://localhost:${busyPort}/auth/callback?code=pasted-code&state=${state}` } }))
    assert.equal(done.status, 'connected')
    await http.close()
  } finally {
    await harness.unload()
    restore()
    await new Promise((resolve) => blocker.close(resolve))
  }
})

test('survives a restart: a new plugin instance reuses the stored credential', async () => {
  const restore = installGlobalFetch(backend())
  const credentials = new FakeCredentials()
  const first = mockContext({ credentials })
  const second = mockContext({ credentials })
  try {
    apply(first.ctx, { callbackPort: 0 })
    const http = await serve(first.routes[0])
    const started = await json(await http.request('/signin', { method: 'POST', body: { openBrowser: false } }))
    const state = new URL(started.signIn.authUrl).searchParams.get('state')
    await json(await http.request('/signin/complete', { method: 'POST', body: { input: `code-1#${state}` } }))
    await http.close()
    await first.unload()

    // "Restart": a fresh instance over the same credential store, no new sign-in.
    apply(second.ctx, { callbackPort: 0 })
    const http2 = await serve(second.routes[0])
    const status = await json(await http2.request('/status'))
    assert.equal(status.status, 'connected')
    assert.equal(status.account.email, 'ja•••@example.com')
    const adapter = second.registrations[0].adapter
    await waitFor(async () => (await adapter.listModels('chatgpt-plus')).length > 0, { message: 'models after restart' })
    await http2.close()
  } finally {
    await first.unload()
    await second.unload()
    restore()
  }
})

test('default model: set through the plugin, restored on sign-out', async () => {
  const restore = installGlobalFetch(backend())
  const credentials = new FakeCredentials()
  await new TokenStore(credentials).write(grantPayload())
  const harness = mockContext({ credentials })
  try {
    apply(harness.ctx, { callbackPort: 0 })
    const http = await serve(harness.routes[0])
    const bad = await http.request('/default-model', { method: 'POST', body: { model: 'gpt-5.5', reasoningEffort: 'ultra-mega' } })
    assert.equal(bad.status, 400)
    const set = await json(await http.request('/default-model', { method: 'POST', body: { model: 'gpt-5.5', reasoningEffort: 'high' } }))
    assert.deepEqual(set.defaultModel, { provider: 'chatgpt-plus', model: 'gpt-5.5', reasoningEffort: 'high' })
    const out = await json(await http.request('/signout', { method: 'POST', body: {} }))
    assert.equal(out.status, 'signed-out')
    assert.deepEqual(out.restoredDefault, { provider: 'deepseek-official', model: 'deepseek-flash' })
    assert.deepEqual(harness.agentDefaultModel.selection, { provider: 'deepseek-official', model: 'deepseek-flash' })
    assert.equal(credentials.records.has(CREDENTIAL_KEY), false)
    await http.close()
  } finally {
    await harness.unload()
    restore()
  }
})
