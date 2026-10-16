// Provider route: registration with the `llm` service, model metadata, request building,
// SSE parsing and translation into DSH stream chunks.
import {
  CREDENTIAL_KEY, FakeCredentials, collect, grantPayload, installGlobalFetch, isModelsEndpoint, isResponsesEndpoint, jsonResponse,
  mockContext, mockFetch, sampleTurnEvents, sseResponse, tempDir, waitFor,
} from './helpers.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name } from '../lib/index.js'
import { ChatGptPlusController } from '../lib/controller.js'
import {
  buildRequestBody, convertMessages, createChatGptAdapter, parseSse, repairToolPairs, toResolvedModelInfo, translateResponsesStream,
} from '../lib/provider.js'
import { FALLBACK_MODELS } from '../lib/models.js'
import { TokenStore } from '../lib/store.js'

async function* fromArray(items) {
  for (const item of items) yield item
}

/** The exact-model checks LlmRuntime.normalizeModelInfo applies (dsh-llm 0.2.1-alpha.3). */
function assertRuntimeAcceptsModelInfo(info, provider, model) {
  assert.equal(info.provider, provider)
  assert.equal(info.id, model)
  assert.ok(typeof info.name === 'string' && info.name.length > 0)
  if (info.description !== undefined) assert.equal(typeof info.description, 'string')
  if (info.context !== undefined) assert.ok(Number.isInteger(info.context.contextWindow) && info.context.contextWindow > 0)
  if (info.inputModalities !== undefined) assert.ok(info.inputModalities.every((m) => m === 'text' || m === 'image'))
  if (info.reasoning !== undefined) {
    assert.ok(info.reasoning.efforts.length > 0)
    const ids = info.reasoning.efforts.map((e) => e.id)
    assert.equal(new Set(ids).size, ids.length)
    assert.ok(info.reasoning.efforts.every((e) => typeof e.id === 'string' && e.id && typeof e.name === 'string' && e.name))
    if (info.reasoning.defaultEffort !== undefined) assert.ok(ids.includes(info.reasoning.defaultEffort))
  }
}

test('plugin metadata: cordis name and required services', () => {
  assert.equal(name, 'chatgpt-plus')
  assert.deepEqual(inject, ['llm', 'credentials'])
})

test('registers the chatgpt-plus route with the llm service and mounts the settings endpoints', async () => {
  const restore = installGlobalFetch()
  const harness = mockContext()
  try {
    apply(harness.ctx, { callbackPort: 0 })
    assert.equal(harness.registrations.length, 1)
    const [registration] = harness.registrations
    assert.deepEqual(registration.providers, ['chatgpt-plus'])
    assert.deepEqual(registration.adapter.providerInfo('chatgpt-plus'), { id: 'chatgpt-plus', name: 'ChatGPT Plus' })
    assert.equal(registration.adapter.providerRetryPolicy('chatgpt-plus'), undefined)
    for (const method of ['providerInfo', 'providerRetryPolicy', 'imageRequestPricing', 'imageRequestTarget', 'listModels', 'resolveModel', 'prepareCall', 'stream']) {
      assert.equal(typeof registration.adapter[method], 'function', `adapter.${method}`)
    }
    assert.deepEqual(harness.routes.map((r) => [r.kind, r.path]), [['prefix', '/_dsh/chatgpt-plus-dsh']])
    assert.ok(harness.listeners.get('credentials/record-updated')?.size === 1)
  } finally {
    await harness.unload()
    restore()
  }
})

test('model picker: empty while signed out, account models after sign-in, with change announcements', async () => {
  const fetchImpl = mockFetch([{
    match: isModelsEndpoint,
    respond: () => jsonResponse({ models: [
      { slug: 'gpt-5.5', display_name: 'GPT-5.5', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }], default_reasoning_level: 'medium', visibility: 'list', priority: 2, context_window: 272000 },
      { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6 Terra', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'xhigh' }], visibility: 'list', priority: 1 },
      { slug: 'gpt-hidden', display_name: 'Hidden', supported_reasoning_levels: [{ effort: 'low' }], visibility: 'hide', priority: 3 },
    ] }),
  }])
  const restore = installGlobalFetch(fetchImpl)
  const credentials = new FakeCredentials()
  const harness = mockContext({ credentials })
  try {
    apply(harness.ctx, { callbackPort: 0 })
    const adapter = harness.registrations[0].adapter
    assert.deepEqual(await adapter.listModels('chatgpt-plus'), [])

    await new TokenStore(credentials).write(grantPayload())
    harness.emit('credentials/record-updated', CREDENTIAL_KEY)
    await waitFor(() => harness.registrations[0].replaced >= 1, { message: 'adapters-updated announcement' })
    await waitFor(async () => (await adapter.listModels('chatgpt-plus')).length === 2, { message: 'account models' })
    const listed = await adapter.listModels('chatgpt-plus')
    assert.deepEqual(listed.map((m) => m.id), ['gpt-5.6-terra', 'gpt-5.5'])
    assert.ok(listed.every((m) => m.provider === 'chatgpt-plus' && m.name && m.inputModalities[0] === 'text'))
    const call = fetchImpl.calls.find((c) => isModelsEndpoint(c.url))
    assert.match(call.url, /client_version=\d+\.\d+\.\d+/)
    assert.equal(call.init.headers['chatgpt-account-id'], 'acct-test-1')
  } finally {
    await harness.unload()
    restore()
  }
})

test('exact-model metadata passes the runtime validation for every catalog model', async () => {
  for (const model of FALLBACK_MODELS) {
    assertRuntimeAcceptsModelInfo(toResolvedModelInfo('chatgpt-plus', model), 'chatgpt-plus', model.id)
  }
  // Preferred effort is used only when the model supports it.
  const terra = FALLBACK_MODELS.find((m) => m.id === 'gpt-5.6-terra')
  assert.equal(toResolvedModelInfo('chatgpt-plus', terra, 'max').reasoning.defaultEffort, 'max')
  assert.equal(toResolvedModelInfo('chatgpt-plus', terra, 'bogus').reasoning.defaultEffort, 'medium')

  const data = tempDir()
  const controller = new ChatGptPlusController({ credentials: new FakeCredentials(), dataDir: data.dir, config: { callbackPort: 0 } })
  try {
    const adapter = createChatGptAdapter({ controller })
    const prepared = await adapter.prepareCall('chatgpt-plus', 'gpt-5.5')
    assertRuntimeAcceptsModelInfo(prepared.model, 'chatgpt-plus', 'gpt-5.5')
    assert.equal(typeof prepared.stream, 'function')
    // Unknown ids still resolve (DSH core routing accepts unlisted models).
    assertRuntimeAcceptsModelInfo(await adapter.resolveModel('chatgpt-plus', 'gpt-future'), 'chatgpt-plus', 'gpt-future')
    assert.deepEqual(adapter.imageRequestTarget('chatgpt-plus', 'gpt-5.5', { width: 10, height: 20, bytes: 30 }), { width: 10, height: 20, maxBytes: 30 })
  } finally {
    controller.dispose()
    data.cleanup()
  }
})

test('request body: system → instructions, non-strict tools, reasoning effort, cache key', () => {
  const body = buildRequestBody({
    provider: 'chatgpt-plus',
    model: 'gpt-5.5',
    reasoningEffort: 'high',
    sessionId: 'session-42',
    temperature: 0.2,
    maxTokens: 999,
    stop: ['END'],
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'You are DSH.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ],
    tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }, { name: 'read_file', description: 'dup', parameters: {} }],
  })
  assert.equal(body.model, 'gpt-5.5')
  assert.equal(body.instructions, 'You are DSH.')
  assert.equal(body.store, false)
  assert.equal(body.stream, true)
  assert.deepEqual(body.include, ['reasoning.encrypted_content'])
  assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' })
  assert.equal(body.prompt_cache_key, 'session-42')
  assert.deepEqual(body.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }])
  assert.deepEqual(body.tools, [{ type: 'function', name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } }, strict: false }])
  for (const unsupported of ['temperature', 'max_output_tokens', 'stop']) assert.ok(!(unsupported in body))
  assert.deepEqual(buildRequestBody({ model: 'm', reasoningEffort: 'none', messages: [] }).reasoning, { effort: 'none' })
  assert.equal(buildRequestBody({ model: 'm', messages: [] }).instructions, 'You are a helpful assistant.')
  assert.ok(!('tools' in buildRequestBody({ model: 'm', messages: [] })))
})

test('history conversion replays encrypted reasoning only for the same model', () => {
  const assistant = (model) => ({
    role: 'assistant',
    content: [{ type: 'reasoning', text: 'thought' }, { type: 'text', text: 'answer' }, { type: 'tool-call', id: 'call_9', name: 'ls', arguments: '' }],
    source: { kind: 'model', provider: 'chatgpt-plus', model, replayState: { response: { id: 'r' }, blocks: [{ type: 'reasoning', encrypted_content: 'ENC', summary: [{ type: 'summary_text', text: 'thought' }] }, { type: 'message' }, { type: 'function_call' }] } },
  })
  const tool = { role: 'tool', toolCallId: 'call_9', content: [{ type: 'text', text: 'a.txt' }], source: { kind: 'tool', callId: 'call_9' } }
  const same = convertMessages([{ role: 'user', content: [{ type: 'text', text: 'q' }] }, assistant('gpt-5.5'), tool], { model: 'gpt-5.5' }).input
  assert.deepEqual(same.map((i) => i.type), ['message', 'reasoning', 'message', 'function_call', 'function_call_output'])
  assert.deepEqual(same[1], { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thought' }], encrypted_content: 'ENC' })
  assert.equal(same[3].arguments, '{}')
  assert.ok(!('id' in same[1]) && !('id' in same[3]), 'item ids are not sent with store:false')
  const other = convertMessages([assistant('gpt-5.5'), tool], { model: 'gpt-5.6-terra' }).input
  assert.ok(!other.some((i) => i.type === 'reasoning'))
})

test('history conversion: developer/system updates, text-only images, tool errors', () => {
  const { instructions, input } = convertMessages([
    { role: 'system', content: [{ type: 'text', text: 'Base prompt' }] },
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: { id: 'x' } }] },
    { role: 'system', content: [{ type: 'text', text: 'Updated prompt' }] },
    { role: 'developer', content: [{ type: 'tool-addition', toolName: 'x' }, { type: 'text', text: 'note' }] },
  ], { system: 'One-shot system' })
  assert.equal(instructions, 'One-shot system\n\nBase prompt')
  assert.deepEqual(input[0].content[1], { type: 'input_text', text: '[image omitted: this model route accepts text only]' })
  assert.deepEqual(input[1], { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Updated prompt' }] })
  assert.deepEqual(input[2], { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'note' }] })
})

test('tool pairs: synthesized output right after an unanswered call, orphan outputs dropped', () => {
  const repaired = repairToolPairs([
    { type: 'function_call', call_id: 'a', name: 'x', arguments: '{}' },
    { type: 'function_call', call_id: 'b', name: 'y', arguments: '{}' },
    { type: 'function_call_output', call_id: 'b', output: 'ok' },
    { type: 'function_call_output', call_id: 'ghost', output: 'orphan' },
    { type: 'function_call_output', call_id: 'b', output: 'duplicate' },
    { type: 'message', role: 'user', content: [] },
  ])
  assert.deepEqual(repaired.map((i) => `${i.type}:${i.call_id ?? ''}`), [
    'function_call:a', 'function_call_output:a', 'function_call:b', 'function_call_output:b', 'message:',
  ])
  assert.match(repaired[1].output, /interrupted/)
})

test('SSE parser: CRLF, byte-split frames, comments, multi-line data, unterminated final frame', async () => {
  const raw = ': keep-alive\r\n\r\nevent: response.created\r\ndata: {"type":"response.created",\r\ndata: "response":{"id":"r1"}}\r\n\r\ndata: {"type":"response.output_text.delta","delta":"é✓"}\n\ndata: [DONE]\n\ndata: {"type":"tail"}'
  const bytes = new TextEncoder().encode(raw)
  let activity = 0
  const body = new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3)); c.close() } })
  const events = await collect(parseSse(body, { onActivity: () => { activity += 1 } }))
  assert.deepEqual(events, [{ type: 'response.created', response: { id: 'r1' } }, { type: 'response.output_text.delta', delta: 'é✓' }, { type: 'tail' }])
  assert.ok(activity > 10)
  const bad = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {not json}\n\n')); c.close() } })
  await assert.rejects(collect(parseSse(bad)), (e) => e.code === 'MALFORMED_RESPONSE')
})

test('stream translation follows the DSH chunk protocol', async () => {
  const chunks = await collect(translateResponsesStream(fromArray(sampleTurnEvents()), { model: 'gpt-5.5' }))
  assert.deepEqual(chunks.map((c) => c.type), [
    'block-start', 'reasoning-delta', 'reasoning-delta', 'block-end',
    'block-start', 'text-delta', 'text-delta', 'block-end',
    'block-start', 'tool-call-delta', 'tool-call-delta', 'tool-call-delta', 'block-end',
    'usage', 'finish',
  ])
  const starts = chunks.filter((c) => c.type === 'block-start')
  assert.deepEqual(starts.map((c) => [c.index, c.blockType]), [[0, 'reasoning'], [1, 'text'], [2, 'tool-call']])
  const ends = chunks.filter((c) => c.type === 'block-end').map((c) => c.block)
  assert.deepEqual(ends, [
    { type: 'reasoning', text: 'Plan: read the file.' },
    { type: 'text', text: 'Reading it now.' },
    { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"notes.txt"}' },
  ])
  const firstToolDelta = chunks.find((c) => c.type === 'tool-call-delta')
  assert.equal(firstToolDelta.name, 'read_file')
  assert.equal(firstToolDelta.id, 'call_1')
  assert.deepEqual(chunks.find((c) => c.type === 'usage').usage, { inputTokens: 600, outputTokens: 50, cacheReadTokens: 400, reasoningTokens: 20, totalTokens: 1050 })
  const finish = chunks.at(-1)
  assert.deepEqual(finish.reason, { kind: 'tool-calls' })
  assert.equal(finish.replayState.blocks.length, 3)
  assert.equal(finish.replayState.blocks[0].encrypted_content, 'gAAAA-encrypted')
  assert.equal(finish.replayState.response.id, 'resp_1')
  // Every block-start is closed before usage/finish, and nothing follows finish.
  assert.equal(starts.length, ends.length)
})

test('stream translation: stop, max-tokens, content filter, empty and truncated streams', async () => {
  const text = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
    { type: 'response.output_text.delta', output_index: 0, delta: 'Hi' },
  ]
  const stop = await collect(translateResponsesStream(fromArray([...text, { type: 'response.done', response: { status: 'completed' } }]), { model: 'm' }))
  assert.deepEqual(stop.at(-1).reason, { kind: 'stop' })
  assert.deepEqual(stop.filter((c) => c.type === 'block-end').map((c) => c.block), [{ type: 'text', text: 'Hi' }])

  const truncated = await collect(translateResponsesStream(fromArray([...text, { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }]), { model: 'm' }))
  assert.deepEqual(truncated.at(-1).reason, { kind: 'max-tokens' })

  await assert.rejects(collect(translateResponsesStream(fromArray([...text, { type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' } } }]), { model: 'm' })), (e) => e.code === 'CONTENT_FILTER')
  await assert.rejects(collect(translateResponsesStream(fromArray([{ type: 'response.completed', response: { status: 'completed' } }]), { model: 'm' })), (e) => e.code === 'EMPTY_RESPONSE')
  await assert.rejects(collect(translateResponsesStream(fromArray(text), { model: 'm' })), (e) => e.code === 'TRANSPORT')
})

test('adapter stream: headers, account routing and passive quota from response headers', async () => {
  const credentials = new FakeCredentials()
  const grant = grantPayload()
  await new TokenStore(credentials).write(grant)
  const fetchImpl = mockFetch([{ match: isResponsesEndpoint, respond: () => sseResponse(sampleTurnEvents(), { chunkSize: 7, headers: { 'x-codex-primary-used-percent': '42.5', 'x-codex-primary-window-minutes': '300', 'x-codex-secondary-used-percent': '10' } }) }])
  const data = tempDir()
  const controller = new ChatGptPlusController({ credentials, fetchImpl, dataDir: data.dir, config: { callbackPort: 0 } })
  try {
    controller.start()
    await controller.ready()
    const adapter = createChatGptAdapter({ controller, fetchImpl })
    const prepared = await adapter.prepareCall('chatgpt-plus', 'gpt-5.5')
    const chunks = await collect(prepared.stream({ provider: 'chatgpt-plus', model: 'gpt-5.5', reasoningEffort: 'medium', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], sessionId: 's-1' }))
    assert.equal(chunks.at(-1).type, 'finish')
    const call = fetchImpl.calls.find((c) => isResponsesEndpoint(c.url))
    assert.equal(call.url, 'https://chatgpt.com/backend-api/codex/responses')
    assert.equal(call.init.method, 'POST')
    assert.equal(call.init.headers.authorization, `Bearer ${grant.access_token}`)
    assert.equal(call.init.headers['chatgpt-account-id'], 'acct-test-1')
    assert.equal(call.init.headers['openai-beta'], 'responses=experimental')
    assert.equal(call.init.headers.accept, 'text/event-stream')
    assert.equal(call.init.headers['session-id'], 's-1')
    assert.ok(call.init.headers.originator && call.init.headers['user-agent'])
    const usage = controller.usageSnapshot()
    assert.equal(usage.primary.usedPercent, 42.5)
    assert.equal(usage.primary.windowMinutes, 300)
    assert.equal(usage.secondary.usedPercent, 10)
  } finally {
    controller.dispose()
    data.cleanup()
  }
})

test('adapter stream: the caller can stop early and the request is aborted', async () => {
  const credentials = new FakeCredentials()
  await new TokenStore(credentials).write(grantPayload())
  let signal
  const fetchImpl = mockFetch([{ match: isResponsesEndpoint, respond: (url, init) => { signal = init.signal; return sseResponse(sampleTurnEvents()) } }])
  const data = tempDir()
  const controller = new ChatGptPlusController({ credentials, fetchImpl, dataDir: data.dir, config: { callbackPort: 0 } })
  try {
    controller.start()
    const adapter = createChatGptAdapter({ controller, fetchImpl })
    const iterator = adapter.stream({ provider: 'chatgpt-plus', model: 'gpt-5.5', messages: [] })[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.return()
    assert.equal(signal.aborted, true)
  } finally {
    controller.dispose()
    data.cleanup()
  }
})
