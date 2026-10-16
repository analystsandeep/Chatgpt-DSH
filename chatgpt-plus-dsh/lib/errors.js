// Error taxonomy for model calls.
//
// DSH's LlmRuntime turns anything an adapter throws into a terminal `finish` chunk. It keeps
// the structured failure (code, HTTP status, retry delay) when the thrown Error carries an
// own data property `failure` whose `code` equals an own data property `code`
// (normalizeLlmFailure in @deepseek-ai/dsh-llm). ChatGptPlusError satisfies that contract
// without importing LlmError, so codes reach dsh-llm-retry and the UI intact:
//   retried by default:  RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, EMPTY_RESPONSE
//   not retried:         QUOTA, INVALID_CREDENTIAL, MISSING_CREDENTIAL, INVALID_REQUEST, UNKNOWN_MODEL, ...
//
// Sign-in problems use INVALID_CREDENTIAL (dsh-llm: a credential that was supplied but cannot
// be used; the fix is to replace it, i.e. sign in again) rather than AUTH: DSH's chat view
// renders AUTH as the fixed text "API key is invalid", which would hide the sign-in guidance,
// while it shows the adapter's own message for INVALID_CREDENTIAL and MISSING_CREDENTIAL.
import { formatDuration, planLabel, truncate } from './util.js'

export const SIGN_IN_HINT = 'Open DSH → Plugins → ChatGPT Plus and click “Sign in with ChatGPT”.'

export class ChatGptPlusError extends Error {
  /**
   * @param {string} message - human-readable, actionable description (never contains secrets).
   * @param {string} code - stable machine code from the DSH LLM taxonomy.
   * @param {{status?: number, retryAfterMs?: number, requestId?: string, cause?: unknown}} [options]
   */
  constructor(message, code, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ChatGptPlusError'
    this.code = code
    const failure = { message, code }
    if (Number.isInteger(options.status) && options.status >= 100 && options.status <= 599) {
      this.status = options.status
      failure.status = options.status
    }
    if (Number.isFinite(options.retryAfterMs) && options.retryAfterMs > 0) {
      this.retryAfterMs = Math.round(options.retryAfterMs)
      failure.providerRetryAfterMs = this.retryAfterMs
    }
    if (typeof options.requestId === 'string' && options.requestId.length > 0) {
      this.requestId = options.requestId
      failure.requestId = options.requestId
    }
    this.failure = Object.freeze(failure)
  }
}

export function isChatGptPlusError(value) {
  return value instanceof ChatGptPlusError
}

function headerOf(headers, name) {
  try {
    if (headers && typeof headers.get === 'function') return headers.get(name) ?? undefined
    if (headers && typeof headers === 'object') {
      const value = headers[name] ?? headers[name.toLowerCase()]
      return Array.isArray(value) ? value[0] : value
    }
  } catch {
    // Header access must never mask the primary failure.
  }
  return undefined
}

/** Provider-requested delay from `retry-after-ms` or `retry-after` (seconds or HTTP date). */
export function parseRetryAfter(headers, now = Date.now()) {
  const ms = Number(headerOf(headers, 'retry-after-ms'))
  if (Number.isFinite(ms) && ms > 0) return ms
  const raw = headerOf(headers, 'retry-after')
  if (raw === undefined || raw === null || raw === '') return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : undefined
  const date = Date.parse(String(raw))
  return Number.isFinite(date) && date > now ? date - now : undefined
}

function requestIdOf(headers) {
  return headerOf(headers, 'x-request-id') ?? headerOf(headers, 'openai-request-id') ?? headerOf(headers, 'cf-ray')
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Pull `{code, message, ...}` out of the shapes the ChatGPT backend uses. */
export function extractApiError(body) {
  const json = typeof body === 'string' ? parseJson(body) : body
  if (!json || typeof json !== 'object') return { code: '', message: '', raw: {} }
  const candidate = json.error && typeof json.error === 'object' ? json.error
    : json.detail && typeof json.detail === 'object' ? json.detail
      : json
  const code = [candidate.code, candidate.type, json.code].find((v) => typeof v === 'string' && v.length > 0) ?? ''
  const message = [candidate.message, typeof json.detail === 'string' ? json.detail : undefined, json.message, typeof json.error === 'string' ? json.error : undefined]
    .find((v) => typeof v === 'string' && v.length > 0) ?? ''
  return { code, message, raw: candidate }
}

const CONTEXT_PATTERN = /context[_\s-]?length[_\s-]?exceeded|context[_\s-]window|maximum context length|too many tokens|input is too long|prompt is too long/i
const QUOTA_PATTERN = /usage[_\s-]?limit[_\s-]?reached|insufficient[_\s-]?quota|quota[_\s-]?exceeded|usage limit|out of credits|credits? (?:depleted|exhausted)/i
const MODEL_PATTERN = /model[^.]{0,80}\b(?:not (?:supported|found|available)|does not exist|unsupported)|unsupported model|model_not_found/i

/** "Resets in about 2h 15m." from `resets_at` (epoch seconds) or `resets_in_seconds`. */
export function describeReset(raw, now = Date.now()) {
  const resetsAt = Number(raw?.resets_at)
  const resetsIn = Number(raw?.resets_in_seconds)
  let ms
  if (Number.isFinite(resetsAt) && resetsAt > 0) ms = resetsAt * 1000 - now
  else if (Number.isFinite(resetsIn) && resetsIn > 0) ms = resetsIn * 1000
  if (!Number.isFinite(ms) || ms <= 0) return { hint: '', ms: undefined }
  return { hint: `The limit resets in about ${formatDuration(ms)}.`, ms }
}

/**
 * Map a failed HTTP response from the Codex responses endpoint to a typed error.
 * @param {number} status
 * @param {string} text - response body (may be JSON, HTML or empty).
 * @param {Headers|object} headers
 * @param {{model?: string, now?: number}} [context]
 */
export function classifyHttpError(status, text, headers, context = {}) {
  const now = context.now ?? Date.now()
  const { code: apiCode, message: apiMessage, raw } = extractApiError(text)
  const requestId = requestIdOf(headers)
  const retryAfterMs = parseRetryAfter(headers, now)
  const detail = `${apiCode} ${apiMessage}`
  const plan = planLabel(raw?.plan_type)
  const base = { status, requestId }
  const quoted = apiMessage ? `: ${truncate(apiMessage, 300)}` : ''

  if (/usage_not_included/i.test(apiCode)) {
    return new ChatGptPlusError(
      `Your ChatGPT plan${plan ? ` (${plan})` : ''} does not include Codex model access. A ChatGPT Plus, Pro, Business, Edu or Enterprise subscription is required.`,
      'QUOTA', base)
  }
  if (status === 402 || QUOTA_PATTERN.test(detail)) {
    const reset = describeReset(raw, now)
    return new ChatGptPlusError(
      `You have reached your ChatGPT${plan ? ` ${plan}` : ''} usage limit for ChatGPT models in DSH. ${reset.hint || 'Try again later.'}`.trim(),
      'QUOTA', { ...base, retryAfterMs: reset.ms ?? retryAfterMs })
  }
  if (status === 429) {
    const wait = retryAfterMs ? ` Retry in about ${formatDuration(retryAfterMs)}.` : ''
    return new ChatGptPlusError(`ChatGPT is rate limiting requests (HTTP 429).${wait}${quoted ? ` Details${quoted}` : ''}`, 'RATE_LIMIT', { ...base, retryAfterMs })
  }
  if (status === 401) {
    return new ChatGptPlusError(`ChatGPT rejected the access token (HTTP 401). ${SIGN_IN_HINT}`, 'INVALID_CREDENTIAL', base)
  }
  if (status === 403) {
    // Reported under DSH's HTTP_<status> convention so the chat shows the actual reason.
    const blocked = /<html|cloudflare|cf-ray|attention required/i.test(text ?? '') && !apiMessage
    return new ChatGptPlusError(blocked
      ? 'ChatGPT blocked the request (HTTP 403, network or Cloudflare challenge). Check your network/VPN and try again.'
      : `ChatGPT refused access (HTTP 403)${quoted}. Make sure this ChatGPT account has a Plus or Pro subscription.`, 'HTTP_403', base)
  }
  if (CONTEXT_PATTERN.test(detail) || status === 413) {
    return new ChatGptPlusError(`The conversation is too long for this model's context window${quoted}`, 'CONTEXT_WINDOW_EXCEEDED', base)
  }
  if (status === 404 || MODEL_PATTERN.test(detail)) {
    return new ChatGptPlusError(`The model "${context.model ?? 'unknown'}" is not available for this ChatGPT account (HTTP ${status})${quoted}`, 'UNKNOWN_MODEL', base)
  }
  if (status === 400 || status === 422) {
    return new ChatGptPlusError(`ChatGPT rejected the request (HTTP ${status})${quoted}`, 'INVALID_REQUEST', base)
  }
  if (status === 408) {
    return new ChatGptPlusError('ChatGPT timed out waiting for the request (HTTP 408).', 'TIMEOUT', base)
  }
  if (status >= 500) {
    return new ChatGptPlusError(`ChatGPT service error (HTTP ${status})${quoted}`, 'SERVER', { ...base, retryAfterMs })
  }
  return new ChatGptPlusError(`ChatGPT request failed (HTTP ${status})${quoted}`, `HTTP_${status}`, base)
}

/** Map an in-stream failure (`response.failed` or an `error` event) to a typed error. */
export function classifyStreamFailure(error, now = Date.now()) {
  const { code, message, raw } = extractApiError(error && typeof error === 'object' ? { error } : {})
  const detail = `${code} ${message}`
  const quoted = message ? `: ${truncate(message, 300)}` : ''
  if (CONTEXT_PATTERN.test(detail)) return new ChatGptPlusError(`The conversation is too long for this model's context window${quoted}`, 'CONTEXT_WINDOW_EXCEEDED')
  if (/usage_not_included/i.test(code)) return new ChatGptPlusError('Your ChatGPT plan does not include Codex model access.', 'QUOTA')
  if (QUOTA_PATTERN.test(detail)) {
    const reset = describeReset(raw, now)
    return new ChatGptPlusError(`You have reached your ChatGPT usage limit for ChatGPT models in DSH. ${reset.hint || 'Try again later.'}`.trim(), 'QUOTA', { retryAfterMs: reset.ms })
  }
  if (/rate[_\s-]?limit/i.test(detail)) return new ChatGptPlusError(`ChatGPT is rate limiting requests${quoted}`, 'RATE_LIMIT')
  if (/content[_\s-]?filter|safety|policy/i.test(detail)) return new ChatGptPlusError(`ChatGPT stopped the response for policy reasons${quoted}`, 'CONTENT_FILTER')
  if (/invalid[_\s-]?(?:prompt|request)|bad[_\s-]?request/i.test(detail)) return new ChatGptPlusError(`ChatGPT rejected the request${quoted}`, 'INVALID_REQUEST')
  if (MODEL_PATTERN.test(detail)) return new ChatGptPlusError(`The requested model is not available for this ChatGPT account${quoted}`, 'UNKNOWN_MODEL')
  return new ChatGptPlusError(`ChatGPT reported an error while streaming${quoted || ` (${code || 'unknown error'})`}`, 'SERVER')
}

/** Transport-level failure (DNS, TLS, reset) before or during streaming. */
export function transportError(error, phase) {
  const reason = error?.cause?.code ?? error?.code ?? error?.cause?.message ?? error?.message ?? String(error)
  return new ChatGptPlusError(`Could not reach ChatGPT ${phase} (${truncate(reason, 200)}). Check your internet connection.`, 'TRANSPORT', { cause: error })
}
