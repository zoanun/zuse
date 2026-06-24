import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { VERSION } from '@zuse/core'
import type { AuthProvider } from '../auth/authProvider.js'
import { parseCookies, serializeCookie } from './cookies.js'
import { SESSION_COOKIE } from '../config.js'
import { DEV_PAGE_HTML } from './devPage.js'

export interface RequestHandlerDeps {
  auth: AuthProvider
  devPage: boolean
  tokenTtlSec: number
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function makeRequestHandler(deps: RequestHandlerDeps): RequestListener {
  // Per-handler closure so each handler instance starts with a clean backoff
  // counter (avoids cross-test accumulation / single-user simplicity).
  let consecutiveFailures = 0

  const isAuthed = (req: IncomingMessage): boolean => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? ''
    if (!token) return false
    return deps.auth.verifyToken(token)
  }

  return (req, res) => {
    void handle(req, res)
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'
    const path = url.pathname

    // GET /healthz
    if (method === 'GET' && path === '/healthz') {
      return sendJson(res, 200, { status: 'ok', version: VERSION })
    }

    // GET /api/auth/status
    if (method === 'GET' && path === '/api/auth/status') {
      return sendJson(res, 200, {
        configured: await deps.auth.isConfigured(),
        authenticated: isAuthed(req),
      })
    }

    // POST /api/auth/setup
    if (method === 'POST' && path === '/api/auth/setup') {
      if (await deps.auth.isConfigured()) {
        return sendJson(res, 409, { error: { code: 'already_configured', message: 'Password already configured' } })
      }
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Invalid JSON body' } })
      }
      const password = (body as { password?: unknown })?.password
      if (typeof password !== 'string') {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Missing password' } })
      }
      try {
        await deps.auth.setup(password)
      } catch {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Invalid password' } })
      }
      return sendJson(res, 200, { ok: true })
    }

    // POST /api/auth/login
    if (method === 'POST' && path === '/api/auth/login') {
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Invalid JSON body' } })
      }
      const password = (body as { password?: unknown })?.password
      if (typeof password !== 'string') {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Missing password' } })
      }
      // Backoff: delay computed before increment, so first attempt has 0ms.
      await delay(Math.min(consecutiveFailures * 200, 2000))
      if (await deps.auth.verifyCredential(password)) {
        consecutiveFailures = 0
        res.setHeader(
          'Set-Cookie',
          serializeCookie(SESSION_COOKIE, deps.auth.issueToken(), {
            httpOnly: true,
            sameSite: 'Lax',
            maxAgeSec: deps.tokenTtlSec,
            secure: false,
            path: '/',
          }),
        )
        return sendJson(res, 200, { ok: true })
      }
      consecutiveFailures++
      return sendJson(res, 401, { error: { code: 'invalid_credentials', message: 'Invalid credentials' } })
    }

    // POST /api/auth/logout
    if (method === 'POST' && path === '/api/auth/logout') {
      if (!isAuthed(req)) {
        return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      }
      res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAgeSec: 0, path: '/' }))
      return sendJson(res, 200, { ok: true })
    }

    // GET / — inline dev test page (throwaway; real SPA wired in F4)
    if (method === 'GET' && path === '/') {
      if (deps.devPage) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return void res.end(DEV_PAGE_HTML)
      }
      return sendJson(res, 404, { error: { code: 'not_found', message: 'Not found' } })
    }

    // Fallback
    return sendJson(res, 404, { error: { code: 'not_found', message: 'Not found' } })
  }
}
