import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, normalize, extname } from 'node:path'
import { VERSION } from '@zuse/core'
import type { AuthProvider } from '../auth/authProvider.js'
import { parseCookies, serializeCookie } from './cookies.js'
import { SESSION_COOKIE } from '../config.js'
import { DEV_PAGE_HTML } from './devPage.js'
import type { SessionService } from '../session/SessionService.js'

export interface RequestHandlerDeps {
  auth: AuthProvider
  service: SessionService
  devPage: boolean
  tokenTtlSec: number
  webDir?: string
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8',
}

async function tryServeFile(res: ServerResponse, abs: string): Promise<boolean> {
  try {
    const s = await stat(abs)
    if (!s.isFile()) return false
    const buf = await readFile(abs)
    res.writeHead(200, { 'content-type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream' })
    res.end(buf)
    return true
  } catch { return false }
}

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

    // GET /api/sessions — list (auth-gated)
    if (method === 'GET' && path === '/api/sessions') {
      if (!isAuthed(req)) {
        return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      }
      return sendJson(res, 200, await deps.service.list())
    }

    // POST /api/sessions — create (auth-gated)
    if (method === 'POST' && path === '/api/sessions') {
      if (!isAuthed(req)) {
        return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      }
      let body: { cwd?: string; title?: string } | undefined
      try {
        body = (await readJsonBody(req)) as { cwd?: string; title?: string }
      } catch {
        body = undefined // tolerate empty / non-JSON body
      }
      const { id } = await deps.service.create({ cwd: body?.cwd, title: body?.title })
      return sendJson(res, 200, { id })
    }

    // DELETE /api/sessions/<id> — delete (auth-gated)
    if (method === 'DELETE' && path.startsWith('/api/sessions/')) {
      if (!isAuthed(req)) {
        return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      }
      const id = decodeURIComponent(path.slice('/api/sessions/'.length))
      if (!id) {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Missing session id' } })
      }
      // safeId (inside service.delete) throws synchronously on a malformed id.
      // Catch it here so a bad id is a clean 400 rather than an unhandled
      // rejection (the handler is invoked as `void handle()` — a throw would
      // hang the client).
      try {
        await deps.service.delete(id)
      } catch {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'invalid session id' } })
      }
      return sendJson(res, 200, { ok: true })
    }

    // PATCH /api/sessions/<id> — rename title (auth-gated)
    if (method === 'PATCH' && path.startsWith('/api/sessions/')) {
      if (!isAuthed(req)) {
        return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      }
      const id = decodeURIComponent(path.slice('/api/sessions/'.length))
      if (!id) {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Missing session id' } })
      }
      let body: { title?: unknown } | undefined
      try {
        body = (await readJsonBody(req)) as { title?: unknown }
      } catch {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Invalid JSON body' } })
      }
      const title = body?.title
      // Reject missing/non-string/empty titles (no empty/blank titles allowed).
      if (typeof title !== 'string' || title.trim() === '') {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Missing or empty title' } })
      }
      // safeId (inside service.rename) throws synchronously on a malformed id —
      // catch → 400 rather than hang (see DELETE above).
      try {
        await deps.service.rename(id, title)
      } catch {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'invalid session id' } })
      }
      return sendJson(res, 200, { ok: true })
    }

    // Static SPA (F4): serve webDir (built web/dist) + SPA fallback. Falls back to the dev page.
    if (method === 'GET') {
      if (deps.webDir) {
        // Resolve within webDir; reject traversal.
        const rel = normalize(path).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '')
        const abs = join(deps.webDir, rel)
        if (abs.startsWith(deps.webDir)) {
          if (path !== '/' && (await tryServeFile(res, abs))) return
          if (await tryServeFile(res, join(deps.webDir, 'index.html'))) return
        }
      }
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
