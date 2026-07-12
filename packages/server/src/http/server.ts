import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join, normalize, extname, basename } from 'node:path'
import { VERSION, loadSettings, DEFAULT_PROVIDER_ID, listSelectableModels, resolveModelSelection, resolveVision, isNonChatModel } from '@zuse/core'
import type { AuthProvider } from '../auth/authProvider.js'
import { parseCookies, serializeCookie } from './cookies.js'
import { SESSION_COOKIE } from '../config.js'
import { DEV_PAGE_HTML } from './devPage.js'
import type { SessionService } from '../session/SessionService.js'
import type { MemoryService } from '../memory/MemoryService.js'
import type { SearchService } from '../search/SearchService.js'
import type { PersonaService } from '../persona/PersonaService.js'
import type { SkillService } from '../skill/SkillService.js'
import type { UsageService } from '../usage/UsageService.js'
import { FileService, PathOutsideRootError, FileChangedError, FileExistsError } from '../file/FileService.js'
import { listDirsAt } from '../file/dirNav.js'
import type { McpService } from '../mcp/McpService.js'
import type { UploadService } from '../upload/UploadService.js'
import { UnsupportedMediaError, TooLargeError, InvalidUploadIdError, UploadNotFoundError, MAX_UPLOAD_BYTES, FileTooLargeError, FILE_MAX_BYTES } from '../upload/UploadService.js'
import { MEMORY_TYPES, cwdSlug, type MemoryType } from '@zuse/tools'
import type { ProjectInfo } from '@zuse/protocol'

export interface RequestHandlerDeps {
  auth: AuthProvider
  service: SessionService
  memory: MemoryService
  search: SearchService
  persona: PersonaService
  skill: SkillService
  usage: UsageService
  file: FileService
  mcp: McpService
  upload: UploadService
  /** Persist the default model spec (bare name for flat-default, else `providerId/model`) to
   *  project settings. Injected so tests can assert the computed spec without touching disk. */
  persistModel: (spec: string) => void
  devPage: boolean
  tokenTtlSec: number
  webDir?: string
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Max bytes the raw endpoint will stream inline (50 MiB); larger → 413, client offers download. */
const RAW_CAP = 50 * 1024 * 1024

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
 * Stream a file to the response with its content-type/length. pipe() does NOT
 * forward source errors; without this listener a mid-stream failure (file
 * deleted/locked after stat) emits an unhandled 'error' and crashes the whole
 * daemon — so on error we just tear the (already-headed) response down.
 */
function streamFileTo(res: ServerResponse, abs: string, contentType: string, size: number, extraHeaders?: Record<string, string>): void {
  res.writeHead(200, { 'content-type': contentType, 'content-length': String(size), ...extraHeaders })
  const stream = createReadStream(abs)
  stream.on('error', () => { res.destroy() }) // headers already sent — just tear the response down
  stream.pipe(res)
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

/** Thrown by readJsonBody when the accumulated request body exceeds a supplied cap. → 413. */
export class PayloadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`)
    this.name = 'PayloadTooLargeError'
  }
}

/**
 * Read + JSON.parse a request body. With `maxBytes` given, the body is rejected the moment the
 * running total exceeds the cap — the request is destroyed and a PayloadTooLargeError is thrown
 * BEFORE the whole thing is buffered/parsed, so a hostile multi-hundred-MB body can't OOM us.
 * Without `maxBytes` (default), behaviour is unchanged: read all, then parse.
 */
export async function readJsonBody(req: IncomingMessage, maxBytes?: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (maxBytes !== undefined && total > maxBytes) {
      // Stop reading immediately (don't buffer the rest) and let the caller map this to 413.
      // We deliberately do NOT req.destroy() here: destroying the socket races the 413 write and
      // the client sees ECONNRESET instead of the status. Throwing unwinds the for-await so we
      // stop accumulating (no OOM); the caller's res.end() then closes the still-uploading conn.
      throw new PayloadTooLargeError(maxBytes)
    }
    chunks.push(buf)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Early byte cap for POST /api/uploads bodies: the base64 payload inflates ~4/3 over the raw image,
 * plus ~1 MiB of slack for the JSON field names/quotes. Keyed off MAX_UPLOAD_BYTES so it tracks the
 * 25 MiB image ceiling. Bodies past this are rejected mid-stream (413) rather than fully buffered.
 */
const UPLOAD_BODY_CAP = Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 1024 * 1024

/** Body cap for POST /api/uploads/file: base64 inflates ~4/3 over the raw file, + 1 MiB slack. */
const FILE_BODY_CAP = Math.ceil(FILE_MAX_BYTES * 4 / 3) + 1024 * 1024

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
      // S3: a supplied cwd must exist and be a directory — else the session would bind to a bad
      // root (snapshot/scan/prompt all key off it). Omitted cwd falls back to the daemon cwd (A).
      const cwd = body?.cwd
      if (cwd !== undefined) {
        try {
          if (!(await stat(cwd)).isDirectory()) {
            return sendJson(res, 400, { error: { code: 'bad_request', message: 'cwd is not a directory' } })
          }
        } catch {
          return sendJson(res, 400, { error: { code: 'bad_request', message: 'cwd does not exist' } })
        }
      }
      const { id } = await deps.service.create({ cwd, title: body?.title })
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

    // GET /api/search — 跨会话全文搜索 (S4, auth-gated). query ?q=&limit=
    if (method === 'GET' && path === '/api/search') {
      if (!isAuthed(req)) {
        return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      }
      const q = url.searchParams.get('q') ?? ''
      const limitRaw = url.searchParams.get('limit')
      const limit = limitRaw != null && /^\d+$/.test(limitRaw) ? Number(limitRaw) : undefined
      // Generous per-session cap: keep the LAST 100 hits per session (most recent), drop older
      // ones — bounds payload/DOM on common-substring queries while showing effectively everything.
      return sendJson(res, 200, await deps.search.search(q, { limit, perSessionCap: 100 }))
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

    // -----------------------------------------------------------------------
    // /api/skills — Skill management (M3), all auth-gated. List + edit/enable; no create/delete.
    // Edits rewrite SKILL.md (live body on next Skill load); enable/disable applies on new chats.
    // -----------------------------------------------------------------------

    // GET /api/skills — { skills }
    if (method === 'GET' && path === '/api/skills') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      return sendJson(res, 200, await deps.skill.list())
    }

    // PATCH /api/skills/<name> — update {description?, body?, enabled?}; unknown name → 404.
    if (method === 'PATCH' && path.startsWith('/api/skills/')) {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      const name = decodeURIComponent(path.slice('/api/skills/'.length))
      let body: { description?: unknown; body?: unknown; enabled?: unknown } | undefined
      try { body = (await readJsonBody(req)) as typeof body } catch {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Invalid JSON body' } })
      }
      const fields: { description?: string; body?: string; enabled?: boolean } = {}
      if (typeof body?.description === 'string') fields.description = body.description
      if (typeof body?.body === 'string') fields.body = body.body
      if (typeof body?.enabled === 'boolean') fields.enabled = body.enabled
      const updated = await deps.skill.update(name, fields)
      if (!updated) return sendJson(res, 404, { error: { code: 'not_found', message: 'Skill not found' } })
      return sendJson(res, 200, updated)
    }

    // -----------------------------------------------------------------------
    // /api/usage — aggregated token usage across all sessions (M5), auth-gated. Read-only.
    // -----------------------------------------------------------------------
    if (method === 'GET' && path === '/api/usage') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      return sendJson(res, 200, await deps.usage.stats())
    }

    // -----------------------------------------------------------------------
    // /api/files — project file browser (M7 read, I3 write/delete/search/raw), auth-gated.
    // S3: each request may carry ?cwd= to browse under the active session's cwd instead of the
    // daemon default; every FileService is root-locked to its cwd (traversal guard intact).
    // Shared error mapping: traversal → 403, missing → 404, stale-mtime conflict → 409, rest 400.
    // -----------------------------------------------------------------------
    const fileSvcFor = (): FileService => {
      const cwd = url.searchParams.get('cwd')
      return cwd ? new FileService(cwd) : deps.file
    }
    const sendFileError = (e: unknown): void => {
      if (e instanceof PathOutsideRootError) return sendJson(res, 403, { error: { code: 'forbidden', message: e.message } })
      if (e instanceof FileChangedError) return sendJson(res, 409, { error: { code: 'conflict', message: e.message } })
      if (e instanceof FileExistsError) return sendJson(res, 409, { error: { code: 'exists', message: e.message } })
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return sendJson(res, 404, { error: { code: 'not_found', message: 'Not found' } })
      return sendJson(res, 400, { error: { code: 'bad_request', message: (e as Error).message } })
    }

    //   GET /api/files?dir=<rel>          → immediate children (lazy, one level)
    //   GET /api/files/content?path=<rel> → file preview (size-capped, binary-skipped)
    if (method === 'GET' && (path === '/api/files' || path === '/api/files/content')) {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      try {
        const fileSvc = fileSvcFor()
        if (path === '/api/files') {
          return sendJson(res, 200, await fileSvc.list(url.searchParams.get('dir') ?? ''))
        }
        const p = url.searchParams.get('path')
        if (!p) return sendJson(res, 400, { error: { code: 'bad_request', message: 'Missing path' } })
        return sendJson(res, 200, await fileSvc.read(p))
      } catch (e) {
        return sendFileError(e)
      }
    }

    // GET /api/files/search — fuzzy filename search (quick-open), capped server-side. (I3)
    if (method === 'GET' && path === '/api/files/search') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      try {
        return sendJson(res, 200, await fileSvcFor().search(url.searchParams.get('q') ?? ''))
      } catch (e) {
        return sendFileError(e)
      }
    }

    // PUT /api/files/content — write (edit or create) a file. DELETE — remove a file. (I3)
    if ((method === 'PUT' || method === 'DELETE') && path === '/api/files/content') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      try {
        const fileSvc = fileSvcFor()
        if (method === 'DELETE') {
          const p = url.searchParams.get('path')
          if (!p) return sendJson(res, 400, { error: { code: 'bad_request', message: 'Missing path' } })
          await fileSvc.remove(p)
          return sendJson(res, 200, { ok: true })
        }
        const body = (await readJsonBody(req)) as { path?: string; content?: string; expectMtimeMs?: number; force?: boolean; mustCreate?: boolean }
        if (!body?.path || typeof body.content !== 'string') return sendJson(res, 400, { error: { code: 'bad_request', message: 'path and content required' } })
        const result = await fileSvc.write(body.path, body.content, { expectMtimeMs: body.expectMtimeMs, force: body.force, mustCreate: body.mustCreate })
        return sendJson(res, 200, result)
      } catch (e) {
        return sendFileError(e)
      }
    }

    // GET /api/files/raw — raw bytes with a real Content-Type, for <img>/<iframe>/download. (I3)
    if (method === 'GET' && path === '/api/files/raw') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      try {
        const p = url.searchParams.get('path')
        if (!p) return sendJson(res, 400, { error: { code: 'bad_request', message: 'Missing path' } })
        // download=1 → attachment (any size): the client's "download" affordance must work even
        // for files past the inline cap. Inline preview (img/iframe) still honours the cap.
        const download = url.searchParams.get('download') === '1'
        const info = await fileSvcFor().statFile(p)
        if (!download && info.size > RAW_CAP) return sendJson(res, 413, { error: { code: 'too_large', message: 'File too large to serve' } })
        const extra = download
          ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(info.abs))}` }
          : undefined
        streamFileTo(res, info.abs, info.mime, info.size, extra)
        return
      } catch (e) {
        return sendFileError(e)
      }
    }

    // -----------------------------------------------------------------------
    // /api/uploads — user image uploads (I2), auth-gated. base64-in-JSON (localhost single-user;
    // no multipart). POST stores; GET /<id> streams the stored image back with its content-type.
    // -----------------------------------------------------------------------

    // POST /api/uploads — body {mediaType, dataBase64, name?} → 200 {id, name, mediaType}.
    // Must precede the GET /<id> pattern (different method, but keep them grouped).
    if (method === 'POST' && path === '/api/uploads') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      let body: { mediaType?: unknown; dataBase64?: unknown; name?: unknown } | undefined
      try { body = (await readJsonBody(req, UPLOAD_BODY_CAP)) as typeof body } catch (e) {
        if (e instanceof PayloadTooLargeError) return sendJson(res, 413, { error: { code: 'too_large', message: e.message } })
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Invalid JSON body' } })
      }
      const mediaType = body?.mediaType
      const dataBase64 = body?.dataBase64
      if (typeof mediaType !== 'string' || typeof dataBase64 !== 'string') {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'mediaType and dataBase64 required' } })
      }
      const name = typeof body?.name === 'string' ? body.name : undefined
      try {
        const bytes = Buffer.from(dataBase64, 'base64')
        const { id } = await deps.upload.save(bytes, mediaType)
        return sendJson(res, 200, { id, name, mediaType }) // name echoed back verbatim
      } catch (e) {
        if (e instanceof UnsupportedMediaError) return sendJson(res, 415, { error: { code: 'unsupported_media', message: e.message } })
        if (e instanceof TooLargeError) return sendJson(res, 413, { error: { code: 'too_large', message: e.message } })
        return sendJson(res, 400, { error: { code: 'bad_request', message: (e as Error).message } })
      }
    }

    // POST /api/uploads/file — arbitrary (non-image) files. body {name, mediaType?, dataBase64}
    // → 200 {id, name, mediaType}. Server only stores; no MIME whitelist. Same base64-in-JSON
    // transport as /api/uploads.
    if (method === 'POST' && path === '/api/uploads/file') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      let body: { name?: unknown; mediaType?: unknown; dataBase64?: unknown } | undefined
      try { body = (await readJsonBody(req, FILE_BODY_CAP)) as typeof body } catch (e) {
        if (e instanceof PayloadTooLargeError) return sendJson(res, 413, { error: { code: 'too_large', message: e.message } })
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Invalid JSON body' } })
      }
      const name = body?.name
      const dataBase64 = body?.dataBase64
      if (typeof name !== 'string' || typeof dataBase64 !== 'string') {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'name and dataBase64 required' } })
      }
      const mediaType = typeof body?.mediaType === 'string' && body.mediaType ? body.mediaType : 'application/octet-stream'
      try {
        const bytes = Buffer.from(dataBase64, 'base64')
        const { id, name: stored } = await deps.upload.saveFile(bytes, name)
        return sendJson(res, 200, { id, name: stored, mediaType })
      } catch (e) {
        if (e instanceof FileTooLargeError) return sendJson(res, 413, { error: { code: 'too_large', message: e.message } })
        return sendJson(res, 400, { error: { code: 'bad_request', message: (e as Error).message } })
      }
    }

    // GET /api/uploads/<id> — stream the stored image. Malformed id → 400; missing → 404.
    if (method === 'GET' && path.startsWith('/api/uploads/')) {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      const id = decodeURIComponent(path.slice('/api/uploads/'.length))
      try {
        const { abs, size, mediaType } = await deps.upload.load(id)
        streamFileTo(res, abs, mediaType, size)
        return
      } catch (e) {
        if (e instanceof UploadNotFoundError) return sendJson(res, 404, { error: { code: 'not_found', message: 'Not found' } })
        if (e instanceof InvalidUploadIdError) return sendJson(res, 400, { error: { code: 'bad_request', message: e.message } })
        return sendJson(res, 400, { error: { code: 'bad_request', message: (e as Error).message } })
      }
    }

    // -----------------------------------------------------------------------
    // /api/dirs — working-directory picker (S3): unrestricted subdir navigation + drives.
    //   GET /api/dirs?path=<abs> → { path, parent, dirs, drives }. Defaults to the daemon cwd.
    // Unrestricted on purpose (chooser for a new session's cwd); single-user trust model.
    // -----------------------------------------------------------------------
    if (method === 'GET' && path === '/api/dirs') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      try {
        return sendJson(res, 200, await listDirsAt(url.searchParams.get('path') || process.cwd()))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return sendJson(res, 404, { error: { code: 'not_found', message: 'Directory not found' } })
        return sendJson(res, 400, { error: { code: 'bad_request', message: (e as Error).message } })
      }
    }

    // -----------------------------------------------------------------------
    // /api/mcp — MCP server management (M4), all auth-gated.
    // Config changes take effect on daemon restart (connections are established at startup).
    // -----------------------------------------------------------------------

    // GET /api/mcp — McpServerInfo[] (configured + live status + tools).
    if (method === 'GET' && path === '/api/mcp') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      return sendJson(res, 200, deps.mcp.list())
    }

    // POST /api/mcp/reconnect — live reconnect from current settings (no server restart). Must
    // precede the <name> routes. Returns the refreshed list.
    if (method === 'POST' && path === '/api/mcp/reconnect') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      try {
        await deps.mcp.reconnect()
      } catch (err) {
        return sendJson(res, 500, { error: { code: 'reconnect_failed', message: err instanceof Error ? err.message : String(err) } })
      }
      return sendJson(res, 200, deps.mcp.list())
    }

    // POST /api/mcp/<name>/reconnect — live reconnect of a single server. Returns the refreshed list.
    if (method === 'POST' && path.startsWith('/api/mcp/') && path.endsWith('/reconnect')) {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      const name = decodeURIComponent(path.slice('/api/mcp/'.length, -'/reconnect'.length))
      try {
        await deps.mcp.reconnectServer(name)
      } catch (err) {
        return sendJson(res, 500, { error: { code: 'reconnect_failed', message: err instanceof Error ? err.message : String(err) } })
      }
      return sendJson(res, 200, deps.mcp.list())
    }

    // POST /api/mcp — add/overwrite a server config. body {name, command?, args?, env?, cwd?, url?}
    if (method === 'POST' && path === '/api/mcp') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      let body: { name?: unknown; command?: unknown; args?: unknown; env?: unknown; cwd?: unknown; url?: unknown } | undefined
      try { body = (await readJsonBody(req)) as typeof body } catch {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Invalid JSON body' } })
      }
      if (typeof body?.name !== 'string' || body.name.trim() === '') {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Missing or empty name' } })
      }
      const hasCommand = typeof body.command === 'string' && body.command.trim() !== ''
      const hasUrl = typeof body.url === 'string' && body.url.trim() !== ''
      if (!hasCommand && !hasUrl) {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Provide a command (stdio) or url (SSE)' } })
      }
      const config: Record<string, unknown> = {}
      if (hasCommand) config.command = body.command
      if (hasUrl) config.url = body.url
      if (Array.isArray(body.args)) config.args = body.args.filter((a) => typeof a === 'string')
      if (body.env && typeof body.env === 'object') config.env = body.env
      if (typeof body.cwd === 'string') config.cwd = body.cwd
      try {
        deps.mcp.add(body.name, config as Parameters<McpService['add']>[1])
      } catch (err) {
        return sendJson(res, 500, { error: { code: 'write_failed', message: err instanceof Error ? err.message : String(err) } })
      }
      return sendJson(res, 200, { ok: true, restartRequired: true })
    }

    // DELETE /api/mcp/<name> — remove a server config (idempotent). Takes effect on restart.
    if (method === 'DELETE' && path.startsWith('/api/mcp/')) {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      const name = decodeURIComponent(path.slice('/api/mcp/'.length))
      try {
        deps.mcp.remove(name)
      } catch (err) {
        return sendJson(res, 500, { error: { code: 'write_failed', message: err instanceof Error ? err.message : String(err) } })
      }
      return sendJson(res, 200, { ok: true, restartRequired: true })
    }

    // -----------------------------------------------------------------------
    // /api/models + /api/model — Header model switcher (parity with TUI /model), auth-gated.
    // GET reads the configured options; PUT persists the default to project settings. Temporary
    // (this-session-only) switching goes over WS ({type:'switch-model'}), not through here.
    // -----------------------------------------------------------------------

    // GET /api/models — { options: {providerId, model}[]; defaultModel } expanded from settings.providers.
    if (method === 'GET' && path === '/api/models') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      const settings = loadSettings()
      const options = listSelectableModels(settings)
      // flat-default guard: when the active default (settings.model) comes from the synthesized
      // 'default' provider — no matching providers entry — listSelectableModels yields nothing for
      // it, leaving the picker unable to show/select the model actually in use. Ensure the current
      // default is always present (dedup on providerId+model so a listed model isn't duplicated).
      // A default configured as a non-chat model (type:ocr/image/…) is NOT re-added: it must stay
      // excluded exactly like listSelectableModels excludes it — the guard must not smuggle it back.
      if (settings.model) {
        const { providerId, model } = resolveModelSelection(settings)
        if (!isNonChatModel(settings, providerId, model) && !options.some((o) => o.providerId === providerId && o.model === model)) {
          options.unshift({ providerId, model, vision: resolveVision(settings, providerId, model) })
        }
      }
      return sendJson(res, 200, { options, defaultModel: settings.model ?? null })
    }

    // PUT /api/model — persist the default model. body {providerId, model}. Writes a bare model
    // name for the flat default provider, else `providerId/model` (matches TUI --save + setModelInSettings).
    if (method === 'PUT' && path === '/api/model') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      let body: { providerId?: unknown; model?: unknown } | undefined
      try { body = (await readJsonBody(req)) as typeof body } catch {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Invalid JSON body' } })
      }
      const providerId = body?.providerId
      const model = body?.model
      if (typeof providerId !== 'string' || providerId.trim() === '' || typeof model !== 'string' || model.trim() === '') {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'providerId and model are required' } })
      }
      // Flat default = the synthetic 'default' provider with no explicit providers.default entry:
      // store just the bare model name so it round-trips through resolveModelSelection.
      const settings = loadSettings()
      const flat = providerId === DEFAULT_PROVIDER_ID && !settings.providers?.[providerId]
      const spec = flat ? model : `${providerId}/${model}`
      try {
        deps.persistModel(spec)
      } catch (err) {
        return sendJson(res, 500, { error: { code: 'write_failed', message: err instanceof Error ? err.message : String(err) } })
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
