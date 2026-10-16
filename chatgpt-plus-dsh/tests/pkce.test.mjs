// PKCE (RFC 7636) and OAuth primitives.
import './helpers.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  buildAuthorizeUrl, createOAuthState, createPkcePair, openBrowser, parseCallbackInput, pkceChallenge, startCallbackServer,
} from '../lib/oauth.js'

const UNRESERVED = /^[A-Za-z0-9\-._~]+$/

test('PKCE verifier is 43 characters from the RFC 7636 unreserved set', () => {
  for (let i = 0; i < 50; i++) {
    const { verifier } = createPkcePair()
    assert.equal(verifier.length, 43)
    assert.ok(verifier.length >= 43 && verifier.length <= 128)
    assert.match(verifier, UNRESERVED)
  }
})

test('PKCE challenge is base64url(SHA-256(verifier)) with method S256', () => {
  const pair = createPkcePair()
  const expected = createHash('sha256').update(pair.verifier).digest('base64url')
  assert.equal(pair.method, 'S256')
  assert.equal(pair.challenge, expected)
  assert.equal(pair.challenge.length, 43)
  assert.doesNotMatch(pair.challenge, /[+/=]/)
})

test('S256 transform matches the RFC 7636 Appendix B test vector', () => {
  assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
})

test('verifiers and states are unique per attempt', () => {
  const verifiers = new Set()
  const states = new Set()
  for (let i = 0; i < 200; i++) {
    verifiers.add(createPkcePair().verifier)
    states.add(createOAuthState())
  }
  assert.equal(verifiers.size, 200)
  assert.equal(states.size, 200)
  assert.ok([...states].every((s) => s.length >= 32 && UNRESERVED.test(s)))
})

test('authorize URL carries the Codex client id, scopes, S256 challenge and state', () => {
  const { challenge } = createPkcePair()
  const url = new URL(buildAuthorizeUrl({ challenge, state: 'state-123' }))
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/oauth/authorize')
  const p = url.searchParams
  assert.equal(p.get('response_type'), 'code')
  assert.equal(p.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann')
  assert.equal(p.get('redirect_uri'), 'http://localhost:1455/auth/callback')
  assert.equal(p.get('scope'), 'openid profile email offline_access')
  assert.equal(p.get('code_challenge'), challenge)
  assert.equal(p.get('code_challenge_method'), 'S256')
  assert.equal(p.get('state'), 'state-123')
  assert.equal(p.get('codex_cli_simplified_flow'), 'true')
  assert.equal(p.get('id_token_add_organizations'), 'true')
  assert.ok(p.get('originator'))
})

test('pasted redirect input: full URL, query string, code#state and bare code', () => {
  assert.deepEqual(parseCallbackInput('http://localhost:1455/auth/callback?code=abc&state=xyz'), { code: 'abc', state: 'xyz' })
  assert.deepEqual(parseCallbackInput('  ?code=abc&state=xyz  '), { code: 'abc', state: 'xyz' })
  assert.deepEqual(parseCallbackInput('code=abc&state=xyz'), { code: 'abc', state: 'xyz' })
  assert.deepEqual(parseCallbackInput('abc#xyz'), { code: 'abc', state: 'xyz' })
  assert.deepEqual(parseCallbackInput('ac_1234567890'), { code: 'ac_1234567890' })
  assert.deepEqual(parseCallbackInput('http://localhost:1455/auth/callback?error=access_denied&error_description=User%20cancelled'), { error: 'access_denied', errorDescription: 'User cancelled' })
  assert.deepEqual(parseCallbackInput(''), {})
  assert.deepEqual(parseCallbackInput('not a code with spaces'), {})
})

test('callback listener accepts only the matching state and reports the code', async () => {
  const results = []
  const server = await startCallbackServer({
    port: 0,
    expectedState: 'good-state',
    onResult: async (params) => {
      results.push(params)
      return { ok: true }
    },
  })
  try {
    const base = `http://127.0.0.1:${server.port}`
    const wrong = await fetch(`${base}/auth/callback?code=abc&state=bad-state`)
    assert.equal(wrong.status, 400)
    assert.match(wrong.headers.get('cache-control'), /no-store/)
    assert.equal(results.length, 0)

    const other = await fetch(`${base}/somewhere-else`)
    assert.equal(other.status, 404)

    const ok = await fetch(`${base}/auth/callback?code=the-code&state=good-state`)
    assert.equal(ok.status, 200)
    assert.match(await ok.text(), /Signed in to ChatGPT/)
    assert.deepEqual(results, [{ code: 'the-code', state: 'good-state' }])
  } finally {
    await server.close()
  }
})

test('callback page escapes provider-supplied text', async () => {
  const server = await startCallbackServer({
    port: 0,
    expectedState: 's',
    onResult: async () => ({ ok: false, message: '<script>alert(1)</script>' }),
  })
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/auth/callback?code=x&state=s`)
    const html = await res.text()
    assert.equal(res.status, 400)
    assert.ok(!html.includes('<script>alert(1)</script>'))
    assert.ok(html.includes('&lt;script&gt;'))
  } finally {
    await server.close()
  }
})

test('a busy port fails with PORT_BUSY so the paste fallback can take over', async () => {
  const first = await startCallbackServer({ port: 0, expectedState: 'a', onResult: async () => ({ ok: true }) })
  try {
    await assert.rejects(
      startCallbackServer({ port: first.port, expectedState: 'b', onResult: async () => ({ ok: true }) }),
      (error) => error.code === 'PORT_BUSY' && /already in use/.test(error.message),
    )
  } finally {
    await first.close()
  }
  // The port is released after close().
  const again = await startCallbackServer({ port: first.port, expectedState: 'c', onResult: async () => ({ ok: true }) })
  await again.close()
})

function fakeSpawn(behaviour) {
  const calls = []
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.unref = () => {}
    queueMicrotask(() => child.emit(behaviour(command) ? 'spawn' : 'error', new Error('ENOENT')))
    return child
  }
  return { spawnImpl, calls }
}

test('browser launch on Windows uses rundll32 directly, without a shell', async () => {
  const { spawnImpl, calls } = fakeSpawn(() => true)
  const url = 'https://auth.openai.com/oauth/authorize?a=1&b=2&c=3'
  assert.equal(await openBrowser(url, { platform: 'win32', spawnImpl }), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'rundll32.exe')
  assert.deepEqual(calls[0].args, ['url.dll,FileProtocolHandler', url])
  assert.equal(calls[0].options.shell, false)
  assert.equal(calls[0].options.windowsHide, true)
  assert.ok(!/cmd|powershell|bash|sh$|tmux|wsl/i.test(calls[0].command))
})

test('browser launch falls back to explorer.exe, and uses open/xdg-open elsewhere', async () => {
  const win = fakeSpawn((command) => command === 'explorer.exe')
  assert.equal(await openBrowser('https://auth.openai.com/oauth/authorize?x=1', { platform: 'win32', spawnImpl: win.spawnImpl }), true)
  assert.deepEqual(win.calls.map((c) => c.command), ['rundll32.exe', 'explorer.exe'])
  const mac = fakeSpawn(() => true)
  await openBrowser('https://auth.openai.com/oauth/authorize?x=1', { platform: 'darwin', spawnImpl: mac.spawnImpl })
  assert.equal(mac.calls[0].command, 'open')
  const linux = fakeSpawn(() => false)
  assert.equal(await openBrowser('https://auth.openai.com/oauth/authorize?x=1', { platform: 'linux', spawnImpl: linux.spawnImpl }), false)
  assert.equal(linux.calls[0].command, 'xdg-open')
})

test('browser launch refuses anything but the OpenAI authorize origin', async () => {
  const { spawnImpl, calls } = fakeSpawn(() => true)
  assert.equal(await openBrowser('https://evil.example/oauth', { platform: 'win32', spawnImpl }), false)
  assert.equal(await openBrowser('http://auth.openai.com/oauth/authorize', { platform: 'win32', spawnImpl }), false)
  assert.equal(await openBrowser('file:///C:/Windows/System32/calc.exe', { platform: 'win32', spawnImpl }), false)
  assert.equal(calls.length, 0)
})
