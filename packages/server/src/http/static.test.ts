import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeRequestHandler } from './server.js'
import type { AuthProvider } from '../auth/authProvider.js'
import type { SessionService } from '../session/SessionService.js'
import type { MemoryService } from '../memory/MemoryService.js'
import type { SearchService } from '../search/SearchService.js'
import type { PersonaService } from '../persona/PersonaService.js'
import type { SkillService } from '../skill/SkillService.js'
import type { UsageService } from '../usage/UsageService.js'
import type { FileService } from '../file/FileService.js'
import type { McpService } from '../mcp/McpService.js'
import type { UploadService } from '../upload/UploadService.js'

const fakeAuth = { verifyToken: () => true, isConfigured: async () => true } as unknown as AuthProvider
// Minimal fake — these tests never hit the /api/sessions routes.
const fakeService = { list: async () => [], create: async () => ({ id: 'x' }), delete: async () => {} } as unknown as SessionService
// Minimal fake — these tests never hit the /api/memory routes.
const fakeMemory = { list: () => [], create: () => ({}), update: () => null, remove: () => false, close: () => {} } as unknown as MemoryService
// Minimal fake — these tests never hit the /api/search route.
const fakeSearch = { search: async () => [] } as unknown as SearchService
// Minimal fake — these tests never hit the /api/personas routes.
const fakePersona = { list: async () => ({ personas: [], activeId: null }) } as unknown as PersonaService
// Minimal fake — these tests never hit the /api/skills routes.
const fakeSkill = { list: async () => ({ skills: [] }) } as unknown as SkillService
// Minimal fake — these tests never hit the /api/usage route.
const fakeUsage = { stats: async () => ({ total: { input_tokens: 0, output_tokens: 0 }, sessionCount: 0, byModel: [], sessions: [] }) } as unknown as UsageService
// Minimal fake — these tests never hit the /api/files routes.
const fakeFile = { list: async () => ({ path: '', root: '/', entries: [] }), read: async () => ({ path: '', content: '', truncated: false, binary: false, size: 0 }) } as unknown as FileService
// Minimal fake — these tests never hit the /api/mcp routes.
const fakeMcp = { list: () => [] } as unknown as McpService
// Minimal fake — these tests never hit the /api/uploads routes.
const fakeUpload = { save: async () => ({ id: 'x' }), load: async () => ({ abs: '', size: 0, mediaType: 'image/png' }) } as unknown as UploadService
// Minimal fake — these tests never hit the /api/cron routes.
const fakeCron = { list: async () => [] } as unknown as import('../cron/CronService.js').CronService
// Minimal fake — these tests never hit the /api/voice routes.
const fakeVoice = { capabilities: () => ({ stt: false, tts: false }) } as unknown as import('../voice/VoiceService.js').VoiceService
let dir: string, server: Server, base: string

async function start(webDir?: string): Promise<void> {
  server = createServer(makeRequestHandler({ auth: fakeAuth, service: fakeService, memory: fakeMemory, search: fakeSearch, persona: fakePersona, skill: fakeSkill, usage: fakeUsage, file: fakeFile, mcp: fakeMcp, cron: fakeCron, upload: fakeUpload, voice: fakeVoice, persistModel: () => {}, devPage: true, tokenTtlSec: 3600, webDir }))
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

  /**
   * The preview iframe drops `allow-same-origin` (see packages/web SANDBOX_TOKENS), so the
   * guest runs on an opaque origin and fetching the vendor modules is a CROSS-ORIGIN request.
   * Without this header Chrome refuses the module with
   * "blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present" and every
   * React/Vue preview renders as an empty box.
   */
  it('serves /preview-vendor/* with Access-Control-Allow-Origin: * (opaque-origin guest needs it)', async () => {
    mkdirSync(join(dir, 'preview-vendor'))
    writeFileSync(join(dir, 'preview-vendor', 'react.js'), 'export default 1')
    await start(dir)
    const r = await fetch(base + '/preview-vendor/react.js')
    expect(r.status).toBe(200)
    expect(r.headers.get('access-control-allow-origin')).toBe('*')
    // Credentials must NEVER be allowed: with `*` + credentials the browser would send the
    // auth cookie, which is exactly the hole dropping allow-same-origin closed.
    expect(r.headers.get('access-control-allow-credentials')).toBeNull()
  })

  /**
   * The whole point of dropping allow-same-origin is that preview code can no longer reach the
   * authenticated API (/api/sessions, PUT /api/files/content, POST /api/mcp — none of which
   * prompt for permission). Widening CORS beyond /preview-vendor/ would hand it right back.
   */
  it('does NOT put CORS headers on other static assets', async () => {
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)')
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>SPA</title>')
    await start(dir)
    for (const p of ['/assets/app.js', '/index.html', '/']) {
      const r = await fetch(base + p)
      expect(r.headers.get('access-control-allow-origin'), p).toBeNull()
    }
  })

  it('does NOT put CORS headers on /api responses', async () => {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>SPA</title>')
    await start(dir)
    const r = await fetch(base + '/api/sessions')
    expect(r.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('does not break /healthz or /api', async () => {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>SPA</title>')
    await start(dir)
    expect((await (await fetch(base + '/healthz')).json()).status).toBe('ok')
  })
})
