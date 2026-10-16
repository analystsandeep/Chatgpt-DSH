// Persistence.
//
// Secrets: the OAuth grant (access, refresh and id tokens) lives ONLY in DSH's credential
// store, as a `grant` record under the key `chatgpt-plus/account` (ctx.credentials,
// provided by @deepseek-ai/dsh-credentials-local, file $DSH_HOME/.credentials.yaml).
// That store writes atomically with mode 0600 under a cross-process file lock, and its
// `modifyRecord` is a serialized read-modify-write, which is what makes refresh-token
// rotation safe when two DSH processes share one home. This plugin never reads or writes
// that file directly.
//
// Non-secrets: preferences and the account's model list are kept in
// $DSH_HOME/chatgpt-plus-dsh/. The directory is created 0700 / files 0600 and, on Windows,
// is restricted to the current user with an explicit ACL (see restrictToCurrentUser).
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { CREDENTIAL_KEY } from './constants.js'
import { isGrantPayload } from './oauth.js'
import { readJsonFile, restrictToCurrentUser, writeFileAtomic } from './util.js'

export class CredentialStoreUnavailableError extends Error {
  constructor() {
    super('The DSH credential store does not support records in this DSH version. Update DeepSeek Harness to 0.2.0-rc.2 or newer.')
    this.name = 'CredentialStoreUnavailableError'
    this.code = 'CREDENTIAL_STORE_UNAVAILABLE'
  }
}

/** The OAuth grant, stored through DSH's credential seam. */
export class TokenStore {
  /** @param {object} credentials - ctx.credentials (CredentialProvider). */
  constructor(credentials, key = CREDENTIAL_KEY) {
    this.credentials = credentials
    this.key = key
  }

  get available() {
    const c = this.credentials
    return !!c && typeof c.readRecord === 'function' && typeof c.modifyRecord === 'function' && typeof c.deleteRecord === 'function'
  }

  assertAvailable() {
    if (!this.available) throw new CredentialStoreUnavailableError()
  }

  /**
   * @returns {Promise<{payload?: object, invalid?: boolean}>} `invalid` when a record exists
   *   but is not a grant this plugin can use (e.g. written by an incompatible version).
   */
  async read() {
    this.assertAvailable()
    const record = await this.credentials.readRecord(this.key)
    if (record === undefined || record === null) return {}
    if (record.kind === 'grant' && isGrantPayload(record.payload)) return { payload: record.payload }
    return { invalid: true }
  }

  /** Replace the grant (sign-in). */
  async write(payload) {
    this.assertAvailable()
    const record = await this.credentials.modifyRecord(this.key, async () => ({ kind: 'grant', payload }))
    return record?.kind === 'grant' ? record.payload : payload
  }

  /**
   * Serialized read-modify-write of the grant (token refresh). `mutate` receives the current
   * valid payload (or undefined) and returns the replacement, or undefined to keep it.
   * @returns {Promise<object|undefined>} the payload stored after the operation.
   */
  async update(mutate) {
    this.assertAvailable()
    const record = await this.credentials.modifyRecord(this.key, async (current) => {
      const payload = current?.kind === 'grant' && isGrantPayload(current.payload) ? current.payload : undefined
      const next = await mutate(payload)
      return next === undefined ? undefined : { kind: 'grant', payload: next }
    })
    return record?.kind === 'grant' && isGrantPayload(record.payload) ? record.payload : undefined
  }

  async remove() {
    this.assertAvailable()
    await this.credentials.deleteRecord(this.key)
  }
}

export const DEFAULT_PREFERENCES = Object.freeze({
  autoRefresh: true,
  // modelId → true (show in picker) / false (hide). Absent: the account's own visibility.
  modelVisibility: Object.freeze({}),
  // Preferred reasoning effort when a request does not name one; null = model default.
  defaultEffort: null,
  // DSH default model in effect before this plugin made a ChatGPT model the default,
  // restored on sign-out.
  previousDefault: null,
})

function isSelection(value) {
  return value !== null && typeof value === 'object' && typeof value.provider === 'string' && value.provider.length > 0
    && typeof value.model === 'string' && value.model.length > 0
    && (value.reasoningEffort === undefined || typeof value.reasoningEffort === 'string')
}

export function normalizePreferences(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const visibility = {}
  if (source.modelVisibility && typeof source.modelVisibility === 'object') {
    for (const [id, visible] of Object.entries(source.modelVisibility)) {
      if (typeof id === 'string' && id.length > 0 && id.length <= 200 && typeof visible === 'boolean') visibility[id] = visible
    }
  }
  return {
    autoRefresh: typeof source.autoRefresh === 'boolean' ? source.autoRefresh : DEFAULT_PREFERENCES.autoRefresh,
    modelVisibility: visibility,
    defaultEffort: typeof source.defaultEffort === 'string' && source.defaultEffort.length > 0 && source.defaultEffort.length <= 40 ? source.defaultEffort : null,
    previousDefault: isSelection(source.previousDefault)
      ? { provider: source.previousDefault.provider, model: source.previousDefault.model, ...(source.previousDefault.reasoningEffort ? { reasoningEffort: source.previousDefault.reasoningEffort } : {}) }
      : null,
  }
}

/** Non-secret plugin files under $DSH_HOME/chatgpt-plus-dsh. */
export class DataStore {
  constructor(dir, { platform = process.platform, restrict = restrictToCurrentUser } = {}) {
    this.dir = dir
    this.platform = platform
    this.restrict = restrict
    this.preferencesFile = join(dir, 'preferences.json')
    this.modelsFile = join(dir, 'models.json')
    this.prepared = null
  }

  /** Create the directory once and lock it down to the current user. */
  prepare() {
    if (!this.prepared) {
      this.prepared = (async () => {
        await mkdir(this.dir, { recursive: true, mode: 0o700 })
        return this.restrict(this.dir, { platform: this.platform })
      })().catch((error) => ({ applied: false, reason: String(error?.message ?? error) }))
    }
    return this.prepared
  }

  async loadPreferences() {
    return normalizePreferences(await readJsonFile(this.preferencesFile))
  }

  async savePreferences(preferences) {
    await this.prepare()
    await writeFileAtomic(this.preferencesFile, `${JSON.stringify({ v: 1, ...normalizePreferences(preferences) }, null, 2)}\n`)
  }

  async loadModels() {
    const raw = await readJsonFile(this.modelsFile)
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.models) || typeof raw.accountId !== 'string') return undefined
    return { accountId: raw.accountId, fetchedAt: Number(raw.fetchedAt) || 0, models: raw.models }
  }

  async saveModels({ accountId, fetchedAt, models }) {
    await this.prepare()
    await writeFileAtomic(this.modelsFile, `${JSON.stringify({ v: 1, accountId, fetchedAt, models }, null, 2)}\n`)
  }
}
