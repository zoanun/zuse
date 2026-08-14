import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BashTool } from '../bash.js'
import { getShellLabel } from './shell.js'
import { spawnShellCommand } from './spawn.js'
import { killTree, killTreeHard } from '../util.js'
import { Run } from '../run/run.js'
import { PROJECT_POLICY } from '../run/policy.js'
import { createFileTracker, type ToolContext } from '@zuse/core'

/**
 * **端到端 —— 真子进程、真孙进程。**
 *
 * 纯 helper 单测（`settle.test.ts`）证明不了接线：`bash.ts` / `run.ts` 哪个忘了改，
 * 它一条都不会红。这与已修的 iframe sandbox 假绿、setup token 的接线测试同型。
 *
 * ## 命令的写法有一个教科书级的坑
 *
 * **`node -e "…" & echo done` 在 Windows 上活不过 `spawnShellCommand`。** 实测：内层双引号
 * 不被转义，bash 拿到的是没引号的命令行，`()=>{}` 里的 `>` 被当成重定向：
 *
 * ```
 * setTimeout(()=>{},3000)  变成  setTimeout(()=,3000)   → node 语法错误秒退
 * ```
 *
 * **孙进程压根没起来，close 当然按时到，把 exit 分支删掉照样全绿。** 所以这里：
 * 脚本落到临时 `.cjs` 文件、命令用单引号包路径，并且**断言孙进程真的起来了**
 *（它写一个心跳文件）—— 否则没有任何东西能证明这条测试测的是它自称测的东西。
 */

/** `&` 的后台语义只在 bash 下成立；cmd.exe 里它只是顺序分隔符（shell.ts 的第三级回退）。 */
const isBash = getShellLabel() === 'bash'

let dir: string
let hb: string
let gcScript: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zuse-settle-'))
  hb = join(dir, 'heartbeat')
  gcScript = join(dir, 'gc.cjs')
  // 孙进程：每 100ms 写一次心跳，2.5 秒后自己退出（**必须短命** —— 留孤儿会污染
  // 后面的用例，也会把 vitest worker 拖住）。写 stdout 是关键：destroy 管道的实现
  // 会让它拿 EPIPE 自杀，那正是 v1 的错误补救，这里要能看出区别。
  writeFileSync(gcScript, [
    'const fs = require("fs")',
    `const hb = ${JSON.stringify(hb)}`,
    `fs.writeFileSync(${JSON.stringify(gcPidFile(dir))}, String(process.pid))`,
    'let n = 0',
    'const t = setInterval(() => {',
    '  n++',
    '  fs.writeFileSync(hb, String(n))',
    '  process.stdout.write("gc-tick " + n + "\\n")',
    // 活 12 秒（120 × 100ms）。afterEach 会按 pid 收掉它，所以长寿不留垃圾。
    '  if (n >= 120) { clearInterval(t) }',
    '}, 100)',
  ].join('\n'), 'utf8')
})
afterEach(async () => {
  // **孙进程必须显式收掉。** 它是活着的（这正是本次补救要保证的），会握着临时目录 →
  // 直接 rmSync 得到 EBUSY。让脚本自己落 pid，这里按 pid 收。
  const pidFile = gcPidFile(dir)
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8'))
    if (Number.isInteger(pid) && pid > 0) killTree(pid)
    await sleep(300)
  }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不该判测试红 */ }
})

const gcPidFile = (d: string): string => join(d, 'gc.pid')

const posix = (p: string): string => p.replace(/\\/g, '/')
/** 前台秒退 + 孙进程握着 stdout —— 就是 F P1 的形态。 */
const bgCommand = (): string => `node '${posix(gcScript)}' & echo FGDONE`
const ticks = (): number => (existsSync(hb) ? Number(readFileSync(hb, 'utf8')) : 0)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/**
 * 等孙进程真的活起来。
 *
 * **不能在工具返回的那一刻直接断言 `ticks() > 0`** —— 正确实现是在 exit+250ms 就返回的，
 * 而孙进程那边 node 还在启动（实测并行跑满时返回时 ticks 恰好是 0）。
 * 「孙进程真的起来了」是要证明的事实，不是要卡的时刻。
 */
async function waitForTicks(min: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (ticks() >= min) return ticks()
    await sleep(50)
  }
  return ticks()
}

const makeCtx = (): ToolContext => ({
  cwd: dir,
  signal: new AbortController().signal,
  tracker: createFileTracker(),
})

describe.skipIf(!isBash)(`收尾改判 exit —— 端到端（shell=${getShellLabel()}）`, () => {
  /**
   * 修之前这条**永不返回**（不是「等满 120 秒」）：超时定时器只置标志 + killTree，
   * `finish()` 只挂在 close 上，而孙进程扛过 taskkill 之后 close 永远不来。
   * 实测过一次 timeout=2000ms 的调用，15 秒硬闸到点仍挂着。
   */
  it('Bash 工具：后台孙进程握管道时也要秒回，且孙进程真的起来了', async () => {
    const t0 = Date.now()
    const r = await BashTool.run({ command: bgCommand(), timeout: 30_000 }, makeCtx())
    const elapsed = Date.now() - t0
    const ticksAtReturn = ticks()

    expect(r.isError).toBe(false)
    expect(r.output).toContain('FGDONE')
    // **这条断言是整个测试的地基**：没有它，一个语法错误秒退的 node 也能让上面全绿。
    // 但要**等**它 —— 正确实现在 exit+250ms 就返回，那时孙进程的 node 可能还在启动。
    expect(await waitForTicks(1, 5000)).toBeGreaterThan(0)
    // **判据必须与机器负载无关。** 第一版断言「elapsed < 2000ms」：单跑 1.6s 过，
    // 全量并行跑 2.9s 红（进程启动开销随负载浮动）。真正的不变量是
    // 「返回时孙进程还远没跑完」—— 只听 close 的实现必须等它跑完 120 拍。
    expect(ticksAtReturn).toBeLessThan(60)
    expect(elapsed).toBeLessThan(9000)   // 粗兜底，防止「一直挂着」退化成静默通过
  }, 30_000)

  /**
   * v1 的补救是 `destroy()` —— 实测它让孙进程写 stdout 拿 EPIPE **自杀**。
   * 那意味着 `pnpm dev &` 起的后台进程会在 exit+250ms 无声死掉，而用户看到「done」秒回。
   * 成功报文 + 静默失效，本仓最痛恨的那一类。
   */
  it('收尾之后孙进程必须还活着（destroy 会打死它）', async () => {
    await BashTool.run({ command: bgCommand(), timeout: 30_000 }, makeCtx())
    const a = await waitForTicks(1, 5000)
    await sleep(600)
    expect(ticks()).toBeGreaterThan(a)   // 心跳还在推进 = 没被 EPIPE 打死
  }, 20_000)

  /**
   * run 那侧的后果更重：项目档 `wallClockMs: null` + `idleMs: null` + `onDetach:'keep'`，
   * 没有任何东西会把它收掉 → 永远停在 `running`，**永久占一个并发额度**；
   * `maxConcurrent` 默认 8，攒够 8 次 run 服务对整个 daemon 失效。
   *
   * 必须注入**真** `spawnShellCommand` + 真 `killTree` —— 沿用 `run.test.ts` 的假 child
   * 就完全不是端到端，实现错了也会绿。
   */
  it('run 服务：后台孙进程的 run 必须走到 exited，而不是永远 running', async () => {
    const run = new Run({
      id: 'e2e-1',
      command: bgCommand(),
      cwd: dir,
      sessionId: 's',
      policy: PROJECT_POLICY,
      deps: {
        spawn: (command, opts) => spawnShellCommand(command, { cwd: opts.cwd }),
        killTree,
        killTreeHard,
      },
    })
    const t0 = Date.now()
    const ended = new Promise<number>((res) => {
      run.subscribe((e) => { if (e.type === 'end') res(Date.now() - t0) }, { internal: true })
    })
    // **等待窗口必须远小于孙进程的寿命（12 秒）。** 第一版给了 8 秒、孙进程只活 2.5 秒 ——
    // 孙进程一死 close 就到，于是「只听 close」的实现照样绿，变异验证一条都没红。假绿。
    const elapsed = await Promise.race([ended, sleep(6000).then(() => -1)])
    const ticksAtEnd = ticks()

    expect(elapsed).toBeGreaterThan(-1)                    // 确实收到了 end
    expect(ticksAtEnd).toBeLessThan(60)                    // 与负载无关：end 时孙进程还远没跑完
    expect(await waitForTicks(1, 5000)).toBeGreaterThan(0) // 孙进程真起来了（要等它启动）
    expect(run.status).toBe('exited')
    expect(run.endReason).toBe('exit')
    expect(run.exitCode).toBe(0)
    run.dispose()
  }, 20_000)
})

describe.skipIf(!isBash)(`超时路径（shell=${getShellLabel()}）`, () => {
  /**
   * **这条是评审抓出来的真回归的护栏。**
   *
   * 「Δ=0ms 所以 drain 代价为零」只对正常退出成立。killTree 之后 Δ 实测可达 694ms，
   * 且 exit+250ms 时手上**一个字节都没有**——全部 105832B 在 exit+1000ms 才到。
   * 用 250ms 的话，超时命令的 partial output 会**整个丢掉**，而模型看到的是
   * 「[timed out ...; partial output above]」上面什么都没有 ——
   * 最需要日志判断卡在哪的时刻，日志正好没了，且是静默的。
   *
   * 现有的 `bash.test.ts` 只断言文案里有 "timed out"，**不断言 partial output 非空**，
   * 所以这条退化会全绿通过。
   *
   * **诚实说明这条测试锁不住什么。** 我自己复现同一批命令时，数据在 exit+250ms
   * 就到齐了（`npm view`：exit 时 0B、+250ms 已 105832B），而评审那台/那次是
   * +250ms 仍 0B、+1000ms 才到。**同一个形态在不同时刻结论相反** —— 这恰恰说明
   * 250ms 不是一条可靠的界，所以宽限要给 1500ms。
   * 但也意味着这条 e2e **区分不了两种实现**（把分档去掉它照样绿，实测过）。
   * 真正锁住「kill 路径用更宽的值」的是 `settle.test.ts` 的
   * 「drainMs 可以是函数」+ `run.test.ts` 里那条 250ms 不够、1500ms 才够的断言。
   * 这条留着是锁**用户可见的性质**（超时了得有日志），不是锁实现。
   */
  it('超时后 partial output 必须非空', async () => {
    const script = join(dir, 'chatty.cjs')
    writeFileSync(script, [
      'process.stdout.write("BEFORE-TIMEOUT-MARKER\\n")',
      'setInterval(() => process.stdout.write("x".repeat(2000) + "\\n"), 30)',
    ].join('\n'), 'utf8')
    const r = await BashTool.run({ command: `node '${posix(script)}'`, timeout: 1200 }, makeCtx())
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/timed out/i)
    expect(r.output).toContain('BEFORE-TIMEOUT-MARKER')   // ← 回归锁
  }, 30_000)

  /**
   * 病根是「收尾寄托在一个可能永不到达的事件上」。exit 改判之后孙进程那一类解决了，
   * 但一个**扛得住 taskkill 的前台进程**照样让 promise 永远挂着。硬截止是那条退路。
   *
   * POSIX 上 `killTree` 只发 SIGTERM、没有 SIGKILL 升级，所以 trap 掉 SIGTERM
   * 就是这个形态。Windows 上 taskkill /F 杀得掉，所以这里直接注入一个**不可能被
   * 常规手段收掉**的形态很难；改用注入短硬截止 + 一个 trap 掉信号的脚本。
   */
  it('killTree 之后进程不退 → 硬截止到点仍然 resolve，并点破「可能还在跑」', async () => {
    const script = join(dir, 'stubborn.cjs')
    writeFileSync(script, [
      'const fs = require("fs")',
      `fs.writeFileSync(${JSON.stringify(gcPidFile(dir))}, String(process.pid))`,
      'process.on("SIGTERM", () => {})',   // POSIX：扛住
      'process.stdout.write("STUBBORN\\n")',
      'setInterval(() => {}, 1000)',
    ].join('\n'), 'utf8')
    const prev = process.env.ZUSE_BASH_KILL_DEADLINE_MS
    process.env.ZUSE_BASH_KILL_DEADLINE_MS = '600'
    try {
      const t0 = Date.now()
      const r = await BashTool.run({ command: `node '${posix(script)}'`, timeout: 500 }, makeCtx())
      expect(Date.now() - t0).toBeLessThan(8000)
      expect(r.isError).toBe(true)
      expect(r.output).toContain('STUBBORN')
      // Windows 上 taskkill /F 通常真能杀掉 → 走正常收尾，没有这句；两种都算通过，
      // 但**不能两种都不成立**（那就是又挂住了，而上面的耗时断言已经拦住了）。
      expect(r.output).toMatch(/timed out|did not exit/)
    } finally {
      if (prev === undefined) delete process.env.ZUSE_BASH_KILL_DEADLINE_MS
      else process.env.ZUSE_BASH_KILL_DEADLINE_MS = prev
    }
  }, 30_000)
})

describe('收尾改判 exit —— 与 shell 无关的部分', () => {
  /**
   * ENOENT 的真实形态（实测）：`error` + `close(-4058)`，**没有 `exit`**。
   * 今天靠事件顺序侥幸成立 —— 一旦文案变成 `[exit code: -4058]`，模型完全读不懂。
   */
  it('spawn 失败仍然报「Failed to spawn」，不是 [exit code: -4058]', async () => {
    const r = await BashTool.run({ command: 'echo hi', timeout: 5000 }, {
      ...makeCtx(),
      cwd: join(dir, 'definitely-not-here'),
    })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('Failed to spawn')
    expect(r.output).not.toContain('exit code')
  }, 15_000)
})
