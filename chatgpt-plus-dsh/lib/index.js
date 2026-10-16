// chatgpt-plus-dsh — host half of the DeepSeek Harness plugin.
//
// What it does:
//   * registers the `chatgpt-plus` provider route with DSH's `llm` service, so the account's
//     ChatGPT models appear in the model picker and run on the ChatGPT subscription quota;
//   * signs in with OpenAI OAuth (Authorization Code + PKCE S256, Codex CLI client) and keeps
//     the grant in DSH's credential store, refreshing it before it expires;
//   * serves the JSON endpoints behind the settings page (lib/client.js).
//
// Lifetime: every timer, listener, route and registration is created through ctx.effect()
// (or ctx.on / ctx.inject, which are effects too), so DSH unloading or hot-reloading the
// plugin releases all of them. Nothing from @deepseek-ai/* is imported at runtime; DSH
// features are reached only through ctx services.
//
// Compatibility: package.json deliberately declares no peerDependencies. The plugin never
// imports @deepseek-ai/dsh-llm (it uses the `llm` service), so there is no package range to
// satisfy, and pnpm prints a warning for every peer of a `link:`-installed package. DSH's
// compatibility gate only evaluates @deepseek-ai/dsh* peers, so with none declared it accepts
// 0.2.0-rc.2, 0.2.1-alpha.x and later builds; the APIs actually used are feature-checked below
// (assertHostSupport) so an incompatible host fails with a clear message instead.
import { CREDENTIAL_KEY, PLUGIN_NAME, PROVIDER_ID, RPC_PREFIX } from './constants.js'
import { createController } from './controller.js'
import { createChatGptAdapter } from './provider.js'
import { createRpcHandler } from './rpc.js'

export const name = PLUGIN_NAME

// Required services: the LLM adapter registry and the credential store. The web server and
// connection services are optional (absent outside web profiles) and injected below.
export const inject = ['llm', 'credentials']

const noop = () => {}

function createLogger(ctx) {
  try {
    const base = ctx.logger
    const named = typeof base === 'function' ? base(PLUGIN_NAME) : base
    if (named && typeof named.warn === 'function') {
      const call = (level) => (...args) => {
        try {
          (named[level] ?? named.info ?? noop).apply(named, args)
        } catch {
          // Logging must never break the plugin.
        }
      }
      return { debug: call('debug'), info: call('info'), warn: call('warn'), error: call('error') }
    }
  } catch {
    // ctx.logger is optional for this plugin.
  }
  return { debug: noop, info: noop, warn: noop, error: noop }
}

function optionalService(ctx, service) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(service) : undefined
  } catch {
    return undefined
  }
}

/**
 * Fail fast, with an actionable message, on a host that lacks the APIs this plugin uses
 * (llm.registerAdapter and credential records exist since DSH 0.2.0-rc.2).
 */
export function assertHostSupport(ctx) {
  const missing = []
  if (typeof ctx.llm?.registerAdapter !== 'function') missing.push('llm.registerAdapter')
  for (const method of ['readRecord', 'modifyRecord', 'deleteRecord']) {
    if (typeof ctx.credentials?.[method] !== 'function') missing.push(`credentials.${method}`)
  }
  if (missing.length > 0) {
    throw new Error(`${PLUGIN_NAME}: this DeepSeek Harness build lacks ${missing.join(', ')}; update DSH to 0.2.0-rc.2 or newer.`)
  }
}

export function apply(ctx, config) {
  assertHostSupport(ctx)
  const logger = createLogger(ctx)
  const controller = createController({
    credentials: ctx.credentials,
    getDefaultModelService: () => optionalService(ctx, 'agentDefaultModel'),
    logger,
    config,
  })

  // Token lifecycle: loads the saved grant, arms the background refresh timer; the disposer
  // clears timers and closes any pending OAuth redirect listener.
  ctx.effect(() => controller.start(), `${PLUGIN_NAME}: token lifecycle`)

  // Provider route. `replace()` with the same route re-announces `llm/adapters-updated`, which
  // makes the model picker re-read the list after sign-in, sign-out or a visibility change.
  const adapter = createChatGptAdapter({
    controller,
    requestTimeoutMs: controller.config.requestTimeoutMs,
    streamIdleTimeoutMs: controller.config.streamIdleTimeoutMs,
  })
  ctx.effect(() => {
    const registration = ctx.llm.registerAdapter([PROVIDER_ID], adapter)
    const stopWatching = controller.onModelsChanged(() => {
      try {
        registration.replace?.([PROVIDER_ID])
      } catch (error) {
        logger.debug('model list announcement skipped: %s', error?.message ?? error)
      }
    })
    return () => {
      stopWatching()
      registration()
    }
  }, `${PLUGIN_NAME}: llm route ${PROVIDER_ID}`)

  // Another DSH process (or the settings page of another window) changed the grant.
  ctx.on('credentials/record-updated', (key) => {
    if (String(key) === CREDENTIAL_KEY) controller.reloadRecord().catch(noop)
  })

  // Settings endpoints for the web GUI.
  ctx.inject(['webServer', 'connection'], (web) => {
    const handler = createRpcHandler({
      controller,
      requestRejection: (req) => web.connection.requestRejection(req),
      logger,
    })
    web.effect(() => web.webServer.register({ kind: 'prefix', path: RPC_PREFIX, handler }), `${PLUGIN_NAME}: settings endpoints`)
  })
}

export default { name, inject, apply }
