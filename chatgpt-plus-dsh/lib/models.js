// Model catalog, account model discovery and usage (quota) information.
//
// The authoritative list is the account's own: GET {backend}/codex/models?client_version=…
// returns `{models: [{slug, display_name, description, default_reasoning_level,
// supported_reasoning_levels: [{effort, description}], visibility, priority,
// context_window, input_modalities, ...}]}` (codex-rs ModelsResponse). The static catalog
// below is used only until that call succeeds, and mirrors the openai-codex catalog bundled
// with DSH 0.2.1-alpha.3 (@earendil-works/pi-ai 1.2.0).
import {
  CHATGPT_BACKEND_URL, CODEX_CLIENT_VERSION, CODEX_MODELS_PATH, CODEX_USAGE_PATH, DEFAULTS, ORIGINATOR, USER_AGENT,
} from './constants.js'
import { classifyHttpError, transportError } from './errors.js'
import { planLabel } from './util.js'

const EFFORT_LABELS = {
  none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High',
  xhigh: 'Extra high', max: 'Max', ultra: 'Ultra', persistent: 'Persistent',
}

/** `xhigh` → `Extra high`; unknown efforts are title-cased. */
export function effortLabel(id) {
  if (EFFORT_LABELS[id]) return EFFORT_LABELS[id]
  const text = String(id).replace(/[_-]+/g, ' ').trim()
  return text ? text[0].toUpperCase() + text.slice(1) : String(id)
}

function efforts(...ids) {
  return ids.map((id) => ({ id, name: effortLabel(id) }))
}

const STANDARD = ['low', 'medium', 'high', 'xhigh']
const EXTENDED = ['low', 'medium', 'high', 'xhigh', 'max']
const FULL = ['none', 'low', 'medium', 'high', 'xhigh', 'max']

/** Fallback catalog; the account endpoint replaces it as soon as it answers. */
export const FALLBACK_MODELS = Object.freeze([
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', efforts: efforts(...EXTENDED), defaultEffort: 'medium', contextWindow: 272_000 },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', efforts: efforts(...EXTENDED), defaultEffort: 'medium', contextWindow: 272_000 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', efforts: efforts(...EXTENDED), defaultEffort: 'medium', contextWindow: 272_000 },
  { id: 'gpt-5.5', name: 'GPT-5.5', efforts: efforts(...STANDARD), defaultEffort: 'medium', contextWindow: 272_000 },
  { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', efforts: efforts(...STANDARD), defaultEffort: 'medium', contextWindow: 128_000 },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', efforts: efforts(...FULL), defaultEffort: 'medium', contextWindow: 272_000 },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: efforts(...FULL), defaultEffort: 'medium', contextWindow: 272_000 },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', efforts: efforts(...EXTENDED), defaultEffort: 'medium', contextWindow: 272_000 },
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: efforts(...EXTENDED), defaultEffort: 'medium', contextWindow: 272_000 },
].map((model, priority) => Object.freeze({ ...model, description: undefined, visibility: 'list', priority })))

/** Metadata for a model id the catalog does not know (DSH core routing accepts any id). */
export function genericModel(id) {
  return { id, name: id, efforts: efforts('low', 'medium', 'high'), defaultEffort: 'medium', contextWindow: undefined, visibility: 'list', priority: 1000 }
}

function cleanEfforts(levels) {
  const seen = new Set()
  const out = []
  for (const level of Array.isArray(levels) ? levels : []) {
    const id = typeof level === 'string' ? level : level?.effort
    if (typeof id !== 'string' || id.length === 0 || id.length > 40 || seen.has(id)) continue
    seen.add(id)
    const description = typeof level?.description === 'string' && level.description.trim() ? level.description.trim() : undefined
    out.push({ id, name: effortLabel(id), ...(description ? { description } : {}) })
  }
  return out
}

/**
 * Normalize the models endpoint response. Entries without a slug or with visibility `none`
 * are dropped; duplicates keep their first occurrence; order follows `priority` (ascending,
 * as Codex sorts its picker), then the endpoint's own order.
 * @returns {Array<{id, name, description?, efforts, defaultEffort?, contextWindow?, visibility, priority}>}
 */
export function parseModelsResponse(json) {
  const list = Array.isArray(json?.models) ? json.models : Array.isArray(json?.data) ? json.data : []
  const seen = new Set()
  const out = []
  list.forEach((entry, position) => {
    if (!entry || typeof entry !== 'object') return
    const id = [entry.slug, entry.id, entry.model].find((v) => typeof v === 'string' && v.trim().length > 0)?.trim()
    if (!id || seen.has(id)) return
    const visibility = typeof entry.visibility === 'string' ? entry.visibility.toLowerCase() : 'list'
    if (visibility === 'none') return
    seen.add(id)
    const levels = cleanEfforts(entry.supported_reasoning_levels ?? entry.reasoning_levels)
    const requestedDefault = typeof entry.default_reasoning_level === 'string' ? entry.default_reasoning_level : undefined
    const defaultEffort = levels.some((l) => l.id === requestedDefault) ? requestedDefault
      : levels.some((l) => l.id === 'medium') ? 'medium' : levels[0]?.id
    const contextWindow = [entry.context_window, entry.max_context_window].find((v) => Number.isInteger(v) && v > 0)
    const name = [entry.display_name, entry.name].find((v) => typeof v === 'string' && v.trim().length > 0)?.trim() ?? id
    const description = typeof entry.description === 'string' && entry.description.trim() ? entry.description.trim() : undefined
    out.push({
      id,
      name,
      ...(description ? { description } : {}),
      efforts: levels,
      ...(defaultEffort ? { defaultEffort } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      visibility: visibility === 'hide' ? 'hide' : 'list',
      priority: Number.isFinite(entry.priority) ? entry.priority : 500 + position,
      _order: position,
    })
  })
  out.sort((a, b) => (a.priority - b.priority) || (a._order - b._order))
  return out.map(({ _order, ...model }) => model)
}

/** Check a cached model entry read back from disk. */
export function isModelEntry(value) {
  return value !== null && typeof value === 'object' && typeof value.id === 'string' && value.id.length > 0
    && typeof value.name === 'string' && Array.isArray(value.efforts)
}

function authHeaders({ accessToken, accountId }) {
  return {
    authorization: `Bearer ${accessToken}`,
    'chatgpt-account-id': accountId,
    originator: ORIGINATOR,
    'user-agent': USER_AGENT,
    accept: 'application/json',
  }
}

async function getJson(url, auth, { fetchImpl = globalThis.fetch, signal, timeoutMs = DEFAULTS.metadataTimeoutMs, what }) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response
  try {
    response = await fetchImpl(url, { method: 'GET', headers: authHeaders(auth), signal: combined })
  } catch (error) {
    if (timeout.aborted && !signal?.aborted) {
      const timedOut = new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s loading ${what}.`)
      timedOut.code = 'TIMEOUT'
      throw timedOut
    }
    throw transportError(error, `to load ${what}`)
  }
  const text = await response.text().catch(() => '')
  if (!response.ok) throw classifyHttpError(response.status, text, response.headers)
  try {
    return { json: JSON.parse(text), headers: response.headers }
  } catch {
    const malformed = new Error(`ChatGPT returned malformed JSON for ${what}.`)
    malformed.code = 'MALFORMED_RESPONSE'
    throw malformed
  }
}

/** Fetch the models this ChatGPT account may use. */
export async function fetchAccountModels(auth, { backendUrl = CHATGPT_BACKEND_URL, clientVersion = CODEX_CLIENT_VERSION, ...options } = {}) {
  const url = new URL(`${backendUrl.replace(/\/+$/, '')}${CODEX_MODELS_PATH}`)
  url.searchParams.set('client_version', clientVersion)
  const { json } = await getJson(url.toString(), auth, { ...options, what: 'the ChatGPT model list' })
  return parseModelsResponse(json)
}

function parseWindow(window) {
  if (!window || typeof window !== 'object') return null
  const usedPercent = Number(window.used_percent)
  if (!Number.isFinite(usedPercent)) return null
  const seconds = Number(window.limit_window_seconds)
  const windowMinutes = Number.isFinite(Number(window.window_minutes)) ? Number(window.window_minutes)
    : Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds / 60) : null
  const resetAt = Number(window.reset_at)
  const resetAfter = Number(window.reset_after_seconds)
  return {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    windowMinutes,
    resetsAt: Number.isFinite(resetAt) && resetAt > 0 ? resetAt * 1000 : null,
    resetsAfterSeconds: Number.isFinite(resetAfter) && resetAfter >= 0 ? resetAfter : null,
  }
}

/**
 * Normalize GET {backend}/wham/usage (codex-rs RateLimitStatusPayload): plan, the primary
 * (short, e.g. 5-hour) and secondary (weekly) windows, and credits.
 */
export function parseUsageResponse(json, now = Date.now()) {
  if (!json || typeof json !== 'object') return null
  const rateLimit = json.rate_limit && typeof json.rate_limit === 'object' ? json.rate_limit : {}
  const credits = json.credits && typeof json.credits === 'object' ? json.credits : null
  const fix = (window) => {
    if (window && window.resetsAt === null && window.resetsAfterSeconds !== null) window.resetsAt = now + window.resetsAfterSeconds * 1000
    return window
  }
  return {
    planType: typeof json.plan_type === 'string' ? json.plan_type : null,
    plan: planLabel(json.plan_type),
    allowed: typeof rateLimit.allowed === 'boolean' ? rateLimit.allowed : null,
    limitReached: typeof rateLimit.limit_reached === 'boolean' ? rateLimit.limit_reached : null,
    primary: fix(parseWindow(rateLimit.primary_window)),
    secondary: fix(parseWindow(rateLimit.secondary_window)),
    credits: credits ? {
      hasCredits: credits.has_credits === true,
      unlimited: credits.unlimited === true,
      balance: typeof credits.balance === 'string' ? credits.balance : null,
    } : null,
    source: 'usage-endpoint',
  }
}

export async function fetchUsage(auth, { backendUrl = CHATGPT_BACKEND_URL, now = Date.now(), ...options } = {}) {
  const { json } = await getJson(`${backendUrl.replace(/\/+$/, '')}${CODEX_USAGE_PATH}`, auth, { ...options, what: 'ChatGPT usage limits' })
  return parseUsageResponse(json, now)
}

function headerNumber(headers, name) {
  const raw = typeof headers?.get === 'function' ? headers.get(name) : undefined
  if (raw === null || raw === undefined || raw === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/**
 * Passive quota information from model responses: x-codex-{primary,secondary}-
 * {used-percent,window-minutes,reset-at} (codex-rs parse_rate_limit_for_limit).
 * @returns partial usage snapshot, or null when the headers are absent.
 */
export function parseRateLimitHeaders(headers) {
  const window = (kind) => {
    const usedPercent = headerNumber(headers, `x-codex-${kind}-used-percent`)
    if (usedPercent === undefined) return null
    const windowMinutes = headerNumber(headers, `x-codex-${kind}-window-minutes`)
    const resetAt = headerNumber(headers, `x-codex-${kind}-reset-at`)
    return {
      usedPercent: Math.max(0, Math.min(100, usedPercent)),
      windowMinutes: windowMinutes ?? null,
      resetsAt: resetAt ? resetAt * 1000 : null,
      resetsAfterSeconds: null,
    }
  }
  const primary = window('primary')
  const secondary = window('secondary')
  if (!primary && !secondary) return null
  return { primary, secondary, source: 'response-headers' }
}

/** Same information from a `codex.rate_limits` stream event. */
export function parseRateLimitEvent(event) {
  const limits = event?.rate_limits
  if (!limits || typeof limits !== 'object') return null
  const window = (w) => {
    if (!w || !Number.isFinite(Number(w.used_percent))) return null
    return {
      usedPercent: Math.max(0, Math.min(100, Number(w.used_percent))),
      windowMinutes: Number.isFinite(Number(w.window_minutes)) ? Number(w.window_minutes) : null,
      resetsAt: Number(w.reset_at) > 0 ? Number(w.reset_at) * 1000 : null,
      resetsAfterSeconds: null,
    }
  }
  const primary = window(limits.primary)
  const secondary = window(limits.secondary)
  if (!primary && !secondary) return null
  return { primary, secondary, ...(typeof event.plan_type === 'string' ? { planType: event.plan_type, plan: planLabel(event.plan_type) } : {}), source: 'stream-event' }
}
