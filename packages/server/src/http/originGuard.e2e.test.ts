import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, request, type Server, type IncomingMessage } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalPasswordAuth } from '../auth/authProvider.js'
import { PasswordStore } from '../auth/passwordStore.js'
import { SessionService } from '../session/SessionService.js'
import { MemoryService } from '../memory/MemoryService.js'
import { SearchService } from '../search/SearchService.js'
import { PersonaService } from '../persona/PersonaService.js'
import { SkillService } from '../skill/SkillService.js'
import { UsageService } from '../usage/UsageService.js'
import { FileService } from '../file/FileService.js'
import { McpService } from '../mcp/McpService.js'
import { UploadService } from '../upload/UploadService.js'
import { VoiceService } from '../voice/VoiceService.js'
import { CronScheduler } from '../cron/CronScheduler.js'
import { CronService } from '../cron/CronService.js'
import { cronDir } from '../cron/cronStore.js'
import { makeRequestHandler } from './server.js'
import { buildHostPolicy } from './originGuard.js'
import type { ResolvedSettings } from '@zuse/core'
import type { SessionManager } from '../session/SessionManager.js'

/**
 * Host / Origin 闸的**端到端**验证 —— 走真 `http.createServer` + 真 handler。
 *
 * 为什么必须端到端、不能只靠 `originGuard.test.ts` 那些纯函数单测：
 * 纯函数测的是「判据对不对」，这里测的是「判据有没有被真的挂上去、挂在了对的位置」。
 * 本仓吃过一模一样的亏 —— iframe 的 `SANDBOX_TOKENS` 常量被三条安全测试牢牢锁住，
 * 而**应用这个常量的那一行**没有任何测试，删掉它三条测试照样全绿。
 *
 * 现有的 `server.test.ts` 构造 deps 时**不传** `hostPolicy`，所以闸门在那 567 条用例里
 * 整个是关着的 —— 那正是「零改动通过」的原因，也正是需要这个文件的原因。
 */
/**
 * 极简会话桩：本文件测的是**闸门**，它排在所有路由之前，被拒的请求根本走不到会话层。
 * 所以这里不需要 `server.test.ts` 那套完整的 SessionManager 构造。
 */
const fakeCreateSession = ((): SessionManager =>
  ({ subscribe: () => () => {}, snapshot: () => ({}), close: () => {} }) as unknown as SessionManager) as never

let dir: string
let srv: Server
let port: number
let cronScheduler: CronScheduler
let memory: MemoryService

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'zuse-guard-'))
  const auth = new LocalPasswordAuth(new PasswordStore(dir), 3600)
  const service = new SessionService({ dir: join(dir, 'web-sessions'), cwd: '/work', createSession: fakeCreateSession })
  memory = new MemoryService({ dbPath: join(dir, 'memory.db') })
  const cronDataDir = cronDir(dir)
  cronScheduler = new CronScheduler({ dir: cronDataDir, sessions: service })
  srv = createServer(makeRequestHandler({
    auth,
    service,
    memory,
    search: new SearchService({ dir: join(dir, 'web-sessions') }),
    persona: new PersonaService(join(dir, 'personas.json')),
    skill: new SkillService({ home: dir, cwd: dir, disabledFile: join(dir, 'skills-disabled.json') }),
    usage: new UsageService(join(dir, 'web-sessions')),
    file: new FileService(dir),
    mcp: new McpService({ settingsBasePath: join(dir, 'settings.json'), loadConfigured: () => ({}) }),
    cron: new CronService({ dir: cronDataDir, scheduler: cronScheduler, defaultCwd: '/work', sessions: service }),
    upload: new UploadService(join(dir, 'uploads')),
    voice: new VoiceService({ loadSettings: () => ({ providers: {} } as unknown as ResolvedSettings) }),
    persistModel: () => {},
    devPage: false,
    tokenTtlSec: 3600,
    // 本例的策略：只声明一个隧道域名，其余靠回环/IP 豁免
    hostPolicy: buildHostPolicy({ host: '127.0.0.1', allowedHosts: ['*.trycloudflare.com'] }),
  }))
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const addr = srv.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})
afterEach(async () => {
  await new Promise<void>((r) => srv.close(() => r()))
  cronScheduler.close()
  memory.close()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * **必须用 `node:http` 的 request，不能用 `fetch`。**
 *
 * `Host` 是 fetch 规范里的 forbidden header —— undici 会**静默丢弃**它，请求发出去时
 * Host 还是真实的 `127.0.0.1:<port>`。第一版用 fetch 写的时候，"DNS rebinding" 那条
 * 用例确实拿到了 403，但拦它的是 **Origin 闸**（因为 Origin 被正常发出去了），
 * 与这条用例想验证的 Host 闸毫无关系。
 *
 * 如果当时只断言 `status === 403`，它会是一条**绿着的、验错了东西的**测试 ——
 * 正是本仓回溯审计里那一整类假绿的形状。是 `toContain('host_not_allowed')` 把它抓出来的。
 * 所以下面每条断言都要认 `code`，不只认状态码。
 */
const call = (path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers, setHost: false }, (res: IncomingMessage) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    // setHost:false 时 Node 不会自动补 Host —— 没显式给就真的一个 Host 头都不发，
    // 正好用来测「Host 缺失」这一档。
    if (!headers['host'] && !headers['Host']) req.setHeader('host', `127.0.0.1:${port}`)
    req.end()
  })

describe('Host / Origin 闸 —— 端到端', () => {
  it('本机形态全通（Host 是 IP 字面量，Origin 同源）', async () => {
    const r = await call('/api/auth/status', { origin: `http://127.0.0.1:${port}` })
    expect(r.status).toBe(200)
  })

  it('没有 Origin 的 GET 照常通过（地址栏导航 / curl）', async () => {
    expect((await call('/api/auth/status')).status).toBe(200)
  })

  /**
   * 场景 10：DNS rebinding。**Origin 与 Host 完全一致**，所以任何「Origin 必须等于 Host」
   * 的一致性校验在这里都会放行 —— 只有 Host 白名单能挡。这是整个设计的关键论证。
   */
  it('DNS rebinding（Host=Origin=evil）被 Host 闸挡下，且提示里有补救办法', async () => {
    const r = await call('/api/auth/status', { host: 'evil.example', origin: 'http://evil.example' })
    expect(r.status).toBe(403)
    expect(r.body).toContain('host_not_allowed')
    expect(r.body).toContain('--allowed-host')
  })

  /** 场景 11：evil.com 盲打回环 —— Host 合法（IP 字面量），只有 Origin 闸能挡。 */
  it('跨站盲打回环被 Origin 闸挡下', async () => {
    const r = await call('/api/auth/status', { origin: 'https://evil.example' }, 'GET')
    expect(r.status).toBe(403)
    expect(r.body).toContain('origin_not_allowed')
  })

  it('/healthz 豁免 —— 探活要能被任意 Host 打到', async () => {
    const r = await call('/healthz', { host: 'evil.example' })
    expect(r.status).toBe(200)
  })

  it('声明过的隧道域名放行（Host 与 Origin 两侧都要认）', async () => {
    expect((await call('/api/auth/status', { host: 'xyz.trycloudflare.com' })).status).toBe(200)
    // 代理把 Host 改写成回环、Origin 仍是外部名的形态
    expect((await call('/api/auth/status', { origin: 'https://xyz.trycloudflare.com' })).status).toBe(200)
  })

  /**
   * **未鉴权的 setup 是这次修复的靶心。** 它在未设口令时唯一的门是「是否已配置」，
   * 攻击链是 status → setup → login → POST /api/runs（任意命令）。
   */
  it('rebinding 打不到 POST /api/auth/setup', async () => {
    const r = await call('/api/auth/setup', { host: 'evil.example', origin: 'http://evil.example', 'content-type': 'application/json' }, 'POST')
    expect(r.status).toBe(403)
  })

  it('畸形 Host 拒绝', async () => {
    expect((await call('/api/auth/status', { host: 'evil.example:1/../127.0.0.1' })).status).toBe(403)
  })
})
