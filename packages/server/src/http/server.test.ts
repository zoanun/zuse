import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
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
import { SessionManager } from '../session/SessionManager.js'
import type { CreateSessionOpts } from '../session/createSession.js'
import { fakeClient, fakeSnapshotStore } from '../session/testFakes.js'
import { makeRequestHandler } from './server.js'

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

let dir: string, srv: Server, base: string, memory: MemoryService, persona: PersonaService, skill: SkillService, usage: UsageService, file: FileService, mcp: McpService
beforeEach(async () => {
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
  srv = createServer(makeRequestHandler({ auth, service, memory, search, persona, skill, usage, file, mcp, devPage: false, tokenTtlSec: 3600 }))
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

    // GET /api/sessions includes the new id
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
