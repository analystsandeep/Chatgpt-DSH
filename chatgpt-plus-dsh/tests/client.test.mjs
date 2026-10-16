// Browser bundle contract: module-loader registration, slot registration, and rendering of the
// settings page in each account state (with and without the host UI primitives).
import './helpers.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function makeReact(seeds = []) {
  let call = 0
  const React = {
    Fragment: Symbol.for('react.fragment'),
    createElement(type, props, ...children) {
      if (type === undefined || type === null) throw new Error('createElement called with an undefined component')
      return { type, props: { ...(props ?? {}), children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children } }
    },
    useState(initial) {
      const index = call++
      return [index < seeds.length && seeds[index] !== undefined ? seeds[index] : initial, () => {}]
    },
    useEffect() {},
    useRef(value) {
      return { current: value }
    },
    useCallback(fn) {
      return fn
    },
  }
  return React
}

function fakePrimitives(React) {
  const component = (tag) => (props) => React.createElement(tag, { 'data-primitive': true, ...props }, props.children ?? props.label)
  return { Button: component('button'), Switch: component('switch'), Checkbox: component('checkbox'), Tag: component('tag'), StateDot: component('dot') }
}

/** Load the bundle into a fresh VM context and materialize its factory. */
function loadBundle({ withPrimitives = false, seeds = [] } = {}) {
  const registrations = []
  const context = vm.createContext({
    window: { __ModuleLoader__: { load: (entry) => registrations.push(entry) } },
    console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
  })
  vm.runInContext(SOURCE, context, { filename: 'lib/client.js' })
  assert.equal(registrations.length, 1)
  const React = makeReact(seeds)
  const required = []
  const exports = registrations[0].factory((specifier) => {
    required.push(specifier)
    if (specifier === 'react') return React
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
      if (withPrimitives) return fakePrimitives(React)
      throw new Error('client-modules: require missed the module table')
    }
    throw new Error(`unexpected require(${specifier})`)
  })
  return { registration: registrations[0], exports, React, required }
}

function renderTree(node, React) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((n) => renderTree(n, React))
  assert.notEqual(node.type, undefined)
  if (typeof node.type === 'function') return renderTree(node.type(node.props), React)
  return { type: node.type === React.Fragment ? 'fragment' : node.type, props: { ...node.props, children: renderTree(node.props.children, React) } }
}

function textOf(tree) {
  if (tree === null) return ''
  if (typeof tree === 'string') return tree
  if (Array.isArray(tree)) return tree.map(textOf).join(' ')
  return textOf(tree.props.children)
}

function findAll(tree, predicate, out = []) {
  if (tree && typeof tree === 'object') {
    if (Array.isArray(tree)) tree.forEach((t) => findAll(t, predicate, out))
    else {
      if (predicate(tree)) out.push(tree)
      findAll(tree.props.children, predicate, out)
    }
  }
  return out
}

function snapshot(overrides = {}) {
  const now = 1_760_000_000_000
  return {
    plugin: { name: 'chatgpt-plus-dsh', version: '1.0.0' },
    provider: { id: 'chatgpt-plus', name: 'ChatGPT Plus' },
    status: 'connected',
    account: { email: 'ja•••@example.com', planType: 'plus', plan: 'Plus', expiresAt: now + 9 * 86_400_000, refreshedAt: now - 3_600_000, signedInAt: now - 86_400_000 },
    signIn: null,
    error: null,
    preferences: { autoRefresh: true, modelVisibility: {}, defaultEffort: null },
    models: {
      source: 'account', fetchedAt: now - 60_000, error: null, loading: false,
      items: [
        { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', visible: true, hiddenByDefault: false, efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], defaultEffort: 'medium', contextWindow: 272000 },
        { id: 'gpt-5.5', name: 'GPT-5.5', visible: false, hiddenByDefault: false, efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low', contextWindow: 272000 },
      ],
    },
    defaultModel: { provider: 'chatgpt-plus', model: 'gpt-5.6-terra', reasoningEffort: 'high' },
    usage: { plan: 'Plus', primary: { usedPercent: 37, windowMinutes: 300, resetsAt: now + 3_600_000 }, secondary: { usedPercent: 92, windowMinutes: 10080, resetsAt: now + 86_400_000 }, credits: null, fetchedAt: now - 1000 },
    storage: { credentialKey: 'chatgpt-plus/account', available: true },
    now,
    ...overrides,
  }
}

function renderPage(data, { withPrimitives = false, model = 'gpt-5.6-terra', effort = 'high' } = {}) {
  const { exports, React } = loadBundle({ withPrimitives, seeds: [data, '', '', '', '', model, effort] })
  let Component
  exports.apply({
    effect: (fn) => {
      const disposer = fn()
      assert.equal(typeof disposer, 'function')
      return disposer
    },
    slots: { inject: (key, cb) => cb(), register: (options, component) => { Component = component; return () => {} } },
  })
  return renderTree(React.createElement(Component, { view: 'page' }), React)
}

test('bundle registers one factory under the package name, requiring only seed modules', () => {
  const { registration, exports, required } = loadBundle({ withPrimitives: true })
  assert.equal(registration.id, 'chatgpt-plus-dsh')
  assert.deepEqual([...exports.inject], ['slots'])
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(required.sort(), ['@deepseek-ai/dsh-client-ui-primitives', 'react'])
})

test('apply registers the plugin page in the keyed plugins.bundle.config slot', () => {
  const { exports } = loadBundle()
  const calls = { inject: [], register: [], effects: 0 }
  exports.apply({
    effect: (fn) => {
      calls.effects += 1
      return fn()
    },
    slots: {
      inject: (key, cb) => {
        calls.inject.push(key)
        return cb()
      },
      register: (options, component) => {
        calls.register.push({ options, component })
        return () => {}
      },
    },
  })
  assert.deepEqual(calls.inject, ['plugins.bundle.config'])
  assert.equal(calls.register.length, 1)
  const { options, component } = calls.register[0]
  assert.equal(options.name, 'plugins.bundle.config')
  assert.equal(options.key, 'chatgpt-plus-dsh')
  assert.equal(options.label(), 'ChatGPT Plus')
  assert.equal(typeof component, 'function')
  assert.equal(calls.effects, 1)
})

test('summary view renders without network access', () => {
  const { exports, React } = loadBundle()
  let Component
  exports.apply({ effect: (fn) => fn(), slots: { inject: (k, cb) => cb(), register: (o, c) => { Component = c } } })
  const tree = renderTree(Component({ view: 'summary' }), React)
  assert.match(textOf(tree), /ChatGPT Plus\/Pro subscription/)
})

test('connected state: account, token, models and usage sections (native fallbacks)', () => {
  const tree = renderPage(snapshot())
  const text = textOf(tree)
  for (const expected of ['Connected', 'ja•••@example.com', 'ChatGPT Plus', 'Sign in again', 'Sign out', 'Refresh tokens automatically', 'Refresh token now', 'Use as DSH default', 'GPT-5.6 Terra', '5-hour limit', 'Weekly limit', '37% used', 'Refresh usage']) {
    assert.ok(text.includes(expected), `missing “${expected}”`)
  }
  const options = findAll(tree, (n) => n.type === 'option').map((o) => o.props.value)
  assert.deepEqual(options.slice(0, 2), ['gpt-5.6-terra', 'gpt-5.5'])
  assert.equal(findAll(tree, (n) => n.props?.className?.includes?.('cgp-bar--high')).length, 1, 'the 92% window is highlighted')
})

test('signed-out state offers “Sign in with ChatGPT” and hides account-only sections', () => {
  const tree = renderPage(snapshot({ status: 'signed-out', account: null, usage: null }))
  const text = textOf(tree)
  assert.ok(text.includes('Sign in with ChatGPT'))
  assert.ok(text.includes('Not signed in'))
  assert.ok(!text.includes('Refresh token now'))
  assert.ok(!text.includes('Use as DSH default'))
})

test('signing-in state shows the sign-in link and the paste fallback when the port is busy', () => {
  const authUrl = 'https://auth.openai.com/oauth/authorize?client_id=app_EMoamEEZ73f0CkXaXp7hrann&state=s'
  const tree = renderPage(snapshot({
    status: 'signing-in', account: null, usage: null,
    signIn: { phase: 'waiting', authUrl, redirectUri: 'http://localhost:1455/auth/callback', startedAt: 1, expiresAt: 1_760_000_300_000, callbackListening: false, portBusy: true, callbackError: 'Port 1455 on 127.0.0.1 is already in use.', browserOpened: true },
  }), { withPrimitives: true })
  const text = textOf(tree)
  assert.ok(text.includes('Paste the redirect address'))
  assert.ok(text.includes('Port 1455 on 127.0.0.1 is already in use.'))
  assert.ok(text.includes('Complete sign-in'))
  assert.ok(text.includes('Cancel'))
  const link = findAll(tree, (n) => n.type === 'a')[0]
  assert.equal(link.props.href, authUrl)
  assert.equal(link.props.target, '_blank')
  assert.match(link.props.rel, /noopener/)
})

test('expired and error states surface the problem and the way out', () => {
  const tree = renderPage(snapshot({ status: 'expired', error: { code: 'REFRESH_REJECTED', message: 'ChatGPT rejected the saved sign-in. Click “Sign in again”.', at: 1 } }), { withPrimitives: true })
  const text = textOf(tree)
  assert.ok(text.includes('Sign-in expired'))
  assert.ok(text.includes('ChatGPT rejected the saved sign-in'))
  const alerts = findAll(tree, (n) => n.props?.role === 'alert')
  assert.equal(alerts.length, 1)
})

test('loading state before the first status arrives', () => {
  const tree = renderPage(null)
  assert.ok(textOf(tree).includes('Loading'))
})
