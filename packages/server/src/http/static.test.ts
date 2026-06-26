import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeRequestHandler } from './server.js'
import type { AuthProvider } from '../auth/authProvider.js'
import type { SessionService } from '../session/SessionService.js'
import type { MemoryService } from '../memory/MemoryService.js'
import type { PersonaService } from '../persona/PersonaService.js'

const fakeAuth = { verifyToken: () => true, isConfigured: async () => true } as unknown as AuthProvider
// Minimal fake — these tests never hit the /api/sessions routes.
const fakeService = { list: async () => [], create: async () => ({ id: 'x' }), delete: async () => {} } as unknown as SessionService
// Minimal fake — these tests never hit the /api/memory routes.
const fakeMemory = { list: () => [], create: () => ({}), update: () => null, remove: () => false, close: () => {} } as unknown as MemoryService
// Minimal fake — these tests never hit the /api/personas routes.
const fakePersona = { list: async () => ({ personas: [], activeId: null }) } as unknown as PersonaService
let dir: string, server: Server, base: string

async function start(webDir?: string): Promise<void> {
  server = createServer(makeRequestHandler({ auth: fakeAuth, service: fakeService, memory: fakeMemory, persona: fakePersona, devPage: true, tokenTtlSec: 3600, webDir }))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const a = server.address()
  base = 'http://127.0.0.1:' + (typeof a === 'object' && a ? a.port : 0)
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'zuse-web-')) })
afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); rmSync(dir, { recursive: true, force: true }) })

describe('static SPA serving', () => {
  it('serves index.html at / when webDir has one', async () => {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>SPA</title>')
    await start(dir)
    const r = await fetch(base + '/')
    expect(await r.text()).toContain('SPA')
  })

  it('serves a real asset with a content-type', async () => {
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)')
    await start(dir)
    const r = await fetch(base + '/assets/app.js')
    expect(r.headers.get('content-type')).toContain('javascript')
    expect(await r.text()).toContain('console.log')
  })

  it('SPA fallback: unknown GET path returns index.html', async () => {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>SPA</title>')
    await start(dir)
    const r = await fetch(base + '/some/route')
    expect(await r.text()).toContain('SPA')
  })

  it('falls back to the dev page when no webDir', async () => {
    await start(undefined)
    const r = await fetch(base + '/')
    expect(await r.text()).toContain('DEV TEST PAGE')
  })

  it('blocks path traversal', async () => {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>SPA</title>')
    await start(dir)
    const r = await fetch(base + '/../../etc/passwd')
    expect([403, 404, 200].includes(r.status)).toBe(true)
    expect(await r.text()).not.toContain('root:')
  })

  it('does not break /healthz or /api', async () => {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>SPA</title>')
    await start(dir)
    expect((await (await fetch(base + '/healthz')).json()).status).toBe('ok')
  })
})
