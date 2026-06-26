import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, normalize, extname } from 'node:path'
import { VERSION } from '@zuse/core'
import type { AuthProvider } from '../auth/authProvider.js'
import { parseCookies, serializeCookie } from './cookies.js'
import { SESSION_COOKIE } from '../config.js'
import { DEV_PAGE_HTML } from './devPage.js'
import type { SessionService } from '../session/SessionService.js'
import type { MemoryService } from '../memory/MemoryService.js'
import type { PersonaService } from '../persona/PersonaService.js'
import { MEMORY_TYPES, cwdSlug, type MemoryType } from '@zuse/tools'
import type { ProjectInfo } from '@zuse/protocol'

export interface RequestHandlerDeps {
  auth: AuthProvider
  service: SessionService
  memory: MemoryService
  persona: PersonaService
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

/**
 * Run a session-id-scoped mutation: success → 200 {ok:true}; any throw → 400.
 * The handler runs as `void handle()`, so a safeId rejection (malformed id) must
 * be caught here or it becomes an unhandled rejection that hangs the client.
 */
async function runIdScoped(res: ServerResponse, op: () => Promise<unknown>): Promise<void> {
  try {
    await op()
    sendJson(res, 200, { ok: true })
  } catch {
    sendJson(res, 400, { error: { code: 'bad_request', message: 'invalid session id' } })
  }
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
      return runIdScoped(res, () => deps.service.delete(id))
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
      return runIdScoped(res, () => deps.service.rename(id, title))
    }

    // -----------------------------------------------------------------------
    // /api/memory — Memory CRUD (M1), all auth-gated.
    // -----------------------------------------------------------------------

    // GET /api/memory — list / search (auth-gated). query ?project=&q=&limit=
    if (method === 'GET' && path === '/api/memory') {
      if (!isAuthed(req)) {
        return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      }
      const project = url.searchParams.has('project') ? url.searchParams.get('project') ?? '' : undefined
      const q = url.searchParams.get('q') ?? undefined
      const limitRaw = url.searchParams.get('limit')
      const limit = limitRaw != null && /^\d+$/.test(limitRaw) ? Number(limitRaw) : undefined
      return sendJson(res, 200, deps.memory.list({ project, q, limit }))
    }

    // POST /api/memory — create (auth-gated). body {type, content, project?, hook?}
    if (method === 'POST' && path === '/api/memory') {
      if (!isAuthed(req)) {
        return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      }
      let body: { type?: unknown; content?: unknown; project?: unknown; hook?: unknown } | undefined
      try {
        body = (await readJsonBody(req)) as typeof body
      } catch {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Invalid JSON body' } })
      }
      const type = body?.type
      const content = body?.content
      // type 必须是四类之一;content 非空。
      if (typeof type !== 'string' || !MEMORY_TYPES.includes(type as MemoryType)) {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Invalid memory type' } })
      }
      if (typeof content !== 'string' || content.trim() === '') {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Missing or empty content' } })
      }
      const project = typeof body?.project === 'string' ? body.project : undefined
      const hook = typeof body?.hook === 'string' ? body.hook : undefined
      return sendJson(res, 200, deps.memory.create({ type: type as MemoryType, content, project, hook }))
    }

    // PATCH /api/memory/<id> — update (auth-gated). non-numeric id → 400; unknown id → 404.
    if (method === 'PATCH' && path.startsWith('/api/memory/')) {
      if (!isAuthed(req)) {
        return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      }
      const idStr = path.slice('/api/memory/'.length)
      if (!/^\d+$/.test(idStr)) {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Invalid memory id' } })
      }
      const id = Number(idStr)
      let body: { type?: unknown; content?: unknown; hook?: unknown; project?: unknown } | undefined
      try {
        body = (await readJsonBody(req)) as typeof body
      } catch {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Invalid JSON body' } })
      }
      // Only forward fields of the right shape; type (if given) must be valid.
      const fields: { type?: MemoryType; content?: string; hook?: string; project?: string } = {}
      if (body?.type !== undefined) {
        if (typeof body.type !== 'string' || !MEMORY_TYPES.includes(body.type as MemoryType)) {
          return sendJson(res, 400, { error: { code: 'bad_request', message: 'Invalid memory type' } })
        }
        fields.type = body.type as MemoryType
      }
      if (typeof body?.content === 'string') fields.content = body.content
      if (typeof body?.hook === 'string') fields.hook = body.hook
      if (typeof body?.project === 'string') fields.project = body.project
      const updated = deps.memory.update(id, fields)
      if (!updated) {
        return sendJson(res, 404, { error: { code: 'not_found', message: 'Memory not found' } })
      }
      return sendJson(res, 200, updated)
    }

    // DELETE /api/memory/<id> — remove (auth-gated). non-numeric id → 400.
    if (method === 'DELETE' && path.startsWith('/api/memory/')) {
      if (!isAuthed(req)) {
        return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      }
      const idStr = path.slice('/api/memory/'.length)
      if (!/^\d+$/.test(idStr)) {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Invalid memory id' } })
      }
      // Unmatched id is not an error (idempotent delete) — return ok:false, still 200.
      const ok = deps.memory.remove(Number(idStr))
      return sendJson(res, 200, { ok })
    }

    // GET /api/projects — known {slug, cwd} pairs, so the memory project picker can
    // show real directory names instead of the opaque cwd-slug. Derived from session cwds.
    if (method === 'GET' && path === '/api/projects') {
      if (!isAuthed(req)) {
        return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      }
      const bySlug = new Map<string, string>()
      for (const m of await deps.service.list()) bySlug.set(cwdSlug(m.cwd), m.cwd)
      const projects: ProjectInfo[] = [...bySlug].map(([slug, cwd]) => ({ slug, cwd }))
      return sendJson(res, 200, projects)
    }

    // -----------------------------------------------------------------------
    // /api/personas — Persona CRUD + activation (M2), all auth-gated.
    // -----------------------------------------------------------------------

    // GET /api/personas — { personas, activeId }
    if (method === 'GET' && path === '/api/personas') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      return sendJson(res, 200, await deps.persona.list())
    }

    // POST /api/personas/activate — body {id: string|null}. Must precede the <id> patterns.
    if (method === 'POST' && path === '/api/personas/activate') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      let body: { id?: unknown } | undefined
      try { body = (await readJsonBody(req)) as typeof body } catch {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Invalid JSON body' } })
      }
      const id = body?.id
      if (id !== null && typeof id !== 'string') {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'id must be a string or null' } })
      }
      const ok = await deps.persona.activate(id)
      if (!ok) return sendJson(res, 404, { error: { code: 'not_found', message: 'Persona not found' } })
      return sendJson(res, 200, { ok })
    }

    // POST /api/personas — create. body {name, content}
    if (method === 'POST' && path === '/api/personas') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      let body: { name?: unknown; content?: unknown } | undefined
      try { body = (await readJsonBody(req)) as typeof body } catch {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Invalid JSON body' } })
      }
      if (typeof body?.name !== 'string' || body.name.trim() === '') {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Missing or empty name' } })
      }
      if (typeof body?.content !== 'string' || body.content.trim() === '') {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Missing or empty content' } })
      }
      return sendJson(res, 200, await deps.persona.create({ name: body.name, content: body.content }))
    }

    // PATCH /api/personas/<id> — update {name?, content?}; unknown id → 404.
    if (method === 'PATCH' && path.startsWith('/api/personas/')) {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      const id = decodeURIComponent(path.slice('/api/personas/'.length))
      let body: { name?: unknown; content?: unknown } | undefined
      try { body = (await readJsonBody(req)) as typeof body } catch {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Invalid JSON body' } })
      }
      const fields: { name?: string; content?: string } = {}
      if (typeof body?.name === 'string') fields.name = body.name
      if (typeof body?.content === 'string') fields.content = body.content
      const updated = await deps.persona.update(id, fields)
      if (!updated) return sendJson(res, 404, { error: { code: 'not_found', message: 'Persona not found' } })
      return sendJson(res, 200, updated)
    }

    // DELETE /api/personas/<id> — remove (idempotent → ok:false if missing, still 200).
    if (method === 'DELETE' && path.startsWith('/api/personas/')) {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      const id = decodeURIComponent(path.slice('/api/personas/'.length))
      return sendJson(res, 200, { ok: await deps.persona.remove(id) })
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
