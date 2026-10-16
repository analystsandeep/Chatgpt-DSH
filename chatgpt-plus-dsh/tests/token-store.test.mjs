// Token storage in DSH's credential store, refresh, deletion, and the non-secret data files.
import { CREDENTIAL_KEY, FakeCredentials, accessTokenFor, grantPayload, isTokenEndpoint, mockFetch, tempDir, tokenResponse } from './helpers.mjs'

const tokenCalls = (fetchImpl) => fetchImpl.calls.filter((c) => isTokenEndpoint(c.url))
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ChatGptPlusController } from '../lib/controller.js'
import { buildGrantPayload, isGrantPayload } from '../lib/oauth.js'
import { DataStore, TokenStore, normalizePreferences } from '../lib/store.js'
import { decodeJwtPayload, maskEmail, resolveDshHome, restrictToCurrentUser } from '../lib/util.js'

function controllerWith({ credentials = new FakeCredentials(), fetchImpl, config = {}, dir } = {}) {
  const data = tempDir()
  const controller = new ChatGptPlusController({ credentials, fetchImpl, dataDir: dir ?? data.dir, config: { callbackPort: 0, ...config } })
  return { controller, credentials, cleanup: () => { controller.dispose(); data.cleanup() } }
}

test('round trip: write, read, refresh, delete through the credential store', async () => {
  const fetchImpl = mockFetch([{ match: isTokenEndpoint, respond: () => tokenResponse({ refreshToken: 'rt-second', expiresIn: 7200 }) }])
  const { controller, credentials, cleanup } = controllerWith({ fetchImpl })
  try {
    controller.start()
    await controller.ready()
    assert.equal(controller.status, 'signed-out')

    // write
    const store = new TokenStore(credentials)
    const initial = grantPayload({ refresh_token: 'rt-first', expires_at: Date.now() + 30_000 })
    await store.write(initial)
    const raw = credentials.records.get(CREDENTIAL_KEY)
    assert.equal(raw.kind, 'grant')
    assert.equal(raw.payload.refresh_token, 'rt-first')

    // read
    await controller.reloadRecord()
    assert.equal(controller.status, 'connected')
    assert.deepEqual((await store.read()).payload, initial)

    // refresh (the token is inside the request margin, so the next call refreshes first)
    const auth = await controller.getAccessToken()
    assert.equal(tokenCalls(fetchImpl).length, 1)
    const form = new URLSearchParams(tokenCalls(fetchImpl)[0].body)
    assert.equal(form.get('grant_type'), 'refresh_token')
    assert.equal(form.get('refresh_token'), 'rt-first')
    assert.equal(form.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann')
    assert.equal(tokenCalls(fetchImpl)[0].init.headers['content-type'], 'application/x-www-form-urlencoded')
    const stored = credentials.records.get(CREDENTIAL_KEY).payload
    assert.equal(stored.refresh_token, 'rt-second')
    assert.equal(stored.access_token, auth.accessToken)
    assert.equal(auth.accountId, 'acct-test-1')
    assert.ok(stored.expires_at > Date.now() + 7000_000)
    assert.equal(stored.obtained_at, initial.obtained_at)

    // delete
    await controller.signOut()
    assert.equal(credentials.records.has(CREDENTIAL_KEY), false)
    assert.deepEqual(await store.read(), {})
    assert.equal(controller.status, 'signed-out')
    await assert.rejects(controller.getAccessToken(), (e) => e.code === 'MISSING_CREDENTIAL')
  } finally {
    cleanup()
  }
})

test('a fresh token is used as-is without contacting the token endpoint', async () => {
  const fetchImpl = mockFetch([])
  const credentials = new FakeCredentials()
  await new TokenStore(credentials).write(grantPayload({ expires_at: Date.now() + 3600_000 }))
  const { controller, cleanup } = controllerWith({ credentials, fetchImpl })
  try {
    controller.start()
    const auth = await controller.getAccessToken()
    assert.ok(auth.accessToken)
    assert.equal(tokenCalls(fetchImpl).length, 0)
  } finally {
    cleanup()
  }
})

test('concurrent refreshes share one token request (single flight)', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const fetchImpl = mockFetch([{ match: isTokenEndpoint, respond: async () => { await gate; return tokenResponse({ refreshToken: 'rt-once' }) } }])
  const credentials = new FakeCredentials()
  await new TokenStore(credentials).write(grantPayload({ expires_at: Date.now() - 1000 }))
  const { controller, cleanup } = controllerWith({ credentials, fetchImpl })
  try {
    controller.start()
    await controller.ready()
    const pending = [controller.getAccessToken(), controller.getAccessToken(), controller.getAccessToken({ forceRefresh: true })]
    await new Promise((r) => setTimeout(r, 20))
    release()
    const results = await Promise.all(pending)
    assert.equal(tokenCalls(fetchImpl).length, 1)
    assert.equal(new Set(results.map((r) => r.accessToken)).size, 1)
    assert.equal(credentials.records.get(CREDENTIAL_KEY).payload.refresh_token, 'rt-once')
  } finally {
    cleanup()
  }
})

test('a token rotated by another DSH process is adopted instead of refreshed again', async () => {
  const fetchImpl = mockFetch([{ match: isTokenEndpoint, respond: () => tokenResponse() }])
  const credentials = new FakeCredentials()
  await new TokenStore(credentials).write(grantPayload({ access_token: accessTokenFor({ expiresInSeconds: 10 }), expires_at: Date.now() + 10_000 }))
  const { controller, cleanup } = controllerWith({ credentials, fetchImpl })
  try {
    controller.start()
    await controller.ready()
    // Another process rotates the grant while this one still holds the old token.
    const rotated = grantPayload({ access_token: accessTokenFor({ expiresInSeconds: 7200 }), refresh_token: 'rt-other-process', expires_at: Date.now() + 7200_000 })
    credentials.records.set(CREDENTIAL_KEY, { kind: 'grant', payload: rotated })
    const auth = await controller.getAccessToken()
    assert.equal(tokenCalls(fetchImpl).length, 0, 'must not spend the refresh token twice')
    assert.equal(auth.accessToken, rotated.access_token)
    assert.equal(controller.record.refresh_token, 'rt-other-process')
  } finally {
    cleanup()
  }
})

test('refresh keeps the previous refresh/id token when the response omits them', () => {
  const previous = grantPayload({ refresh_token: 'rt-keep' })
  const json = JSON.parse(JSON.stringify({ access_token: accessTokenFor({ accountId: 'acct-test-1' }), expires_in: 600 }))
  const next = buildGrantPayload(json, previous, 1_000_000)
  assert.equal(next.refresh_token, 'rt-keep')
  assert.equal(next.id_token, previous.id_token)
  assert.equal(next.expires_at, 1_000_000 + 600_000)
  assert.equal(next.email, 'jane.doe@example.com')
  assert.equal(next.plan_type, 'plus')
  assert.ok(isGrantPayload(next))
})

test('expiry falls back to the JWT exp claim when expires_in is absent', () => {
  const token = accessTokenFor({ expiresInSeconds: 1234, now: 1_700_000_000_000 })
  const next = buildGrantPayload({ access_token: token, refresh_token: 'r' }, undefined, 1_700_000_000_000)
  assert.equal(next.expires_at, (Math.floor(1_700_000_000_000 / 1000) + 1234) * 1000)
  assert.equal(decodeJwtPayload(token)['https://api.openai.com/auth'].chatgpt_account_id, 'acct-test-1')
})

test('an unusable record (wrong shape) is reported, never used', async () => {
  const credentials = new FakeCredentials()
  credentials.records.set(CREDENTIAL_KEY, { kind: 'api-key', key: 'sk-not-ours' })
  const { controller, cleanup } = controllerWith({ credentials })
  try {
    controller.start()
    await controller.ready()
    assert.equal(controller.status, 'error')
    await assert.rejects(controller.getAccessToken(), (e) => e.code === 'MISSING_CREDENTIAL')
  } finally {
    cleanup()
  }
})

test('status snapshot masks the email and never contains token material', async () => {
  const credentials = new FakeCredentials()
  const payload = grantPayload()
  await new TokenStore(credentials).write(payload)
  const { controller, cleanup } = controllerWith({ credentials })
  try {
    controller.start()
    const status = await controller.getStatus()
    const text = JSON.stringify(status)
    assert.equal(status.account.email, 'ja•••@example.com')
    assert.equal(status.account.plan, 'Plus')
    for (const secret of [payload.access_token, payload.refresh_token, payload.id_token, 'jane.doe']) {
      assert.ok(!text.includes(secret), 'status must not leak token material or the full email')
    }
    assert.equal(maskEmail('ab@x.io'), 'a•••@x.io')
  } finally {
    cleanup()
  }
})

test('preferences persist under $DSH_HOME/chatgpt-plus-dsh with owner-only mode', async () => {
  const home = tempDir()
  try {
    const dir = join(home.dir, 'chatgpt-plus-dsh')
    const store = new DataStore(dir)
    await store.savePreferences({ autoRefresh: false, modelVisibility: { 'gpt-5.5': false, bad: 'x' }, defaultEffort: 'high' })
    const loaded = await store.loadPreferences()
    assert.deepEqual(loaded, { autoRefresh: false, modelVisibility: { 'gpt-5.5': false }, defaultEffort: 'high', previousDefault: null })
    const text = readFileSync(join(dir, 'preferences.json'), 'utf8')
    assert.ok(!/token/i.test(text))
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(dir, 'preferences.json')).mode & 0o777, 0o600)
      assert.equal(statSync(dir).mode & 0o777, 0o700)
    }
    assert.deepEqual(normalizePreferences(null), { autoRefresh: true, modelVisibility: {}, defaultEffort: null, previousDefault: null })
  } finally {
    home.cleanup()
  }
})

test('$DSH_HOME resolution matches dsh-home-paths (blank → ~/.dsh, ~ expansion)', () => {
  const home = resolveDshHome({ DSH_HOME: '   ' })
  assert.ok(home.endsWith('.dsh'))
  assert.equal(resolveDshHome({ DSH_HOME: join('/', 'custom', 'home') }), resolve(join('/', 'custom', 'home')))
  assert.ok(!resolveDshHome({ DSH_HOME: '~/x' }).includes('~'))
})

test('Windows owner-only ACL: icacls is run without a shell, removing inheritance', async () => {
  const calls = []
  const execFileImpl = (command, args, options, callback) => {
    calls.push({ command, args, options })
    if (command === 'whoami') callback(null, '"desktop\\nestech--","S-1-5-21-1111-2222-3333-1001"\r\n')
    else callback(null, '')
  }
  const result = await restrictToCurrentUser('C:\\Users\\NESTECH--\\.dsh\\chatgpt-plus-dsh', { platform: 'win32', execFileImpl })
  assert.deepEqual(result, { applied: true, sid: 'S-1-5-21-1111-2222-3333-1001' })
  const icacls = calls.find((c) => c.command === 'icacls')
  assert.deepEqual(icacls.args.slice(0, 2), ['C:\\Users\\NESTECH--\\.dsh\\chatgpt-plus-dsh', '/inheritance:r'])
  assert.ok(icacls.args.includes('*S-1-5-21-1111-2222-3333-1001:(OI)(CI)F'))
  assert.ok(calls.every((c) => c.options.windowsHide === true && c.options.shell === undefined))
  // Elsewhere it is a no-op.
  assert.deepEqual(await restrictToCurrentUser('/tmp/x', { platform: 'linux', execFileImpl }), { applied: false, reason: 'not-windows' })
  // A failure is reported, never thrown.
  const failing = (command, args, options, callback) => callback(new Error('icacls missing'))
  const failed = await restrictToCurrentUser('C:\\x', { platform: 'win32', execFileImpl: failing })
  assert.equal(failed.applied, false)
})

test('on Windows the real ACL helper succeeds on a temp directory', { skip: process.platform !== 'win32' }, async () => {
  const dir = tempDir()
  try {
    const result = await restrictToCurrentUser(dir.dir)
    assert.equal(result.applied, true, result.reason)
  } finally {
    dir.cleanup()
  }
})
