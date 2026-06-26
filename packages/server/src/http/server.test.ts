import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { ToolRegistry } from '@zuse/core'
import type { ResolvedSettings } from '@zuse/core'
import { PasswordStore } from '../auth/passwordStore.js'
import { LocalPasswordAuth } from '../auth/authProvider.js'
import { SessionService } from '../session/SessionService.js'
import { MemoryService } from '../memory/MemoryService.js'
import { PersonaService } from '../persona/PersonaService.js'
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

let dir: string, srv: Server, base: string, memory: MemoryService, persona: PersonaService
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'zuse-auth-'))
  const auth = new LocalPasswordAuth(new PasswordStore(dir), 3600)
  const service = new SessionService({ dir: join(dir, 'web-sessions'), cwd: '/work', createSession: fakeCreateSession })
  // Temp-db MemoryService so memory routes never touch the real ~/.zuse/memory.db.
  memory = new MemoryService({ dbPath: join(dir, 'memory.db') })
  // Temp-file PersonaService so persona routes never touch the real ~/.zuse/personas.json.
  persona = new PersonaService(join(dir, 'personas.json'))
  srv = createServer(makeRequestHandler({ auth, service, memory, persona, devPage: false, tokenTtlSec: 3600 }))
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
