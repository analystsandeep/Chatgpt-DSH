// Identity and protocol constants for chatgpt-plus-dsh.
//
// Every identifier owned by this plugin (provider route, credential record, HTTP prefix,
// data directory) is deliberately different from the ones used by dsh-chatgpt-sub
// (route `openai-codex`, credential ref OPENAI_CODEX_API_KEY, prefix /_dsh/dsh-chatgpt-sub,
// ~/.codex/auth.json). Both plugins can therefore live in one profile: this plugin never
// reads or writes the other plugin's state, and it keeps its own OAuth grant (its own
// refresh-token family), so neither plugin can invalidate the other's tokens by rotating them.
import { readFileSync } from 'node:fs'

function readPackageVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const PACKAGE_NAME = 'chatgpt-plus-dsh'
export const PACKAGE_VERSION = readPackageVersion()

// Cordis plugin name. It is also the scope of the credential record, because DSH's
// credential seam expects the scope to name the plugin that owns the record format.
export const PLUGIN_NAME = 'chatgpt-plus'

// LLM provider route shown in the DSH model picker.
export const PROVIDER_ID = 'chatgpt-plus'
export const PROVIDER_NAME = 'ChatGPT Plus'

// Credential record `<scope>/<id>` in DSH's credential store ($DSH_HOME/.credentials.yaml).
// Segments must match /^[a-z][a-z0-9-]*$/ (dsh-credentials KEY_SEGMENT_PATTERN).
export const CREDENTIAL_SCOPE = PLUGIN_NAME
export const CREDENTIAL_ID = 'account'
export const CREDENTIAL_KEY = `${CREDENTIAL_SCOPE}/${CREDENTIAL_ID}`

// Same-origin HTTP endpoints used by the settings page (mounted on DSH's web server).
export const RPC_PREFIX = '/_dsh/chatgpt-plus-dsh'

// Non-secret plugin data (preferences, model list cache) under $DSH_HOME.
export const DATA_DIR_NAME = 'chatgpt-plus-dsh'

// OpenAI OAuth client of the official Codex CLI. This client is registered with exactly one
// redirect URI, http://localhost:1455/auth/callback, which is why the redirect cannot point
// at DSH's own web server (port 3080): a short-lived listener is bound on 127.0.0.1:1455 for
// the duration of one sign-in, with a paste-the-URL fallback when that port is busy.
export const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const OAUTH_ISSUER = 'https://auth.openai.com'
export const OAUTH_AUTHORIZE_URL = `${OAUTH_ISSUER}/oauth/authorize`
export const OAUTH_TOKEN_URL = `${OAUTH_ISSUER}/oauth/token`
export const OAUTH_SCOPE = 'openid profile email offline_access'
export const OAUTH_CALLBACK_HOST = '127.0.0.1'
export const OAUTH_CALLBACK_PORT = 1455
export const OAUTH_CALLBACK_PATH = '/auth/callback'
export const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`

// JWT claim namespaces carried by ChatGPT-issued id/access tokens.
export const JWT_AUTH_CLAIM = 'https://api.openai.com/auth'
export const JWT_PROFILE_CLAIM = 'https://api.openai.com/profile'

// ChatGPT backend used by Codex with ChatGPT sign-in (subscription quota, not API billing).
export const CHATGPT_BACKEND_URL = 'https://chatgpt.com/backend-api'
export const CODEX_RESPONSES_PATH = '/codex/responses'
export const CODEX_MODELS_PATH = '/codex/models'
export const CODEX_USAGE_PATH = '/wham/usage'

// The models endpoint filters by client version; this is the Codex CLI release the request
// shape above was checked against. Overridable through the row config `clientVersion`.
export const CODEX_CLIENT_VERSION = '0.162.1'

// Request attribution. `originator` identifies this client to the ChatGPT backend and the
// OAuth server (third-party clients use their own value, e.g. `pi`, `opencode`).
export const ORIGINATOR = 'chatgpt_plus_dsh'
export const USER_AGENT = `${PACKAGE_NAME}/${PACKAGE_VERSION} (+https://github.com/deepseek-ai/deepseek-harness)`

// Timing defaults (milliseconds).
export const DEFAULTS = Object.freeze({
  signInTimeoutMs: 5 * 60_000,
  tokenRequestTimeoutMs: 15_000,
  requestTimeoutMs: 120_000,
  streamIdleTimeoutMs: 300_000,
  metadataTimeoutMs: 15_000,
  // Background refresh fires this long before the access token expires.
  backgroundRefreshMarginMs: 15 * 60_000,
  // A model request refreshes first when the token has less than this left.
  requestRefreshMarginMs: 2 * 60_000,
  // Used only when neither `expires_in` nor the JWT `exp` claim is available.
  fallbackTokenLifetimeMs: 60 * 60_000,
  modelsMaxAgeMs: 6 * 60 * 60_000,
  usageMaxAgeMs: 60_000,
})

export const DEFAULT_INSTRUCTIONS = 'You are a helpful assistant.'
