import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
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
import { makeRequestHandler, type RequestHandlerDeps } from './server.js'
import type { ResolvedSettings } from '@zuse/core'
import type { SessionManager } from '../session/SessionManager.js'

/**
 * `POST /api/auth/setup` 的 setup token 闸（回溯审计 D2 · 第 2 步）——**路由层**。
 *
 * 判据本身（谁算「暴露」）在 `auth/setupToken.test.ts`；
 * 「`startServer` 到底有没有把 token 传下来」在 `setupTokenWiring.test.ts`。
 * 三层缺一层都会留下假绿：这一层测的是「传了 token 之后路由认不认」。
 */
const fakeCreateSession = ((): SessionManager =>
  ({ subscribe: () => () => {}, snapshot: () => ({}), close: () => {} }) as unknown as SessionManager) as never

let dir: string
let srv: Server
let base: string
let cronScheduler: CronScheduler
let memory: MemoryService
let auth: LocalPasswordAuth

/** 起一个 handler，`setupToken` 由用例决定传不传。 */
async function boot(setupToken?: string): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'zuse-stoken-'))
  auth = new LocalPasswordAuth(new PasswordStore(dir), 3600)
  const service = new SessionService({ dir: join(dir, 'web-sessions'), cwd: '/work', createSession: fakeCreateSession })
  memory = new MemoryService({ dbPath: join(dir, 'memory.db') })
  const cronDataDir = cronDir(dir)
  cronScheduler = new CronScheduler({ dir: cronDataDir, sessions: service })
  const deps: RequestHandlerDeps = {
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
    ...(setupToken !== undefined ? { setupToken } : {}),
  }
  srv = createServer(makeRequestHandler(deps))
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const addr = srv.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
}

beforeEach(() => { /* 每个用例自己调 boot() —— 传不传 token 是用例的变量 */ })
afterEach(async () => {
  await new Promise<void>((r) => srv.close(() => r()))
  cronScheduler.close()
  memory.close()
  rmSync(dir, { recursive: true, force: true })
})

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

const TOKEN = 'PJc0nD1ZbXyq5Xf3l2m8QwErTyUi0pAs'

describe('setup token 闸 —— 路由层', () => {
  /**
   * **回环形态不能被这次改动打死。** 不传 setupToken 时 setup 必须照常成功 ——
   * 每个开发者的首次安装都走这条路。
   */
  it('未配置 token 时 setup 照常成功', async () => {
    await boot()
    expect((await post('/api/auth/setup', { password: 'pw' })).status).toBe(200)
    expect(await auth.isConfigured()).toBe(true)
  })

  it('配置了 token：缺失 → 403 setup_token_required，且口令没被设上', async () => {
    await boot(TOKEN)
    const r = await post('/api/auth/setup', { password: 'pw' })
    expect(r.status).toBe(403)
    expect((await r.json()).error.code).toBe('setup_token_required')
    // 只断言状态码会放过「拒了但已经写进去了」——顺序错一行就是这个后果。
    expect(await auth.isConfigured()).toBe(false)
  })

  it('配置了 token：错误 → 403 setup_token_invalid', async () => {
    await boot(TOKEN)
    const r = await post('/api/auth/setup', { password: 'pw', setupToken: 'x'.repeat(32) })
    expect(r.status).toBe(403)
    expect((await r.json()).error.code).toBe('setup_token_invalid')
    expect(await auth.isConfigured()).toBe(false)
  })

  it('配置了 token：正确 → 200 且口令真的设上了', async () => {
    await boot(TOKEN)
    expect((await post('/api/auth/setup', { password: 'pw', setupToken: TOKEN })).status).toBe(200)
    expect(await auth.isConfigured()).toBe(true)
    expect((await post('/api/auth/login', { password: 'pw' })).status).toBe(200)
  })

  /**
   * 一个没有可操作指引的 403，在用户看来就是「远程访问被封死了」——
   * 第 1 步的 Host 闸已有同样的先例（403 正文里必须出现 `--allowed-host`）。
   */
  it('403 正文写清楚怎么拿到 token', async () => {
    await boot(TOKEN)
    const body = await (await post('/api/auth/setup', { password: 'pw' })).text()
    expect(body).toContain('setup-token')
    expect(body).toContain('终端')
    expect(body).toContain('setupToken')
  })

  /**
   * 未鉴权的单线程 DoS：`Buffer.from({length:2e8})` 实测同步阻塞 6.6 秒。
   * 这里连状态码都不重要，重要的是**秒回**。
   */
  it('setupToken 传对象不会把 daemon 冻住', async () => {
    await boot(TOKEN)
    const t0 = Date.now()
    const r = await post('/api/auth/setup', { password: 'pw', setupToken: { length: 200_000_000 } })
    expect(r.status).toBe(403)
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  /**
   * `/api/auth/status` 是**未鉴权**的。把 `setupTokenRequired` 手滑写成 `setupToken`
   * 就是一击致命，而现在没有任何别的东西挡着这个手误。
   */
  it('status 只回布尔，正文里绝不能出现 token 本体', async () => {
    await boot(TOKEN)
    const res = await fetch(`${base}/api/auth/status`)
    const text = await res.text()
    expect(text).not.toContain(TOKEN)
    expect(JSON.parse(text).setupTokenRequired).toBe(true)
  })

  it('未配置 token 时 status 报 false', async () => {
    await boot()
    expect((await (await fetch(`${base}/api/auth/status`)).json()).setupTokenRequired).toBe(false)
  })

  /** 未鉴权路由的无限缓冲：`readJsonBody` 不给 cap 就是「读完再解析」。 */
  it('超大 body 被 413 掐掉，不是读完再报错', async () => {
    await boot()
    const r = await post('/api/auth/setup', { password: 'x'.repeat(64 * 1024) })
    expect(r.status).toBe(413)
    expect(await auth.isConfigured()).toBe(false)
  })
})
