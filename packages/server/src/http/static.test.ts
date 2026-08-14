import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { connect as netConnect } from 'node:net'
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

  /**
   * 路径穿越。**这条测试原来是假绿的，两处都错：**
   *
   * 1. 用 `fetch(base + '/../../etc/passwd')` 发请求 —— WHATWG 的 URL 解析器会在
   *    **客户端**就把 `..` 归一掉。实测（node v22，自建 http 服务器打印 req.url）：
   *
   *        请求 /../../etc/passwd          → 服务端看到 "/etc/passwd"
   *        请求 /a/../../etc/passwd        → 服务端看到 "/etc/passwd"
   *        裸 socket 发 /../../etc/passwd  → 服务端看到 "/../../etc/passwd"
   *
   *    也就是说 `..` **从来没到达过服务端**，这条测试对它自称要防的东西完全无感。
   *
   * 2. 断言写成 `expect([403, 404, 200].includes(r.status)).toBe(true)` ——
   *    把 200 也算通过，等于这半条断言不可能失败。
   *
   * 现在改成裸 socket 发原始报文，并且落一个**真的**秘密文件在 webDir 外面，
   * 断言它的内容一个字都不能出现在响应里。同一实测还发现 `%2e%2e%2f` 这种
   * 百分号编码形态**能穿过 fetch**（服务端原样收到），原来的测试同样没覆盖。
   */
  async function rawGet(rawPath: string): Promise<string> {
    const port = Number(base.split(':')[2])
    return await new Promise<string>((resolve, reject) => {
      const sock = netConnect(port, '127.0.0.1', () => {
        sock.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`)
      })
      let buf = ''
      sock.on('data', (d: Buffer) => { buf += d.toString('utf8') })
      sock.on('close', () => resolve(buf))
      sock.on('error', reject)
    })
  }

  it('blocks path traversal (裸 socket，让 `..` 真的到达服务端)', async () => {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>SPA</title>')
    // 秘密文件放在 webDir 的**父目录**里 —— 穿越成功的话正好够得着。
    const secretName = 'zuse-traversal-secret.txt'
    const secretPath = join(dir, '..', secretName)
    writeFileSync(secretPath, 'TRAVERSAL-SECRET-MARKER')
    try {
      await start(dir)
      const attacks = [
        `/../${secretName}`,
        `/../../${secretName}`,
        `/a/../../${secretName}`,
        `/%2e%2e%2f${secretName}`,          // 百分号编码：实测能穿过 fetch，必须单独覆盖
        `/%2e%2e/${secretName}`,
        `/..%2f${secretName}`,
        `/..\\${secretName}`,               // Windows 分隔符
      ]
      for (const a of attacks) {
        const raw = await rawGet(a)
        expect(raw, `攻击载荷 ${a} 把文件内容读出来了`).not.toContain('TRAVERSAL-SECRET-MARKER')
      }
    } finally {
      rmSync(secretPath, { force: true })
    }
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
