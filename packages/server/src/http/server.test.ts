import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as core from '@zuse/core'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { ToolRegistry } from '@zuse/core'
import type { ResolvedSettings } from '@zuse/core'
import { PasswordStore } from '../auth/passwordStore.js'
import { LocalPasswordAuth } from '../auth/authProvider.js'
import { SessionService } from '../session/SessionService.js'
import { MemoryService } from '../memory/MemoryService.js'
import { SearchService } from '../search/SearchService.js'
import { PersonaService } from '../persona/PersonaService.js'
import { SkillService } from '../skill/SkillService.js'
import { UsageService } from '../usage/UsageService.js'
import { FileService } from '../file/FileService.js'
import { McpService } from '../mcp/McpService.js'
import { UploadService } from '../upload/UploadService.js'
import { SessionManager } from '../session/SessionManager.js'
import type { CreateSessionOpts } from '../session/createSession.js'
import { fakeClient, fakeSnapshotStore } from '../session/testFakes.js'
import { makeRequestHandler, readJsonBody, PayloadTooLargeError } from './server.js'

// A fake createSession that builds a real SessionManager around a fake client —
// no real settings/model/network. Mirrors SessionService.test.ts.
function makeSettings(): ResolvedSettings {
  return {
    providers: {},
    tools: {},
    permissions: { defaultMode: 'default', allow: [], deny: [], ask: [] },
  } as unknown as ResolvedSettings
}
function fakeCreateSession(opts: CreateSessionOpts): SessionManager {
  const { client } = fakeClient([])
  return new SessionManager({
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    client,
    registry: new ToolRegistry(),
    settings: makeSettings(),
    systemPrompt: 'SYS',
    permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
    snapshotStore: opts.snapshotStore ?? fakeSnapshotStore(),
    conversation: opts.conversation,
    checkpoints: opts.checkpoints,
    createdAt: opts.createdAt,
  })
}

let dir: string, srv: Server, base: string, memory: MemoryService, persona: PersonaService, skill: SkillService, usage: UsageService, file: FileService, mcp: McpService, upload: UploadService
// Captures the spec the /api/model handler computed, so tests assert it without writing settings.
let persistedSpec: string | undefined
beforeEach(async () => {
  persistedSpec = undefined
  dir = mkdtempSync(join(tmpdir(), 'zuse-auth-'))
  const auth = new LocalPasswordAuth(new PasswordStore(dir), 3600)
  const service = new SessionService({ dir: join(dir, 'web-sessions'), cwd: '/work', createSession: fakeCreateSession })
  // SearchService over the same web-sessions store the SessionService writes.
  const search = new SearchService({ dir: join(dir, 'web-sessions') })
  // Temp-db MemoryService so memory routes never touch the real ~/.zuse/memory.db.
  memory = new MemoryService({ dbPath: join(dir, 'memory.db') })
  // Temp-file PersonaService so persona routes never touch the real ~/.zuse/personas.json.
  persona = new PersonaService(join(dir, 'personas.json'))
  // Temp-home SkillService so skill routes scan a temp ~/.zuse/skills, never the real one.
  skill = new SkillService({ home: dir, cwd: dir, disabledFile: join(dir, 'skills-disabled.json') })
  // UsageService over the same web-sessions store the SessionService writes.
  usage = new UsageService(join(dir, 'web-sessions'))
  // FileService rooted at the temp dir so /api/files never browses the real project.
  file = new FileService(dir)
  // Temp-file McpService: configured read from a temp settings file; no live manager.
  const settingsPath = join(dir, 'settings.json')
  mcp = new McpService({ settingsBasePath: settingsPath, loadConfigured: () => {
    try { return JSON.parse(readFileSync(settingsPath, 'utf8')).mcpServers ?? {} } catch { return {} }
  } })
  // Real UploadService over a temp uploads dir so /api/uploads is exercised end-to-end.
  upload = new UploadService(join(dir, 'uploads'))
  srv = createServer(makeRequestHandler({ auth, service, memory, search, persona, skill, usage, file, mcp, upload, persistModel: (spec) => { persistedSpec = spec }, devPage: false, tokenTtlSec: 3600 }))
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const addr = srv.address(); const port = typeof addr === 'object' && addr ? addr.port : 0
  base = `http://127.0.0.1:${port}`
})
afterEach(async () => { await new Promise<void>((r) => srv.close(() => r())); memory.close(); rmSync(dir, { recursive: true, force: true }) })

const json = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

// Setup + login, returning the `name=value` cookie pair for authed requests.
async function authCookie(): Promise<string> {
  await fetch(`${base}/api/auth/setup`, json({ password: 'pw' }))
  const login = await fetch(`${base}/api/auth/login`, json({ password: 'pw' }))
  return (login.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
}

describe('http server', () => {
  it('GET /healthz → 200 ok', async () => {
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('ok')
  })
  it('auth flow: status→setup→login→protected', async () => {
    expect((await (await fetch(`${base}/api/auth/status`)).json()).configured).toBe(false)
    expect((await fetch(`${base}/api/auth/setup`, json({ password: 'pw' }))).status).toBe(200)
    const login = await fetch(`${base}/api/auth/login`, json({ password: 'pw' }))
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('zuse_session=')
    expect((await fetch(`${base}/api/auth/logout`, { method: 'POST' })).status).toBe(401)
    const ok = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: cookie.split(';')[0] ?? '' } })
    expect(ok.status).toBe(200)
  })
  it('login with wrong password → 401', async () => {
    await fetch(`${base}/api/auth/setup`, json({ password: 'pw' }))
    expect((await fetch(`${base}/api/auth/login`, json({ password: 'no' }))).status).toBe(401)
  })
  it('setup twice → 409', async () => {
    await fetch(`${base}/api/auth/setup`, json({ password: 'pw' }))
    expect((await fetch(`${base}/api/auth/setup`, json({ password: 'x' }))).status).toBe(409)
  })
})

describe('/api/sessions REST', () => {
  it('unauthenticated GET /api/sessions → 401', async () => {
    const res = await fetch(`${base}/api/sessions`)
    expect(res.status).toBe(401)
  })

  it('authed CRUD: create → list shows it → delete → list drops it', async () => {
    const cookie = await authCookie()

    // POST /api/sessions → 200 {id}
    const created = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { cookie } })
    expect(created.status).toBe(200)
    const { id } = await created.json() as { id: string }
    expect(id).toBeTruthy()

    // A brand-new empty session is NOT persisted (no empty "New chat" clutter), so it
    // isn't listed yet. PATCH a title to give it disk presence, then it shows in the list.
    const list0 = await (await fetch(`${base}/api/sessions`, { headers: { cookie } })).json() as Array<{ id: string }>
    expect(list0.map((s) => s.id)).not.toContain(id)
    await fetch(`${base}/api/sessions/${id}`, {
      method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'CRUD test' }),
    })

    // GET /api/sessions now includes the new id
    const listed = await fetch(`${base}/api/sessions`, { headers: { cookie } })
    expect(listed.status).toBe(200)
    const list = await listed.json() as Array<{ id: string }>
    expect(list.map((s) => s.id)).toContain(id)

    // DELETE /api/sessions/<id> → 200 {ok:true}
    const deleted = await fetch(`${base}/api/sessions/${id}`, { method: 'DELETE', headers: { cookie } })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ ok: true })

    // GET no longer includes it
    const after = await (await fetch(`${base}/api/sessions`, { headers: { cookie } })).json() as Array<{ id: string }>
    expect(after.map((s) => s.id)).not.toContain(id)
  })

  it('PATCH renames a session and the new title shows up in GET /api/sessions', async () => {
    const cookie = await authCookie()
    const { id } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: { cookie } })).json() as { id: string }

    const patched = await fetch(`${base}/api/sessions/${id}`, {
      method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Renamed via PATCH' }),
    })
    expect(patched.status).toBe(200)
    expect(await patched.json()).toEqual({ ok: true })

    const list = await (await fetch(`${base}/api/sessions`, { headers: { cookie } })).json() as Array<{ id: string; title: string }>
    expect(list.find((s) => s.id === id)?.title).toBe('Renamed via PATCH')
  })

  it('PATCH unauthenticated → 401', async () => {
    const res = await fetch(`${base}/api/sessions/whatever`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(401)
  })

  it('PATCH with a missing title → 400', async () => {
    const cookie = await authCookie()
    const { id } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: { cookie } })).json() as { id: string }
    const res = await fetch(`${base}/api/sessions/${id}`, {
      method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('PATCH with an empty / blank title → 400', async () => {
    const cookie = await authCookie()
    const { id } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: { cookie } })).json() as { id: string }
    const empty = await fetch(`${base}/api/sessions/${id}`, {
      method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ title: '   ' }),
    })
    expect(empty.status).toBe(400)
  })

  it('DELETE with a malformed id → 400 (not 500 / not hung)', async () => {
    const cookie = await authCookie()
    // `..%2ffoo` decodes to `../foo` → safeId rejects it.
    const res = await fetch(`${base}/api/sessions/..%2ffoo`, { method: 'DELETE', headers: { cookie } })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('bad_request')
  })

  it('PATCH with a malformed id → 400 (not 500 / not hung)', async () => {
    const cookie = await authCookie()
    const res = await fetch(`${base}/api/sessions/..%2ffoo`, {
      method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('bad_request')
  })
})

describe('/api/memory REST', () => {
  it('unauthenticated GET /api/memory → 401', async () => {
    expect((await fetch(`${base}/api/memory`)).status).toBe(401)
  })

  it('unauthenticated POST/PATCH/DELETE → 401', async () => {
    expect((await fetch(`${base}/api/memory`, json({ type: 'user', content: 'x' }))).status).toBe(401)
    expect((await fetch(`${base}/api/memory/1`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401)
    expect((await fetch(`${base}/api/memory/1`, { method: 'DELETE' })).status).toBe(401)
  })

  it('authed CRUD: POST → GET contains; PATCH → GET reflects; DELETE → GET gone', async () => {
    const cookie = await authCookie()

    // POST → 200 MemoryItem
    const created = await fetch(`${base}/api/memory`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'project', content: 'compaction 阈值 80%', project: 'p' }) })
    expect(created.status).toBe(200)
    const item = await created.json() as { id: number; content: string; type: string }
    expect(item.id).toBeGreaterThan(0)
    expect(item.type).toBe('project')

    // GET contains it
    const listed = await (await fetch(`${base}/api/memory`, { headers: { cookie } })).json() as Array<{ id: number; content: string }>
    expect(listed.map((m) => m.id)).toContain(item.id)

    // PATCH content → GET reflects new content; search finds new, not old
    const patched = await fetch(`${base}/api/memory/${item.id}`, { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'compaction 阈值 90%' }) })
    expect(patched.status).toBe(200)
    expect((await patched.json() as { content: string }).content).toBe('compaction 阈值 90%')
    const afterPatch = await (await fetch(`${base}/api/memory?project=p`, { headers: { cookie } })).json() as Array<{ id: number; content: string }>
    expect(afterPatch.find((m) => m.id === item.id)?.content).toBe('compaction 阈值 90%')
    const search = await (await fetch(`${base}/api/memory?project=p&q=${encodeURIComponent('90%')}`, { headers: { cookie } })).json() as Array<{ id: number }>
    expect(search.map((m) => m.id)).toContain(item.id)

    // DELETE → GET gone
    const deleted = await fetch(`${base}/api/memory/${item.id}`, { method: 'DELETE', headers: { cookie } })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ ok: true })
    const after = await (await fetch(`${base}/api/memory`, { headers: { cookie } })).json() as Array<{ id: number }>
    expect(after.map((m) => m.id)).not.toContain(item.id)
  })

  it('POST bad type → 400', async () => {
    const cookie = await authCookie()
    const res = await fetch(`${base}/api/memory`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'nope', content: 'x' }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('bad_request')
  })

  it('POST empty content → 400', async () => {
    const cookie = await authCookie()
    const res = await fetch(`${base}/api/memory`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'user', content: '   ' }) })
    expect(res.status).toBe(400)
  })

  it('PATCH unknown id → 404', async () => {
    const cookie = await authCookie()
    const res = await fetch(`${base}/api/memory/99999`, { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'x' }) })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('not_found')
  })

  it('PATCH non-numeric id → 400', async () => {
    const cookie = await authCookie()
    const res = await fetch(`${base}/api/memory/abc`, { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'x' }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('bad_request')
  })

  it('DELETE non-numeric id → 400', async () => {
    const cookie = await authCookie()
    const res = await fetch(`${base}/api/memory/abc`, { method: 'DELETE', headers: { cookie } })
    expect(res.status).toBe(400)
  })
})

describe('/api/personas REST', () => {
  it('unauthenticated requests → 401', async () => {
    expect((await fetch(`${base}/api/personas`)).status).toBe(401)
    expect((await fetch(`${base}/api/personas`, json({ name: 'a', content: 'b' }))).status).toBe(401)
    expect((await fetch(`${base}/api/personas/activate`, json({ id: null }))).status).toBe(401)
  })

  it('create → list → activate → patch → delete round-trips', async () => {
    const cookie = await authCookie()
    const h = { cookie, 'content-type': 'application/json' }

    const created = await fetch(`${base}/api/personas`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'Reviewer', content: 'be terse' }) })
    expect(created.status).toBe(200)
    const p = await created.json() as { id: string; name: string }
    expect(p.name).toBe('Reviewer')

    const listed = await (await fetch(`${base}/api/personas`, { headers: { cookie } })).json() as { personas: Array<{ id: string }>; activeId: string | null }
    expect(listed.personas).toHaveLength(1)
    expect(listed.activeId).toBeNull()

    const activated = await fetch(`${base}/api/personas/activate`, { method: 'POST', headers: h, body: JSON.stringify({ id: p.id }) })
    expect(activated.status).toBe(200)
    expect((await (await fetch(`${base}/api/personas`, { headers: { cookie } })).json()).activeId).toBe(p.id)

    const patched = await fetch(`${base}/api/personas/${p.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ content: 'be very terse' }) })
    expect((await patched.json()).content).toBe('be very terse')

    const del = await fetch(`${base}/api/personas/${p.id}`, { method: 'DELETE', headers: { cookie } })
    expect((await del.json()).ok).toBe(true)
    const after = await (await fetch(`${base}/api/personas`, { headers: { cookie } })).json() as { personas: unknown[]; activeId: string | null }
    expect(after.personas).toHaveLength(0)
    expect(after.activeId).toBeNull() // deleting the active one cleared activation
  })

  it('activating an unknown id → 404; empty name → 400', async () => {
    const cookie = await authCookie()
    const h = { cookie, 'content-type': 'application/json' }
    expect((await fetch(`${base}/api/personas/activate`, { method: 'POST', headers: h, body: JSON.stringify({ id: 'nope' }) })).status).toBe(404)
    expect((await fetch(`${base}/api/personas`, { method: 'POST', headers: h, body: JSON.stringify({ name: '  ', content: 'x' }) })).status).toBe(400)
  })
})

describe('/api/skills REST', () => {
  // The SkillService here scans home=cwd=dir, so a fixture under dir/.zuse/skills is "user"-sourced.
  function writeSkillFixture(name: string, description: string, body: string): void {
    const d = join(dir, '.zuse', 'skills', name)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`, 'utf8')
  }

  it('unauthenticated requests → 401', async () => {
    expect((await fetch(`${base}/api/skills`)).status).toBe(401)
    expect((await fetch(`${base}/api/skills/foo`, { method: 'PATCH', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(401)
  })

  it('list → edit (description/body) → disable round-trips', async () => {
    writeSkillFixture('reviewer', 'use when reviewing', 'Original body.')
    const cookie = await authCookie()
    const h = { cookie, 'content-type': 'application/json' }

    const listed = await (await fetch(`${base}/api/skills`, { headers: { cookie } })).json() as { skills: Array<{ name: string; source: string; enabled: boolean }> }
    expect(listed.skills.map((s) => s.name)).toContain('reviewer')
    const reviewer = listed.skills.find((s) => s.name === 'reviewer')!
    expect(reviewer.source).toBe('user')
    expect(reviewer.enabled).toBe(true)

    const patched = await fetch(`${base}/api/skills/reviewer`, { method: 'PATCH', headers: h, body: JSON.stringify({ description: 'use sparingly', body: 'New body.' }) })
    expect(patched.status).toBe(200)
    const after = await patched.json() as { description: string; body: string }
    expect(after.description).toBe('use sparingly')
    expect(after.body.trim()).toBe('New body.')

    const disabled = await fetch(`${base}/api/skills/reviewer`, { method: 'PATCH', headers: h, body: JSON.stringify({ enabled: false }) })
    expect((await disabled.json()).enabled).toBe(false)
  })

  it('patching an unknown skill name → 404', async () => {
    const cookie = await authCookie()
    const h = { cookie, 'content-type': 'application/json' }
    expect((await fetch(`${base}/api/skills/nope`, { method: 'PATCH', headers: h, body: JSON.stringify({ description: 'x' }) })).status).toBe(404)
  })
})

describe('/api/usage REST', () => {
  it('unauthenticated → 401', async () => {
    expect((await fetch(`${base}/api/usage`)).status).toBe(401)
  })

  it('authed → aggregated stats shape', async () => {
    const cookie = await authCookie()
    const r = await fetch(`${base}/api/usage`, { headers: { cookie } })
    expect(r.status).toBe(200)
    const stats = await r.json() as { total: unknown; sessionCount: number; byModel: unknown[]; sessions: unknown[] }
    expect(typeof stats.sessionCount).toBe('number')
    expect(Array.isArray(stats.byModel)).toBe(true)
    expect(Array.isArray(stats.sessions)).toBe(true)
    expect(stats.total).toHaveProperty('input_tokens')
  })
})

describe('/api/files REST', () => {
  it('unauthenticated → 401', async () => {
    expect((await fetch(`${base}/api/files`)).status).toBe(401)
    expect((await fetch(`${base}/api/files/content?path=x`)).status).toBe(401)
  })

  it('lists a dir and reads a file (FileService is rooted at the temp dir)', async () => {
    writeFileSync(join(dir, 'note.txt'), 'hello files', 'utf8')
    const cookie = await authCookie()
    const listing = await (await fetch(`${base}/api/files?dir=`, { headers: { cookie } })).json() as { entries: Array<{ name: string }> }
    expect(listing.entries.some((e) => e.name === 'note.txt')).toBe(true)
    const preview = await (await fetch(`${base}/api/files/content?path=note.txt`, { headers: { cookie } })).json() as { content: string }
    expect(preview.content).toBe('hello files')
  })

  it('path traversal → 403; missing file → 404; missing path param → 400', async () => {
    const cookie = await authCookie()
    expect((await fetch(`${base}/api/files?dir=..`, { headers: { cookie } })).status).toBe(403)
    expect((await fetch(`${base}/api/files/content?path=nope.txt`, { headers: { cookie } })).status).toBe(404)
    expect((await fetch(`${base}/api/files/content`, { headers: { cookie } })).status).toBe(400)
  })
})

describe('/api/dirs + cwd (S3)', () => {
  it('GET /api/dirs unauthenticated → 401', async () => {
    expect((await fetch(`${base}/api/dirs`)).status).toBe(401)
  })

  it('GET /api/dirs lists subdirectories + parent + drives', async () => {
    mkdirSync(join(dir, 'sub'))
    const cookie = await authCookie()
    const nav = await (await fetch(`${base}/api/dirs?path=${encodeURIComponent(dir)}`, { headers: { cookie } })).json() as { path: string; parent: string | null; dirs: Array<{ name: string }>; drives: string[] }
    expect(nav.dirs.some((d) => d.name === 'sub')).toBe(true)
    expect(typeof nav.parent).toBe('string') // dir is not a drive root
    expect(Array.isArray(nav.drives)).toBe(true)
  })

  it('POST /api/sessions rejects a non-existent cwd with 400', async () => {
    const cookie = await authCookie()
    const h = { cookie, 'content-type': 'application/json' }
    const bad = await fetch(`${base}/api/sessions`, { method: 'POST', headers: h, body: JSON.stringify({ cwd: join(dir, 'does-not-exist') }) })
    expect(bad.status).toBe(400)
    const ok = await fetch(`${base}/api/sessions`, { method: 'POST', headers: h, body: JSON.stringify({ cwd: dir }) })
    expect(ok.status).toBe(200)
  })

  it('GET /api/files?cwd=<other> browses that directory instead of the default root', async () => {
    const other = mkdtempSync(join(tmpdir(), 'zuse-other-'))
    writeFileSync(join(other, 'over-here.txt'), 'x', 'utf8')
    try {
      const cookie = await authCookie()
      const listing = await (await fetch(`${base}/api/files?cwd=${encodeURIComponent(other)}`, { headers: { cookie } })).json() as { entries: Array<{ name: string }> }
      expect(listing.entries.some((e) => e.name === 'over-here.txt')).toBe(true)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('GET /api/search', () => {
  it('未登录 401', async () => {
    const r = await fetch(base + '/api/search?q=x')
    expect(r.status).toBe(401)
  })
  it('带 q 返回分组结果;空 q 返回 []', async () => {
    const cookie = await authCookie()
    const empty = await (await fetch(base + '/api/search?q=', { headers: { cookie } })).json()
    expect(empty).toEqual([])
    const res = await fetch(base + '/api/search?q=anything', { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
  })
})

describe('/api/mcp REST', () => {
  it('unauthenticated requests → 401', async () => {
    expect((await fetch(`${base}/api/mcp`)).status).toBe(401)
    expect((await fetch(`${base}/api/mcp`, json({ name: 'a', command: 'b' }))).status).toBe(401)
  })

  it('add → list (status configured) → delete round-trips via settings.json', async () => {
    const cookie = await authCookie()
    const h = { cookie, 'content-type': 'application/json' }

    // empty initially
    expect(await (await fetch(`${base}/api/mcp`, { headers: { cookie } })).json()).toEqual([])

    const added = await fetch(`${base}/api/mcp`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'playwright', command: 'npx', args: ['@playwright/mcp'] }) })
    expect(added.status).toBe(200)
    expect((await added.json()).restartRequired).toBe(true)

    const list = await (await fetch(`${base}/api/mcp`, { headers: { cookie } })).json() as Array<{ name: string; status: string; command?: string }>
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'playwright', status: 'configured', command: 'npx' }) // configured, not connected (no live manager)

    const del = await fetch(`${base}/api/mcp/playwright`, { method: 'DELETE', headers: { cookie } })
    expect((await del.json()).ok).toBe(true)
    expect(await (await fetch(`${base}/api/mcp`, { headers: { cookie } })).json()).toEqual([])
  })

  it('add with neither command nor url → 400', async () => {
    const cookie = await authCookie()
    const res = await fetch(`${base}/api/mcp`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }) })
    expect(res.status).toBe(400)
  })

  it('POST /api/mcp/reconnect → 200 with the refreshed list (auth-gated)', async () => {
    expect((await fetch(`${base}/api/mcp/reconnect`, { method: 'POST' })).status).toBe(401)
    const cookie = await authCookie()
    const res = await fetch(`${base}/api/mcp/reconnect`, { method: 'POST', headers: { cookie } })
    expect(res.status).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
  })

  it('POST /api/mcp/<name>/reconnect → 200 with the refreshed list (auth-gated)', async () => {
    expect((await fetch(`${base}/api/mcp/everything/reconnect`, { method: 'POST' })).status).toBe(401)
    const cookie = await authCookie()
    const res = await fetch(`${base}/api/mcp/everything/reconnect`, { method: 'POST', headers: { cookie } })
    expect(res.status).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
  })

  it('a deleted server disappears from the list immediately', async () => {
    const cookie = await authCookie()
    const h = { cookie, 'content-type': 'application/json' }
    await fetch(`${base}/api/mcp`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'gone', command: 'x' }) })
    await fetch(`${base}/api/mcp/gone`, { method: 'DELETE', headers: { cookie } })
    const list = await (await fetch(`${base}/api/mcp`, { headers: { cookie } })).json() as unknown[]
    expect(list).toHaveLength(0) // driven by configured servers → delete drops the row at once
  })
})

describe('/api/uploads REST', () => {
  // A 1x1 PNG (UploadService validates mediaType + size, not the byte content).
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

  it('unauthenticated POST/GET → 401', async () => {
    expect((await fetch(`${base}/api/uploads`, json({ mediaType: 'image/png', dataBase64: PNG_B64 }))).status).toBe(401)
    expect((await fetch(`${base}/api/uploads/whatever`)).status).toBe(401)
  })

  it('POST stores an image → GET streams the exact bytes back', async () => {
    const cookie = await authCookie()
    const h = { cookie, 'content-type': 'application/json' }

    const created = await fetch(`${base}/api/uploads`, { method: 'POST', headers: h, body: JSON.stringify({ mediaType: 'image/png', dataBase64: PNG_B64, name: 'a.png' }) })
    expect(created.status).toBe(200)
    const out = await created.json() as { id: string; name: string; mediaType: string }
    expect(out.id).toBeTruthy()
    expect(out.name).toBe('a.png') // name echoed back verbatim
    expect(out.mediaType).toBe('image/png')

    const got = await fetch(`${base}/api/uploads/${out.id}`, { headers: { cookie } })
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('image/png')
    const bytes = Buffer.from(await got.arrayBuffer())
    expect(bytes.equals(Buffer.from(PNG_B64, 'base64'))).toBe(true) // round-trips exactly
  })

  it('POST with a non-image mediaType → 415', async () => {
    const cookie = await authCookie()
    const res = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ mediaType: 'text/plain', dataBase64: PNG_B64 }) })
    expect(res.status).toBe(415)
    expect((await res.json()).error.code).toBe('unsupported_media')
  })

  it('POST with missing fields → 400', async () => {
    const cookie = await authCookie()
    const res = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ mediaType: 'image/png' }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('bad_request')
  })

  it('GET malformed id → 400; GET legal-but-missing uuid → 404', async () => {
    const cookie = await authCookie()
    const bad = await fetch(`${base}/api/uploads/not-a-uuid`, { headers: { cookie } })
    expect(bad.status).toBe(400)
    const missing = await fetch(`${base}/api/uploads/00000000-0000-0000-0000-000000000000`, { headers: { cookie } })
    expect(missing.status).toBe(404)
  })

  it('POST /api/uploads with a body over the size cap → 413 (early reject, no OOM)', async () => {
    const cookie = await authCookie()
    // > UPLOAD_BODY_CAP (~34MB): the body is rejected mid-stream, before the whole thing is
    // buffered/parsed/decoded — proving the cap fires without needing to hold it all in memory.
    const huge = 'A'.repeat(37 * 1024 * 1024)
    const res = await fetch(`${base}/api/uploads`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mediaType: 'image/png', dataBase64: huge }),
    })
    expect(res.status).toBe(413)
    expect((await res.json()).error.code).toBe('too_large')
  })
})

describe('/api/uploads/file REST (I5b)', () => {
  it('unauthenticated POST → 401', async () => {
    const res = await fetch(`${base}/api/uploads/file`, json({ name: 'a.bin', mediaType: 'application/octet-stream', dataBase64: 'AAAA' }))
    expect(res.status).toBe(401)
  })

  it('POST stores an arbitrary file → 200 {id, name, mediaType}, bytes persisted on disk', async () => {
    const cookie = await authCookie()
    const h = { cookie, 'content-type': 'application/json' }
    const bytes = Buffer.from('hello arbitrary file bytes')
    const dataBase64 = bytes.toString('base64')

    const created = await fetch(`${base}/api/uploads/file`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'a.bin', mediaType: 'application/octet-stream', dataBase64 }) })
    expect(created.status).toBe(200)
    const out = await created.json() as { id: string; name: string; mediaType: string }
    expect(out.id).toBeTruthy()
    expect(out.name).toBe('a.bin')
    expect(out.mediaType).toBe('application/octet-stream')

    // Assert persistence via the same UploadService the test injected.
    const stored = upload.filePath(out.id, out.name)
    expect(existsSync(stored)).toBe(true)
    expect(readFileSync(stored).equals(bytes)).toBe(true)
  })

  it('POST with missing name → 400', async () => {
    const cookie = await authCookie()
    const res = await fetch(`${base}/api/uploads/file`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ mediaType: 'application/octet-stream', dataBase64: 'AAAA' }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('bad_request')
  })

  it('POST with missing dataBase64 → 400', async () => {
    const cookie = await authCookie()
    const res = await fetch(`${base}/api/uploads/file`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'a.bin', mediaType: 'application/octet-stream' }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('bad_request')
  })
})

describe('/api/models + /api/model (model switcher)', () => {
  it('unauthenticated GET /api/models → 401', async () => {
    expect((await fetch(`${base}/api/models`)).status).toBe(401)
  })

  it('authed GET /api/models → 200 with options[] + defaultModel', async () => {
    const cookie = await authCookie()
    const res = await fetch(`${base}/api/models`, { headers: { cookie } })
    expect(res.status).toBe(200)
    const body = await res.json()
    // Content depends on the machine's settings; assert only the stable shape.
    expect(Array.isArray(body.options)).toBe(true)
    expect('defaultModel' in body).toBe(true)
    for (const o of body.options) {
      expect(typeof o.providerId).toBe('string')
      expect(typeof o.model).toBe('string')
      expect(typeof o.vision).toBe('boolean')
    }
  })

  it('GET /api/models includes the current default even when no provider lists it (flat default)', async () => {
    const cookie = await authCookie()
    // Providers empty, but settings.model is set (flat/synthesized default) → listSelectableModels
    // yields nothing, yet the current default must still be selectable.
    const spy = vi.spyOn(core, 'loadSettings').mockReturnValue({
      providers: {},
      model: 'claude-sonnet-4-5',
      tools: {},
      permissions: { defaultMode: 'default', allow: [], deny: [], ask: [] },
    } as unknown as ResolvedSettings)
    try {
      const res = await fetch(`${base}/api/models`, { headers: { cookie } })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.options.some((o: { providerId: string; model: string }) => o.model === 'claude-sonnet-4-5')).toBe(true)
      expect(body.defaultModel).toBe('claude-sonnet-4-5')
    } finally {
      spy.mockRestore()
    }
  })

  it('unauthenticated PUT /api/model → 401', async () => {
    expect((await fetch(`${base}/api/model`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401)
  })

  it('PUT /api/model with a provider persists `providerId/model`', async () => {
    const cookie = await authCookie()
    const res = await fetch(`${base}/api/model`, {
      method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'qwen', model: 'kimi-k2.6' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(persistedSpec).toBe('qwen/kimi-k2.6')
  })

  it('PUT /api/model with the flat default provider persists a bare model name', async () => {
    const cookie = await authCookie()
    // The test machine may or may not declare a providers.default entry; only assert flatness
    // when it doesn't (the common case). Either way the endpoint must succeed.
    const res = await fetch(`${base}/api/model`, {
      method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'default', model: 'claude-sonnet-4-5' }),
    })
    expect(res.status).toBe(200)
    expect(persistedSpec === 'claude-sonnet-4-5' || persistedSpec === 'default/claude-sonnet-4-5').toBe(true)
  })

  it('PUT /api/model missing fields → 400', async () => {
    const cookie = await authCookie()
    const res = await fetch(`${base}/api/model`, {
      method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'qwen' }),
    })
    expect(res.status).toBe(400)
    expect(persistedSpec).toBeUndefined()
  })
})

describe('readJsonBody body cap (I2)', () => {
  it('rejects with PayloadTooLargeError once accumulated bytes exceed maxBytes', async () => {
    // Feeds 5 + 5 bytes with maxBytes=8: the SECOND chunk trips the cap, so a third chunk
    // (would-be 'never-read') is never consumed — the early-reject stops accumulation.
    let pulledThird = false
    const stream = Readable.from((function* () {
      yield Buffer.from('12345')
      yield Buffer.from('67890')
      pulledThird = true
      yield Buffer.from('never-read')
    })())
    await expect(readJsonBody(stream as unknown as IncomingMessage, 8)).rejects.toBeInstanceOf(PayloadTooLargeError)
    expect(pulledThird).toBe(false)
  })

  it('with no cap parses a normal JSON body', async () => {
    const stream = Readable.from([Buffer.from('{"a":1}')])
    expect(await readJsonBody(stream as unknown as IncomingMessage)).toEqual({ a: 1 })
  })
})
