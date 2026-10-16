// Settings endpoints: authentication fence, method/content-type rules, size limits, no secrets.
import { CREDENTIAL_KEY, FakeCredentials, grantPayload, installGlobalFetch, mockContext, serveRoute } from './helpers.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'
import { TokenStore } from '../lib/store.js'

async function withPlugin(run, { grant } = {}) {
  const restore = installGlobalFetch()
  const credentials = new FakeCredentials()
  if (grant) await new TokenStore(credentials).write(grant)
  const harness = mockContext({ credentials })
  apply(harness.ctx, { callbackPort: 0 })
  const http = await serveRoute(harness.routes[0])
  try {
    await run(http, harness)
  } finally {
    await http.close()
    await harness.unload()
    restore()
  }
}

test('requests without the DSH browser session are refused', async () => {
  await withPlugin(async (http) => {
    for (const [path, method] of [['/status', 'GET'], ['/signin', 'POST'], ['/signout', 'POST'], ['/usage', 'GET']]) {
      const res = await http.request(path, { method, cookie: null, body: method === 'POST' ? {} : undefined })
      assert.equal(res.status, 401, `${method} ${path}`)
      assert.equal((await res.json()).error.code, 'UNAUTHORIZED')
    }
  })
})

test('mutations require POST with application/json', async () => {
  await withPlugin(async (http) => {
    assert.equal((await http.request('/signout')).status, 405)
    const form = await http.request('/signout', { method: 'POST', body: 'a=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    assert.equal(form.status, 415)
    const text = await http.request('/preferences', { method: 'POST', body: '{"autoRefresh":false}', headers: { 'content-type': 'text/plain' } })
    assert.equal(text.status, 415)
    assert.equal((await http.request('/status', { method: 'POST', body: {} })).status, 405)
    assert.equal((await http.request('/nope')).status, 404)
  })
})

test('malformed and oversized bodies are rejected', async () => {
  await withPlugin(async (http) => {
    const bad = await http.request('/preferences', { method: 'POST', body: '{not json' })
    assert.equal(bad.status, 400)
    assert.equal((await bad.json()).error.code, 'BAD_JSON')
    const huge = await http.request('/signin/complete', { method: 'POST', body: JSON.stringify({ input: 'x'.repeat(70 * 1024) }) })
    assert.equal(huge.status, 413)
    const empty = await http.request('/signin/complete', { method: 'POST', body: { input: '   ' } })
    assert.equal(empty.status, 400)
  })
})

test('status responses are uncacheable JSON without token material', async () => {
  const grant = grantPayload()
  await withPlugin(async (http) => {
    const res = await http.request('/status')
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /^application\/json/)
    assert.match(res.headers.get('cache-control'), /no-store/)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    const text = await res.text()
    for (const secret of [grant.access_token, grant.refresh_token, grant.id_token, grant.account_id, grant.email]) {
      assert.ok(!text.includes(secret))
    }
    const body = JSON.parse(text)
    assert.equal(body.data.status, 'connected')
    assert.equal(body.data.storage.credentialKey, CREDENTIAL_KEY)
  }, { grant })
})

test('preferences endpoint accepts only user-editable keys', async () => {
  await withPlugin(async (http) => {
    const res = await http.request('/preferences', { method: 'POST', body: { autoRefresh: false, previousDefault: { provider: 'x', model: 'y' }, modelVisibility: { 'gpt-5.5': false } } })
    const data = (await res.json()).data
    assert.equal(data.preferences.autoRefresh, false)
    assert.deepEqual(data.preferences.modelVisibility, { 'gpt-5.5': false })
    assert.ok(!('previousDefault' in data.preferences))
  }, { grant: grantPayload() })
})

test('sign-in can be cancelled and restarted; completing without an attempt is a clear error', async () => {
  await withPlugin(async (http) => {
    const none = await http.request('/signin/complete', { method: 'POST', body: { input: 'abc' } })
    assert.equal(none.status, 409)
    assert.equal((await none.json()).error.code, 'NO_SIGN_IN')
    const first = (await (await http.request('/signin', { method: 'POST', body: { openBrowser: false } })).json()).data
    const again = (await (await http.request('/signin', { method: 'POST', body: { openBrowser: false } })).json()).data
    assert.equal(again.signIn.authUrl, first.signIn.authUrl, 'a pending attempt is reused')
    const restarted = (await (await http.request('/signin', { method: 'POST', body: { openBrowser: false, restart: true } })).json()).data
    assert.notEqual(restarted.signIn.authUrl, first.signIn.authUrl)
    const cancelled = (await (await http.request('/signin/cancel', { method: 'POST', body: {} })).json()).data
    assert.equal(cancelled.status, 'signed-out')
    assert.equal(cancelled.signIn, null)
  })
})
