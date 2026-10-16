// Model list resolution and quota parsing.
import { FakeCredentials, grantPayload, isModelsEndpoint, isUsageEndpoint, jsonResponse, mockFetch, tempDir } from './helpers.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatGptPlusController } from '../lib/controller.js'
import {
  FALLBACK_MODELS, effortLabel, fetchAccountModels, parseModelsResponse, parseRateLimitEvent, parseRateLimitHeaders, parseUsageResponse,
} from '../lib/models.js'
import { TokenStore } from '../lib/store.js'

// Shape returned by GET https://chatgpt.com/backend-api/codex/models (codex-rs ModelsResponse).
const MODELS_RESPONSE = {
  models: [
    {
      slug: 'gpt-5.5', display_name: 'GPT-5.5', description: 'Frontier agentic coding model.',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [{ effort: 'low', description: 'Fast' }, { effort: 'medium', description: 'Balanced' }, { effort: 'high', description: 'Deep' }, { effort: 'xhigh', description: 'Deepest' }],
      shell_type: 'shell_command', visibility: 'list', supported_in_api: true, priority: 3, context_window: 272000, input_modalities: ['text', 'image'],
    },
    {
      slug: 'gpt-5.6-terra', display_name: 'GPT-5.6 Terra', default_reasoning_level: 'high',
      supported_reasoning_levels: [{ effort: 'medium', description: '' }, { effort: 'high', description: '' }, { effort: 'max', description: '' }],
      visibility: 'list', priority: 1, context_window: 272000,
    },
    { slug: 'gpt-5.3-codex-spark', display_name: 'GPT-5.3 Codex Spark', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }], visibility: 'hide', priority: 2, max_context_window: 128000 },
    { slug: 'o4-mini', display_name: 'o4-mini', supported_reasoning_levels: ['low', 'medium', 'high'], default_reasoning_level: 'unknown-level', visibility: 'list', priority: 4 },
    { slug: 'internal-only', display_name: 'Internal', supported_reasoning_levels: [], visibility: 'none', priority: 0 },
    { slug: 'gpt-5.5', display_name: 'Duplicate', supported_reasoning_levels: [], visibility: 'list', priority: 9 },
    { display_name: 'No slug' },
    null,
  ],
}

test('parses the account models response: order, visibility, efforts, defaults, context', () => {
  const models = parseModelsResponse(MODELS_RESPONSE)
  assert.deepEqual(models.map((m) => m.id), ['gpt-5.6-terra', 'gpt-5.3-codex-spark', 'gpt-5.5', 'o4-mini'])
  const terra = models[0]
  assert.equal(terra.name, 'GPT-5.6 Terra')
  assert.deepEqual(terra.efforts.map((e) => e.id), ['medium', 'high', 'max'])
  assert.equal(terra.defaultEffort, 'high')
  assert.equal(terra.contextWindow, 272000)
  assert.equal(models[1].visibility, 'hide')
  assert.equal(models[1].contextWindow, 128000)
  const gpt55 = models.find((m) => m.id === 'gpt-5.5')
  assert.equal(gpt55.description, 'Frontier agentic coding model.')
  assert.deepEqual(gpt55.efforts[0], { id: 'low', name: 'Low', description: 'Fast' })
  assert.equal(gpt55.efforts[3].name, 'Extra high')
  // Plain-string levels are accepted; an unknown default falls back to medium.
  const o4 = models.find((m) => m.id === 'o4-mini')
  assert.deepEqual(o4.efforts.map((e) => e.id), ['low', 'medium', 'high'])
  assert.equal(o4.defaultEffort, 'medium')
})

test('tolerates empty or malformed model responses', () => {
  assert.deepEqual(parseModelsResponse(null), [])
  assert.deepEqual(parseModelsResponse({}), [])
  assert.deepEqual(parseModelsResponse({ models: 'nope' }), [])
  assert.deepEqual(parseModelsResponse({ data: [{ id: 'gpt-x' }] }).map((m) => m.id), ['gpt-x'])
})

test('fetches the model list with the account headers and client version', async () => {
  const fetchImpl = mockFetch([{ match: isModelsEndpoint, respond: () => jsonResponse(MODELS_RESPONSE) }])
  const models = await fetchAccountModels({ accessToken: 'tok', accountId: 'acct-9' }, { fetchImpl, clientVersion: '0.162.1' })
  assert.equal(models.length, 4)
  const call = fetchImpl.calls[0]
  assert.equal(call.url, 'https://chatgpt.com/backend-api/codex/models?client_version=0.162.1')
  assert.equal(call.init.headers.authorization, 'Bearer tok')
  assert.equal(call.init.headers['chatgpt-account-id'], 'acct-9')
})

test('controller uses the account list, falls back to the catalog, and honours visibility preferences', async () => {
  const credentials = new FakeCredentials()
  await new TokenStore(credentials).write(grantPayload())
  let fail = true
  const fetchImpl = mockFetch([{ match: isModelsEndpoint, respond: () => (fail ? jsonResponse({ error: { message: 'boom' } }, 500) : jsonResponse(MODELS_RESPONSE)) }])
  const data = tempDir()
  const controller = new ChatGptPlusController({ credentials, fetchImpl, dataDir: data.dir, config: { callbackPort: 0 } })
  try {
    controller.start()
    await controller.ready()
    await controller.refreshModels({ force: true })
    assert.deepEqual(controller.visibleModels().map((m) => m.id), FALLBACK_MODELS.map((m) => m.id))
    assert.match((await controller.getStatus()).models.error, /built-in list/)

    fail = false
    await controller.refreshModels({ force: true })
    assert.deepEqual(controller.visibleModels().map((m) => m.id), ['gpt-5.6-terra', 'gpt-5.5', 'o4-mini'])
    const status = await controller.getStatus()
    assert.equal(status.models.source, 'account')
    assert.equal(status.models.items.find((m) => m.id === 'gpt-5.3-codex-spark').hiddenByDefault, true)

    await controller.updatePreferences({ modelVisibility: { 'gpt-5.3-codex-spark': true, 'o4-mini': false } })
    assert.deepEqual(controller.visibleModels().map((m) => m.id), ['gpt-5.6-terra', 'gpt-5.3-codex-spark', 'gpt-5.5'])

    // The list is cached per account so it is available immediately after a restart.
    const restarted = new ChatGptPlusController({ credentials, fetchImpl: mockFetch([]), dataDir: data.dir, config: { callbackPort: 0 } })
    restarted.start()
    await restarted.ready()
    assert.deepEqual(restarted.visibleModels().map((m) => m.id), ['gpt-5.6-terra', 'gpt-5.3-codex-spark', 'gpt-5.5'])
    restarted.dispose()
  } finally {
    controller.dispose()
    data.cleanup()
  }
})

test('parses the usage endpoint (plan, 5-hour and weekly windows, credits)', () => {
  const now = 1_760_000_000_000
  const usage = parseUsageResponse({
    plan_type: 'plus',
    rate_limit: {
      allowed: true, limit_reached: false,
      primary_window: { used_percent: 37, limit_window_seconds: 18000, reset_after_seconds: 1200, reset_at: 1_760_001_200 },
      secondary_window: { used_percent: 12, limit_window_seconds: 604800, reset_after_seconds: 86400, reset_at: 0 },
    },
    credits: { has_credits: false, unlimited: false, balance: '0' },
  }, now)
  assert.equal(usage.plan, 'Plus')
  assert.deepEqual(usage.primary, { usedPercent: 37, windowMinutes: 300, resetsAt: 1_760_001_200_000, resetsAfterSeconds: 1200 })
  assert.equal(usage.secondary.windowMinutes, 10080)
  assert.equal(usage.secondary.resetsAt, now + 86400_000)
  assert.deepEqual(usage.credits, { hasCredits: false, unlimited: false, balance: '0' })
  assert.equal(parseUsageResponse(null), null)
})

test('controller fetches usage on demand and caches it briefly', async () => {
  const credentials = new FakeCredentials()
  await new TokenStore(credentials).write(grantPayload())
  const fetchImpl = mockFetch([{ match: isUsageEndpoint, respond: () => jsonResponse({ plan_type: 'pro', rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_at: 1 } } }) }])
  const data = tempDir()
  const controller = new ChatGptPlusController({ credentials, fetchImpl, dataDir: data.dir, config: { callbackPort: 0 } })
  try {
    controller.start()
    const first = await controller.getUsage()
    const second = await controller.getUsage()
    assert.equal(first.plan, 'Pro')
    assert.equal(second.primary.usedPercent, 5)
    const usageCalls = () => fetchImpl.calls.filter((c) => isUsageEndpoint(c.url))
    assert.equal(usageCalls().length, 1)
    await controller.getUsage({ force: true })
    assert.equal(usageCalls().length, 2)
    assert.equal(usageCalls()[0].init.headers['chatgpt-account-id'], 'acct-test-1')
  } finally {
    controller.dispose()
    data.cleanup()
  }
})

test('parses x-codex rate-limit headers and codex.rate_limits events', () => {
  const headers = new Headers({ 'x-codex-primary-used-percent': '81', 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-at': '1760000000', 'x-codex-secondary-used-percent': '15' })
  assert.deepEqual(parseRateLimitHeaders(headers), {
    primary: { usedPercent: 81, windowMinutes: 300, resetsAt: 1_760_000_000_000, resetsAfterSeconds: null },
    secondary: { usedPercent: 15, windowMinutes: null, resetsAt: null, resetsAfterSeconds: null },
    source: 'response-headers',
  })
  assert.equal(parseRateLimitHeaders(new Headers()), null)
  const event = parseRateLimitEvent({ type: 'codex.rate_limits', plan_type: 'plus', rate_limits: { primary: { used_percent: 50, window_minutes: 300, reset_at: 1760000000 } } })
  assert.equal(event.primary.usedPercent, 50)
  assert.equal(event.plan, 'Plus')
})

test('effort labels and catalog integrity', () => {
  assert.equal(effortLabel('xhigh'), 'Extra high')
  assert.equal(effortLabel('none'), 'None')
  assert.equal(effortLabel('super_deep'), 'Super deep')
  const ids = FALLBACK_MODELS.map((m) => m.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const model of FALLBACK_MODELS) {
    assert.ok(model.efforts.length > 0, model.id)
    assert.ok(model.efforts.some((e) => e.id === model.defaultEffort), model.id)
    assert.ok(Number.isInteger(model.contextWindow) && model.contextWindow > 0, model.id)
  }
  assert.ok(ids.includes('gpt-5.6-terra') && ids.includes('gpt-5.5'))
})
