// Same-origin JSON endpoints for the settings page, mounted on DSH's web server under
// /_dsh/chatgpt-plus-dsh. Every request must pass DSH's own connection check
// (ctx.connection.requestRejection: Host/Origin fence + the signed browser-session cookie),
// so only the authenticated DSH GUI can reach them. State-changing endpoints are POST-only
// and require `content-type: application/json`, which a cross-site form cannot send without
// a CORS preflight that this handler never approves. Responses never contain tokens.
import { RPC_PREFIX } from './constants.js'
import { UserFacingError } from './controller.js'

const MAX_BODY_BYTES = 64 * 1024

function sendJson(res, status, payload) {
  if (res.headersSent) {
    res.end()
    return
  }
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      reject(new UserFacingError('PAYLOAD_TOO_LARGE', 'Request body is too large.', 413))
      return
    }
    const chunks = []
    let size = 0
    let failed = false
    req.on('data', (chunk) => {
      if (failed) return
      size += chunk.length
      if (size > limit) {
        failed = true
        reject(new UserFacingError('PAYLOAD_TOO_LARGE', 'Request body is too large.', 413))
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (failed) return
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text.length === 0) {
        resolve({})
        return
      }
      try {
        const value = JSON.parse(text)
        resolve(value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})
      } catch {
        reject(new UserFacingError('BAD_JSON', 'Request body is not valid JSON.', 400))
      }
    })
    req.on('error', (error) => {
      if (!failed) reject(error)
    })
  })
}

function isJsonRequest(req) {
  return /^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))
}

function publicError(error) {
  if (error instanceof UserFacingError) return { status: error.status, body: { code: error.code, message: error.message } }
  const code = typeof error?.code === 'string' ? error.code : 'INTERNAL'
  return { status: 500, body: { code, message: String(error?.message ?? 'Unexpected error') } }
}

/**
 * @param {object} deps
 * @param {import('./controller.js').ChatGptPlusController} deps.controller
 * @param {(req: import('node:http').IncomingMessage) => (401|403|undefined)} deps.requestRejection
 */
export function createRpcHandler({ controller, requestRejection, logger, prefix = RPC_PREFIX }) {
  const post = {
    '/signin': (body) => controller.beginSignIn({ openBrowser: body.openBrowser !== false, restart: body.restart === true }).then(() => controller.getStatus()),
    '/signin/complete': (body) => {
      if (typeof body.input !== 'string' || body.input.trim().length === 0 || body.input.length > 8192) {
        throw new UserFacingError('BAD_REQUEST', 'Paste the full address from the browser.')
      }
      return controller.completeSignIn(body.input)
    },
    '/signin/cancel': () => controller.cancelSignIn(),
    '/signout': () => controller.signOut(),
    '/refresh': () => controller.refreshNow(),
    '/models/refresh': () => controller.refreshModels({ force: true }).then(() => controller.getStatus()),
    '/usage/refresh': () => controller.getUsage({ force: true }).then(() => controller.getStatus()),
    '/preferences': (body) => controller.updatePreferences({
      ...(typeof body.autoRefresh === 'boolean' ? { autoRefresh: body.autoRefresh } : {}),
      ...(body.defaultEffort === null || typeof body.defaultEffort === 'string' ? { defaultEffort: body.defaultEffort } : {}),
      ...(body.modelVisibility && typeof body.modelVisibility === 'object' && !Array.isArray(body.modelVisibility) ? { modelVisibility: body.modelVisibility } : {}),
    }),
    '/default-model': (body) => controller.setDefaultModel({ model: body.model, reasoningEffort: body.reasoningEffort }),
  }

  return async function handleRequest(req, res) {
    let rejection
    try {
      rejection = requestRejection(req)
    } catch (error) {
      logger?.warn?.('connection check failed: %s', error?.message ?? error)
      rejection = 403
    }
    if (rejection) {
      sendJson(res, rejection, { ok: false, error: { code: rejection === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', message: 'This endpoint is only available to the signed-in DSH interface.' } })
      return
    }
    let pathname
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'Malformed URL.' } })
      return
    }
    const route = pathname.startsWith(prefix) ? (pathname.slice(prefix.length) || '/').replace(/\/+$/, '') || '/' : pathname
    const method = (req.method ?? 'GET').toUpperCase()
    try {
      if (route === '/status' || route === '/') {
        if (method !== 'GET' && method !== 'HEAD') throw new UserFacingError('METHOD_NOT_ALLOWED', 'Use GET.', 405)
        sendJson(res, 200, { ok: true, data: await controller.getStatus() })
        return
      }
      if (route === '/usage') {
        if (method !== 'GET') throw new UserFacingError('METHOD_NOT_ALLOWED', 'Use GET.', 405)
        await controller.getUsage({})
        sendJson(res, 200, { ok: true, data: await controller.getStatus() })
        return
      }
      const action = Object.hasOwn(post, route) ? post[route] : undefined
      if (!action) throw new UserFacingError('NOT_FOUND', 'Unknown endpoint.', 404)
      if (method !== 'POST') throw new UserFacingError('METHOD_NOT_ALLOWED', 'Use POST.', 405)
      if (!isJsonRequest(req)) throw new UserFacingError('UNSUPPORTED_MEDIA_TYPE', 'Send application/json.', 415)
      const body = await readJsonBody(req)
      sendJson(res, 200, { ok: true, data: await action(body) })
    } catch (error) {
      const { status, body } = publicError(error)
      if (status >= 500) logger?.warn?.('%s %s failed: %s', method, route, body.message)
      sendJson(res, status, { ok: false, error: body })
    }
  }
}
