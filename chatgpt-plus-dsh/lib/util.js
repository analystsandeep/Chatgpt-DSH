// Small dependency-free helpers shared by the host modules.
//
// The plugin deliberately imports nothing from @deepseek-ai/* at runtime: a `link:` install
// resolves bare imports from the plugin's real directory, where DSH's packages are not
// installed, and a second copy would break identity checks. Everything DSH provides is
// reached through ctx services instead.
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Encode bytes as unpadded base64url (RFC 4648 §5). */
export function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

/** Short, non-reversible identifier for a secret, safe for in-memory bookkeeping and logs. */
export function fingerprint(secret) {
  return createHash('sha256').update(String(secret)).digest('hex').slice(0, 16)
}

/**
 * Decode the payload of a JWT without verifying it. Claims are only used for display
 * (email, plan) and routing (account id); the token itself is validated by OpenAI.
 */
export function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3 || parts[1].length === 0) return null
  try {
    const value = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/** `jane.doe@example.com` → `ja•••@example.com`; never returns the full local part. */
export function maskEmail(email) {
  if (typeof email !== 'string' || email.length === 0) return null
  const at = email.lastIndexOf('@')
  if (at <= 0 || at === email.length - 1) return `${email.slice(0, 1)}•••`
  const local = email.slice(0, at)
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2)
  return `${visible}•••@${email.slice(at + 1)}`
}

const PLAN_LABELS = {
  free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', promax: 'Pro Max',
  team: 'Business', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', education: 'Edu',
  free_workspace: 'Free workspace', self_serve_business_prolite: 'Business',
}

/** Human label for a ChatGPT plan id (`plus` → `Plus`); unknown ids are title-cased. */
export function planLabel(planType) {
  if (typeof planType !== 'string' || planType.length === 0) return null
  const key = planType.toLowerCase()
  if (PLAN_LABELS[key]) return PLAN_LABELS[key]
  return key.split(/[_\s-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

export function truncate(text, max) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value
}

/**
 * Resolve the DeepSeek Harness home exactly like @deepseek-ai/dsh-home-paths:
 * a non-blank $DSH_HOME (with `~` expansion) wins, otherwise `~/.dsh`.
 * `path.join`/`path.resolve` produce native separators on Windows.
 */
export function resolveDshHome(env = process.env) {
  const raw = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (raw.length === 0) return join(homedir(), '.dsh')
  if (raw === '~') return homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homedir(), raw.slice(2))
  return resolve(raw)
}

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * Write a file atomically (temp file + rename) with owner-only POSIX mode. On Windows a
 * rename can fail briefly while antivirus or the indexer holds the target, so it is retried.
 */
export async function writeFileAtomic(file, text, { mode = 0o600 } = {}) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temp, text, { mode })
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temp, file)
      return
    } catch (error) {
      if (attempt >= 5 || !RETRYABLE_RENAME_CODES.has(error?.code)) {
        await rm(temp, { force: true }).catch(() => {})
        throw error
      }
      await new Promise((r) => setTimeout(r, 40 * (attempt + 1)))
    }
  }
}

/** Read a JSON file; a missing or corrupt file reads as `undefined`. */
export async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return undefined
    throw error
  }
}

function execFileText(execFileImpl, command, args, timeout) {
  return new Promise((resolveText, reject) => {
    execFileImpl(command, args, { windowsHide: true, timeout, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error)
      else resolveText(String(stdout ?? ''))
    })
  })
}

/**
 * Make a directory owner-only on Windows, where POSIX modes (0700/0600) have no effect.
 * Inheritance from the parent is removed and full control is granted only to the current
 * user's SID (plus LocalSystem, which backup and antivirus services need). Runs `whoami` and
 * `icacls` directly via execFile: no shell is involved, so the path needs no quoting.
 * Best effort: the result is reported, never thrown.
 */
export async function restrictToCurrentUser(target, { platform = process.platform, execFileImpl = execFile } = {}) {
  if (platform !== 'win32') return { applied: false, reason: 'not-windows' }
  try {
    const whoami = await execFileText(execFileImpl, 'whoami', ['/user', '/fo', 'csv', '/nh'], 10_000)
    const sid = /"(S-1-[0-9-]+)"/.exec(whoami)?.[1]
    if (!sid) return { applied: false, reason: 'current user SID not found' }
    await execFileText(execFileImpl, 'icacls', [
      target, '/inheritance:r',
      '/grant:r', `*${sid}:(OI)(CI)F`,
      '/grant:r', '*S-1-5-18:(OI)(CI)F',
      '/q',
    ], 15_000)
    return { applied: true, sid }
  } catch (error) {
    return { applied: false, reason: String(error?.message ?? error) }
  }
}

/** Promise with externally callable resolve/reject. */
export function createDeferred() {
  let resolveFn
  let rejectFn
  const promise = new Promise((res, rej) => {
    resolveFn = res
    rejectFn = rej
  })
  promise.catch(() => {})
  return { promise, resolve: resolveFn, reject: rejectFn }
}

/** Human duration such as `2h 15m` or `45s`. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return ''
  const total = Math.max(0, Math.round(ms / 1000))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  if (minutes > 0) return `${minutes}m`
  return `${total}s`
}
