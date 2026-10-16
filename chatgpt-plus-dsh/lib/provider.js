// The `chatgpt-plus` provider route: a DSH LLM adapter for the ChatGPT Codex Responses
// endpoint (https://chatgpt.com/backend-api/codex/responses), authenticated with the
// signed-in ChatGPT account, so calls draw on the subscription quota.
//
// ctx.llm.registerAdapter() duck-types adapters (it calls providerInfo/providerRetryPolicy at
// registration and prepareCall/stream per request), so this object implements the full
// LlmAdapter surface of @deepseek-ai/dsh-llm without importing the class.
//
// Stream protocol emitted (dsh-llm StreamChunk): block-start → text/reasoning/tool-call deltas
// → block-end per output item, then one `usage`, then one terminal `finish` carrying a replay
// envelope. Encrypted reasoning items are kept in that envelope and sent back on later turns
// with `store: false`, exactly like the Codex CLI does.
import {
  CHATGPT_BACKEND_URL, CODEX_RESPONSES_PATH, DEFAULT_INSTRUCTIONS, DEFAULTS, ORIGINATOR, PROVIDER_NAME, USER_AGENT,
} from './constants.js'
import { ChatGptPlusError, classifyHttpError, classifyStreamFailure, transportError } from './errors.js'
import { parseRateLimitEvent, parseRateLimitHeaders } from './models.js'

// ---------------------------------------------------------------------------
// Request conversion: DSH messages → Responses API `instructions` + `input` items
// ---------------------------------------------------------------------------

function textOf(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n\n')
}

function userParts(content) {
  if (typeof content === 'string') return content ? [{ type: 'input_text', text: content }] : []
  const parts = []
  for (const block of Array.isArray(content) ? content : []) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) parts.push({ type: 'input_text', text: block.text })
    // The route declares text-only input, so DSH projects images and files to text before
    // dispatch; these placeholders only cover histories that bypassed that projection.
    else if (block.type === 'image') parts.push({ type: 'input_text', text: '[image omitted: this model route accepts text only]' })
    else if (block.type === 'file') parts.push({ type: 'input_text', text: `[file: ${block.attachment?.name ?? 'attachment'}]` })
  }
  return parts
}

function developerItem(text) {
  return { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] }
}

function normalizeArguments(value) {
  if (typeof value === 'string') return value.trim().length > 0 ? value : '{}'
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

function toolOutputText(content, isError) {
  const parts = []
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block?.type === 'image') parts.push('[image output omitted]')
  }
  const text = parts.join('\n')
  if (text.length > 0) return text
  return isError ? 'The tool failed without output.' : '(no output)'
}

/** Replay entries aligned with an assistant message's content, or null. */
function replayBlocksOf(message) {
  const state = message?.source?.replayState
  const blocks = state && typeof state === 'object' ? state.blocks : undefined
  if (!Array.isArray(blocks) || blocks.length !== message.content.length) return null
  return blocks
}

function assistantItems(message, targetModel) {
  const items = []
  const content = Array.isArray(message.content) ? message.content : []
  const replay = replayBlocksOf({ ...message, content })
  // Encrypted reasoning is only valid for the model that produced it.
  const sameModel = typeof message.source?.model === 'string' && message.source.model === targetModel
  content.forEach((block, i) => {
    if (!block || typeof block !== 'object') return
    const meta = replay?.[i]
    if (block.type === 'reasoning') {
      if (sameModel && meta?.type === 'reasoning' && typeof meta.encrypted_content === 'string' && meta.encrypted_content.length > 0) {
        const summary = Array.isArray(meta.summary) && meta.summary.every((s) => s?.type === 'summary_text' && typeof s.text === 'string')
          ? meta.summary.map((s) => ({ type: 'summary_text', text: s.text }))
          : (block.text ? [{ type: 'summary_text', text: block.text }] : [])
        items.push({ type: 'reasoning', summary, encrypted_content: meta.encrypted_content })
      }
      return
    }
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text.length > 0) {
        items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: block.text }] })
      }
      return
    }
    if (block.type === 'tool-call') {
      items.push({ type: 'function_call', call_id: String(block.id), name: String(block.name), arguments: normalizeArguments(block.arguments) })
    }
  })
  return items
}

/**
 * The Responses API rejects a function_call without a matching function_call_output and an
 * output without its call. Compaction, an interrupted turn or a cancelled tool can leave
 * either half alone, so orphan outputs are dropped and missing outputs are synthesized right
 * after their call (the same repair the Codex CLI applies to its history).
 */
export function repairToolPairs(items) {
  const calls = new Set()
  const outputs = new Set()
  for (const item of items) {
    if (item.type === 'function_call') calls.add(item.call_id)
    else if (item.type === 'function_call_output') outputs.add(item.call_id)
  }
  const result = []
  const emittedOutputs = new Set()
  for (const item of items) {
    if (item.type === 'function_call_output') {
      if (!calls.has(item.call_id) || emittedOutputs.has(item.call_id)) continue
      emittedOutputs.add(item.call_id)
      result.push(item)
      continue
    }
    result.push(item)
    if (item.type === 'function_call' && !outputs.has(item.call_id) && !emittedOutputs.has(item.call_id)) {
      emittedOutputs.add(item.call_id)
      result.push({ type: 'function_call_output', call_id: item.call_id, output: 'No result was recorded for this tool call (it was interrupted).' })
    }
  }
  return result
}

/**
 * Convert DSH request messages. Leading system messages become `instructions`; later system
 * messages and developer text become developer messages; tool-addition/removal blocks are
 * ignored because the route declares no tool-update support (DSH then always sends the
 * complete tool list).
 */
export function convertMessages(messages, { model, system } = {}) {
  const instructions = []
  if (typeof system === 'string' && system.trim().length > 0) instructions.push(system)
  const items = []
  let leading = true
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue
    const content = message.content
    if (message.role === 'system') {
      const text = textOf(content)
      if (text) {
        if (leading) instructions.push(text)
        else items.push(developerItem(text))
      }
      continue
    }
    leading = false
    switch (message.role) {
      case 'developer': {
        const text = textOf(content)
        if (text) items.push(developerItem(text))
        break
      }
      case 'user': {
        const parts = userParts(content)
        if (parts.length > 0) items.push({ type: 'message', role: 'user', content: parts })
        break
      }
      case 'assistant':
        items.push(...assistantItems(message, model))
        break
      case 'tool':
        if (message.toolCallId !== undefined) {
          items.push({ type: 'function_call_output', call_id: String(message.toolCallId), output: toolOutputText(content, message.isError === true) })
        }
        break
      default:
        break
    }
  }
  return { instructions: instructions.join('\n\n'), input: repairToolPairs(items) }
}

function normalizeSchema(parameters) {
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) return { type: 'object', properties: {} }
  return typeof parameters.type === 'string' ? parameters : { type: 'object', ...parameters }
}

/** DSH ToolSchema[] → Responses API function tools (non-strict, like the Codex CLI). */
export function convertTools(tools) {
  const out = []
  const seen = new Set()
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool.name !== 'string' || tool.name.length === 0 || seen.has(tool.name)) continue
    seen.add(tool.name)
    out.push({
      type: 'function',
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: normalizeSchema(tool.parameters),
      strict: false,
    })
  }
  return out
}

/**
 * Build the Codex responses request body. `temperature`, `maxTokens` and `stop` are not sent:
 * the ChatGPT Codex backend serves reasoning models that reject them.
 */
export function buildRequestBody(options) {
  const { instructions, input } = convertMessages(options.messages, { model: options.model, system: options.system })
  const body = {
    model: options.model,
    instructions: instructions || DEFAULT_INSTRUCTIONS,
    input,
    tool_choice: 'auto',
    parallel_tool_calls: true,
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
  }
  const tools = convertTools(options.tools)
  if (tools.length > 0) body.tools = tools
  const effort = options.reasoningEffort
  if (typeof effort === 'string' && effort.length > 0) {
    body.reasoning = effort === 'none' ? { effort: 'none' } : { effort, summary: 'auto' }
  }
  if (typeof options.sessionId === 'string' && options.sessionId.length > 0) {
    body.prompt_cache_key = options.sessionId.slice(0, 64)
  }
  return body
}

// ---------------------------------------------------------------------------
// Server-sent events
// ---------------------------------------------------------------------------

/**
 * Decode an SSE byte stream into JSON events. Handles CRLF, multi-line `data:` fields,
 * comments/heartbeats and a final frame without a trailing blank line.
 * @param {ReadableStream<Uint8Array>} body
 * @param {{onActivity?: () => void, signal?: AbortSignal}} [hooks] - `onActivity` is called for
 *   every chunk received (idle watchdog); aborting `signal` cancels the reader immediately, so a
 *   stalled read cannot outlive a timeout or a cancelled request.
 */
export async function* parseSse(body, { onActivity, signal } = {}) {
  const reader = body.getReader()
  const onAbort = () => {
    reader.cancel(signal?.reason).catch(() => {})
  }
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const decoder = new TextDecoder()
  let buffer = ''
  const takeFrames = function* (final) {
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1 || (final && buffer.trim().length > 0)) {
      const frame = boundary === -1 ? buffer : buffer.slice(0, boundary)
      buffer = boundary === -1 ? '' : buffer.slice(boundary + 2)
      const data = []
      let eventName
      for (const line of frame.split('\n')) {
        if (line.length === 0 || line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        let value = colon === -1 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'data') data.push(value)
        else if (field === 'event') eventName = value
      }
      const payload = data.join('\n')
      if (payload.length > 0 && payload !== '[DONE]') {
        let event
        try {
          event = JSON.parse(payload)
        } catch (cause) {
          throw new ChatGptPlusError('ChatGPT sent a malformed stream event.', 'MALFORMED_RESPONSE', { cause })
        }
        if (event && typeof event === 'object' && typeof event.type !== 'string' && eventName) event.type = eventName
        yield event
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (signal?.aborted) throw signal.reason ?? new Error('The stream was aborted.')
      if (done) {
        buffer += decoder.decode()
        buffer = buffer.replace(/\r\n?/g, '\n')
        yield* takeFrames(true)
        return
      }
      onActivity?.()
      buffer += decoder.decode(value, { stream: true })
      // Normalize CRLF/CR, keeping a trailing CR until its LF arrives in the next chunk.
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r(?!$)/g, '\n')
      yield* takeFrames(false)
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    try {
      reader.releaseLock()
    } catch {
      // The stream may already be errored or cancelled.
    }
  }
}

// ---------------------------------------------------------------------------
// Responses events → DSH StreamChunk
// ---------------------------------------------------------------------------

function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const number = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0)
  const input = number(usage.input_tokens)
  const output = number(usage.output_tokens)
  const cached = Math.min(input, number(usage.input_tokens_details?.cached_tokens))
  const reasoning = number(usage.output_tokens_details?.reasoning_tokens)
  // DSH counts are disjoint: uncached input, cached input and output are reported apart.
  const mapped = { inputTokens: input - cached, outputTokens: output }
  if (cached > 0) mapped.cacheReadTokens = cached
  if (reasoning > 0) mapped.reasoningTokens = reasoning
  const total = number(usage.total_tokens)
  if (total > 0 && total === input + output) mapped.totalTokens = total
  return mapped
}

function finalMessageText(item) {
  if (!Array.isArray(item?.content)) return undefined
  const parts = item.content.map((c) => (c?.type === 'output_text' ? c.text : c?.type === 'refusal' ? c.refusal : '')).filter((t) => typeof t === 'string')
  return parts.length > 0 ? parts.join('') : undefined
}

function finalReasoningText(item) {
  const summary = Array.isArray(item?.summary) ? item.summary.map((s) => s?.text).filter((t) => typeof t === 'string' && t.length > 0) : []
  if (summary.length > 0) return summary.join('\n\n')
  const content = Array.isArray(item?.content) ? item.content.map((c) => c?.text).filter((t) => typeof t === 'string' && t.length > 0) : []
  return content.length > 0 ? content.join('\n\n') : undefined
}

/**
 * Translate decoded Responses events into DSH stream chunks.
 * @param {AsyncIterable<object>} events
 * @param {{model: string, onRateLimits?: (snapshot: object) => void}} context
 */
export async function* translateResponsesStream(events, { model, onRateLimits } = {}) {
  const byKey = new Map()
  const order = []
  let responseId

  const keyOf = (event) => (Number.isInteger(event.output_index) ? `o${event.output_index}` : typeof event.item_id === 'string' ? `i${event.item_id}` : typeof event.item?.id === 'string' ? `i${event.item.id}` : 'o0')

  function* open(key, kind, item) {
    const state = { index: order.length, kind, text: '', args: '', id: undefined, name: undefined, closed: false, replay: { type: kind === 'text' ? 'message' : kind === 'tool-call' ? 'function_call' : 'reasoning' }, summaryParts: 0 }
    byKey.set(key, state)
    order.push(state)
    yield { type: 'block-start', index: state.index, blockType: kind }
    if (kind === 'tool-call') {
      state.id = typeof item?.call_id === 'string' && item.call_id ? item.call_id : (typeof item?.id === 'string' ? item.id : `call_${state.index}`)
      state.name = typeof item?.name === 'string' ? item.name : ''
      state.args = typeof item?.arguments === 'string' ? item.arguments : ''
      yield { type: 'tool-call-delta', index: state.index, id: state.id, name: state.name, argumentsDelta: state.args }
    }
    return state
  }

  function* ensure(event, kind) {
    const key = keyOf(event)
    const existing = byKey.get(key)
    if (existing && existing.kind === kind && !existing.closed) return existing
    return yield* open(key, kind, event.item)
  }

  function* appendText(state, delta) {
    if (typeof delta !== 'string' || delta.length === 0) return
    state.text += delta
    yield { type: state.kind === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: state.index, text: delta }
  }

  function* settleText(state, finalText) {
    if (typeof finalText === 'string' && finalText !== state.text) {
      if (finalText.startsWith(state.text)) yield* appendText(state, finalText.slice(state.text.length))
      else state.text = finalText
    }
  }

  function* close(state) {
    if (state.closed) return
    state.closed = true
    if (state.kind === 'tool-call') {
      yield { type: 'block-end', index: state.index, block: { type: 'tool-call', id: state.id, name: state.name, arguments: normalizeArguments(state.args) } }
    } else {
      yield { type: 'block-end', index: state.index, block: { type: state.kind, text: state.text } }
    }
  }

  for await (const event of events) {
    if (!event || typeof event !== 'object') continue
    switch (event.type) {
      case 'response.created':
      case 'response.in_progress':
        if (typeof event.response?.id === 'string') responseId = event.response.id
        break

      case 'response.output_item.added': {
        const item = event.item
        const kind = item?.type === 'reasoning' ? 'reasoning' : item?.type === 'message' ? 'text' : item?.type === 'function_call' ? 'tool-call' : undefined
        if (kind && !byKey.has(keyOf(event))) yield* open(keyOf(event), kind, item)
        break
      }

      case 'response.reasoning_summary_part.added': {
        const state = yield* ensure(event, 'reasoning')
        if (state.summaryParts > 0 && state.text.length > 0) yield* appendText(state, '\n\n')
        state.summaryParts += 1
        break
      }

      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        const state = yield* ensure(event, 'reasoning')
        yield* appendText(state, event.delta)
        break
      }

      case 'response.output_text.delta':
      case 'response.refusal.delta': {
        const state = yield* ensure(event, 'text')
        yield* appendText(state, event.delta)
        break
      }

      case 'response.function_call_arguments.delta': {
        const state = yield* ensure(event, 'tool-call')
        if (typeof event.delta === 'string' && event.delta.length > 0) {
          state.args += event.delta
          yield { type: 'tool-call-delta', index: state.index, id: state.id, argumentsDelta: event.delta }
        }
        break
      }

      case 'response.function_call_arguments.done': {
        const state = byKey.get(keyOf(event))
        if (state?.kind === 'tool-call' && typeof event.arguments === 'string' && event.arguments !== state.args) {
          if (event.arguments.startsWith(state.args)) {
            const delta = event.arguments.slice(state.args.length)
            state.args = event.arguments
            yield { type: 'tool-call-delta', index: state.index, id: state.id, argumentsDelta: delta }
          } else {
            state.args = event.arguments
          }
        }
        break
      }

      case 'response.output_item.done': {
        const item = event.item
        const kind = item?.type === 'reasoning' ? 'reasoning' : item?.type === 'message' ? 'text' : item?.type === 'function_call' ? 'tool-call' : undefined
        if (!kind) break
        let state = byKey.get(keyOf(event))
        if (!state || state.kind !== kind || state.closed) state = yield* open(`${keyOf(event)}#${order.length}`, kind, item)
        if (kind === 'reasoning') {
          yield* settleText(state, finalReasoningText(item))
          if (typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0) state.replay.encrypted_content = item.encrypted_content
          if (Array.isArray(item.summary)) state.replay.summary = item.summary.filter((s) => s?.type === 'summary_text' && typeof s.text === 'string').map((s) => ({ type: 'summary_text', text: s.text }))
        } else if (kind === 'text') {
          yield* settleText(state, finalMessageText(item))
          if (typeof item.phase === 'string') state.replay.phase = item.phase
        } else {
          if (typeof item.call_id === 'string' && item.call_id) state.id = item.call_id
          if (typeof item.name === 'string' && item.name) state.name = item.name
          if (typeof item.arguments === 'string' && item.arguments !== state.args) {
            if (item.arguments.startsWith(state.args)) {
              const delta = item.arguments.slice(state.args.length)
              state.args = item.arguments
              yield { type: 'tool-call-delta', index: state.index, id: state.id, argumentsDelta: delta }
            } else {
              state.args = item.arguments
            }
          }
        }
        if (typeof item.id === 'string') state.replay.item_id = item.id
        yield* close(state)
        break
      }

      case 'codex.rate_limits': {
        const snapshot = parseRateLimitEvent(event)
        if (snapshot) onRateLimits?.(snapshot)
        break
      }

      case 'response.failed':
        throw classifyStreamFailure(event.response?.error ?? { code: event.response?.status, message: event.response?.incomplete_details?.reason })

      case 'error':
        throw classifyStreamFailure(event.error && typeof event.error === 'object' ? event.error : event)

      case 'response.completed':
      case 'response.done':
      case 'response.incomplete': {
        const response = event.response && typeof event.response === 'object' ? event.response : {}
        const status = event.type === 'response.incomplete' ? 'incomplete' : response.status
        if (status === 'failed' || status === 'cancelled') throw classifyStreamFailure(response.error ?? { code: status, message: `The response ${status}.` })
        let reason
        if (status === 'incomplete') {
          const why = response.incomplete_details?.reason
          if (why !== 'max_output_tokens') {
            throw new ChatGptPlusError(`ChatGPT stopped the response early (${why || 'incomplete'}).`, why === 'content_filter' ? 'CONTENT_FILTER' : 'INCOMPLETE_RESPONSE')
          }
          reason = { kind: 'max-tokens' }
        }
        for (const state of order) yield* close(state)
        if (order.length === 0) throw new ChatGptPlusError('ChatGPT returned an empty response.', 'EMPTY_RESPONSE')
        reason ??= order.some((s) => s.kind === 'tool-call') ? { kind: 'tool-calls' } : { kind: 'stop' }
        const usage = mapUsage(response.usage)
        if (usage) yield { type: 'usage', usage }
        yield {
          type: 'finish',
          reason,
          replayState: {
            response: { id: responseId ?? response.id ?? null, model: typeof response.model === 'string' ? response.model : model },
            blocks: order.map((s) => s.replay),
          },
        }
        return
      }

      default:
        break
    }
  }
  throw new ChatGptPlusError('The ChatGPT stream ended before the response completed.', 'TRANSPORT')
}

// ---------------------------------------------------------------------------
// HTTP call
// ---------------------------------------------------------------------------

function abortedError() {
  return new ChatGptPlusError('The request was cancelled.', 'ABORTED')
}

/**
 * Stream one model call. Token problems surface as MISSING_CREDENTIAL/INVALID_CREDENTIAL; a 401 triggers
 * one forced refresh-and-retry before failing (when automatic refresh is enabled).
 */
export async function* streamResponses(options, deps) {
  const { auth, fetchImpl = globalThis.fetch, backendUrl = CHATGPT_BACKEND_URL, requestTimeoutMs = DEFAULTS.requestTimeoutMs, streamIdleTimeoutMs = DEFAULTS.streamIdleTimeoutMs, onRateLimits, onAuthRejected } = deps
  const outer = options.signal
  if (outer?.aborted) throw abortedError()

  const url = `${backendUrl.replace(/\/+$/, '')}${CODEX_RESPONSES_PATH}`
  const body = JSON.stringify(buildRequestBody(options))
  const abort = new AbortController()
  let abortReason = null
  const forwardAbort = () => abort.abort(outer?.reason)
  outer?.addEventListener('abort', forwardAbort, { once: true })
  let idleTimer
  const touch = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      abortReason = 'idle'
      abort.abort()
    }, streamIdleTimeoutMs)
    idleTimer.unref?.()
  }

  try {
    let credentials = await auth.getAccessToken({ signal: outer })
    let response
    for (let attempt = 0; ; attempt++) {
      const headers = {
        authorization: `Bearer ${credentials.accessToken}`,
        'chatgpt-account-id': credentials.accountId,
        'openai-beta': 'responses=experimental',
        originator: ORIGINATOR,
        'user-agent': USER_AGENT,
        accept: 'text/event-stream',
        'content-type': 'application/json',
      }
      if (typeof options.sessionId === 'string' && options.sessionId.length > 0) headers['session-id'] = options.sessionId.slice(0, 64)
      const headerTimer = setTimeout(() => {
        abortReason = 'headers'
        abort.abort()
      }, requestTimeoutMs)
      headerTimer.unref?.()
      try {
        response = await fetchImpl(url, { method: 'POST', headers, body, signal: abort.signal })
      } catch (error) {
        if (outer?.aborted) throw abortedError()
        if (abortReason === 'headers') throw new ChatGptPlusError(`ChatGPT did not respond within ${Math.round(requestTimeoutMs / 1000)}s.`, 'TIMEOUT', { cause: error })
        throw transportError(error, 'to send the request')
      } finally {
        clearTimeout(headerTimer)
      }
      const snapshot = parseRateLimitHeaders(response.headers)
      if (snapshot) onRateLimits?.(snapshot)
      if (response.status === 401 && attempt === 0 && auth.canRefreshAfterRejection()) {
        await response.body?.cancel().catch(() => {})
        credentials = await auth.getAccessToken({ signal: outer, forceRefresh: true })
        continue
      }
      break
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      if (response.status === 401) onAuthRejected?.()
      throw classifyHttpError(response.status, text, response.headers, { model: options.model })
    }
    if (!response.body) throw new ChatGptPlusError('ChatGPT returned an empty response body.', 'EMPTY_RESPONSE')

    touch()
    try {
      yield* translateResponsesStream(parseSse(response.body, { onActivity: touch, signal: abort.signal }), { model: options.model, onRateLimits })
    } catch (error) {
      if (outer?.aborted) throw abortedError()
      if (abortReason === 'idle') throw new ChatGptPlusError(`The ChatGPT stream stalled for ${Math.round(streamIdleTimeoutMs / 1000)}s.`, 'TIMEOUT', { cause: error })
      if (error instanceof ChatGptPlusError) throw error
      throw transportError(error, 'while streaming the response')
    }
  } finally {
    clearTimeout(idleTimer)
    outer?.removeEventListener('abort', forwardAbort)
    // Releases the connection when the consumer stops early or the stream failed.
    if (!abort.signal.aborted) abort.abort()
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function toModelInfo(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.name || model.id,
    ...(model.description ? { description: model.description } : {}),
    // Text-only: DSH replaces images with text placeholders before dispatch.
    inputModalities: ['text'],
  }
}

/**
 * Exact-model metadata for DSH: context window and selectable reasoning efforts. The default
 * effort is the user's preferred effort when this model supports it, else the model default.
 */
export function toResolvedModelInfo(provider, model, preferredEffort) {
  const info = toModelInfo(provider, model)
  if (Number.isInteger(model.contextWindow) && model.contextWindow > 0) info.context = { contextWindow: model.contextWindow }
  const efforts = Array.isArray(model.efforts) ? model.efforts.filter((e) => e && typeof e.id === 'string' && e.id.length > 0) : []
  if (efforts.length > 0) {
    const ids = new Set(efforts.map((e) => e.id))
    const defaultEffort = ids.has(preferredEffort) ? preferredEffort : ids.has(model.defaultEffort) ? model.defaultEffort : undefined
    info.reasoning = {
      efforts: efforts.map((e) => ({ id: e.id, name: e.name || e.id, ...(e.description ? { description: e.description } : {}) })),
      ...(defaultEffort ? { defaultEffort } : {}),
    }
  }
  return info
}

/**
 * @param {object} deps
 * @param {object} deps.controller - lib/controller.js instance (tokens, models, quota).
 */
export function createChatGptAdapter({ controller, fetchImpl, backendUrl, requestTimeoutMs, streamIdleTimeoutMs }) {
  const resolveModel = async (provider, model) => {
    const entry = controller.findModel(model)
    return toResolvedModelInfo(provider, entry, controller.preferredEffort())
  }
  const stream = (options) => streamResponses(options, {
    auth: controller,
    fetchImpl,
    backendUrl,
    requestTimeoutMs,
    streamIdleTimeoutMs,
    onRateLimits: (snapshot) => controller.noteRateLimits(snapshot),
    onAuthRejected: () => controller.noteAuthRejected(),
  })
  return {
    providerInfo(provider) {
      return { id: provider, name: PROVIDER_NAME }
    },
    providerRetryPolicy() {
      return undefined
    },
    imageRequestPricing() {
      return undefined
    },
    imageRequestTarget(_provider, _model, image) {
      return { width: image.width, height: image.height, maxBytes: image.bytes }
    },
    async listModels(provider) {
      if (!controller.isSignedIn()) return []
      controller.refreshModelsInBackground()
      return controller.visibleModels().map((model) => toModelInfo(provider, model))
    },
    resolveModel,
    async prepareCall(provider, model, signal) {
      signal?.throwIfAborted?.()
      return { model: await resolveModel(provider, model), stream }
    },
    stream,
  }
}
