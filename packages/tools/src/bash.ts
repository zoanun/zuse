import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Tool, ToolContext, ToolResult, JSONSchema } from '@zuse/core'
import { killTree } from './util.js'
import { ensureShellSnapshot } from './shell-snapshot.js'
import { ensureTmuxSocket, getZuseTmuxEnv, isTmuxCommand } from './tmux-isolation.js'
import { StreamShaper } from './truncate.js'
// 进程层（shell 选型 / 子进程环境 / 解码 / spawn）已抽到 ./proc，见设计 §1：
// 将来的 run 服务要复用同一套 Windows 细节。本文件只保留**策略**（超时、截断预算、
// 落盘位置、cwd 捕获、错误文案）。
import {
  buildChildEnv,
  getShellLabel,
  ProcOutputDecoder,
  redecodeOemIfMojibake,
  resolvedShell,
  spawnShellCommand,
  onChildSettled,
} from './proc/index.js'

// 对外 API 保持原样：这三个符号历史上就从 bash.ts 导出（index.ts 与既有测试都按此引入），
// 抽层不改对外形态，故在此原样转出。
export { buildChildEnv, getShellLabel, redecodeOemIfMojibake }

/**
 * `exit` 之后等 `close` 的宽限，见 `proc/settle.ts`。
 * 代价为零：正常命令的 close 在 Δ=0ms 就到，这个计时器轮不到触发。
 */
const DRAIN_MS = 250
/**
 * **被 kill 之后**的 drain 宽限，比正常退出宽得多。
 *
 * 「Δ=0ms 所以代价为零」只对正常退出成立。评审实测 kill 路径（400ms 时 taskkill /T /F）：
 *
 * ```
 * npm view   exit@840ms  close@1534ms  Δ=694ms
 *   3 次采样：exit+250ms 手上 0 字节，exit+500ms 仍 0 字节，
 *             全部 105832B 在 exit+1000ms 才到
 * ```
 *
 * 用 250ms 的话，超时命令的 partial output 会**整个丢掉** —— 而那正是模型最需要
 * 日志判断「卡在哪」的时刻，且是静默的。1500ms 对实测的 694ms 有一倍余量，
 * 而那条路上用户已经在等超时了，多等 1 秒不改变体验。
 */
const KILLED_DRAIN_MS = 1_500
/**
 * killTree 之后的**硬截止**：到点无论如何 resolve。
 *
 * 比 run 那边的两段 grace（3s+3s）短，因为这里没有「升级重杀」那一步。
 * **已知代价**：POSIX 上 `killTree` 只发 SIGTERM、没有 SIGKILL 升级（`util.ts`），
 * 所以一个 trap 掉 SIGTERM 的进程在这 5 秒后仍然活着，我们只是不再等它。
 * 那时输出文案会点破「进程没有退出，可能还在跑」——见 `stuck`。
 */
const KILL_HARD_DEADLINE_MS = 5_000
/**
 * 测试注入口（与本文件已有的 `ZUSE_TOOL_OUTPUT_DIR` 同款）：硬截止是 5 秒，
 * 不给注入口的话那条路径要么没测试、要么每次门禁多花 5 秒。
 */
function killHardDeadlineMs(): number {
  const v = Number(process.env.ZUSE_BASH_KILL_DEADLINE_MS)
  return Number.isFinite(v) && v > 0 ? v : KILL_HARD_DEADLINE_MS
}
/** 默认超时（毫秒）。 */
const DEFAULT_TIMEOUT = 120_000
/** 超时上限（毫秒）。 */
const MAX_TIMEOUT = 600_000
/**
 * 合并输出的字符预算(让输出有界),head+tail 分配(Phase 9 输出整形)。
 * 尾重头轻:coding agent 的高频场景是跑测试/构建,失败摘要与报错堆栈都在尾部;
 * 头部留够看命令回显与早期输出即可。完整输出落盘见 spillDir()。
 */
const HEAD_CHARS = 10_000
const TAIL_CHARS = 20_000

/** 截断时完整输出的落盘目录(测试经 ZUSE_TOOL_OUTPUT_DIR 注入临时目录)。 */
function spillDir(cwd: string): string {
  return process.env.ZUSE_TOOL_OUTPUT_DIR ?? path.join(cwd, '.zuse', 'tool-output')
}

/**
 * 预热登录 shell 环境快照（记忆化,进程内仅首次真正构建）。TUI 启动时调用一次,
 * 把 ≤10s 的首次构建挪离首条命令路径；BashTool.run 也会 await 它确保就绪。
 * label 为 bash/zsh（Windows git-bash 或 POSIX 用户 $SHELL）时真正建快照,
 * 其余（/bin/sh、pwsh、cmd）返回 null（降级,见 shell-snapshot.ts）。
 */
export function primeShellSnapshot(): Promise<string | null> {
  return ensureShellSnapshot(resolvedShell(), getShellLabel())
}

/** cwd 捕获临时文件名的去重序号（同进程内多次调用不撞名）。 */
let cwdCaptureSeq = 0

/**
 * 为命令构造"执行后把工作目录写入临时文件"的包装,实现 cd 跨命令持久化。
 * 仅 bash/zsh/sh 支持（POSIX 的 bash/zsh/sh,以及 Windows 上的 git-bash）——这些
 * shell 才有稳定的 `pwd`/`$?`/`exit` 语义和反斜杠转义别名。pwsh / cmd 返回 null：
 * 这些 shell 下 cd 不跨命令保留（v1 取舍,绝大多数开发机要么是 POSIX,要么装了 git）。
 *
 * 末尾用 `;` 无条件捕获 pwd（即便命令失败也记录最终目录,如 `cd a && false` 仍保留
 * cd）,并 `exit $?` 透传原命令退出码 —— 否则退出码会被 pwd 的 0 覆盖,掩盖失败。
 *
 * Windows git-bash 用 `pwd -W` 输出 `C:/...` 形式（Node 可直接当 cwd 用）,而非
 * `pwd -P` 的 cygwin `/c/...`（Node 不认）。POSIX 一律 `pwd -P`。
 */
function buildCwdCapture(command: string, snapshot: string | null): { exec: string; file: string } | null {
  const label = getShellLabel()
  if (label !== 'bash' && label !== 'zsh' && label !== 'sh') return null
  const file = path.join(tmpdir(), `zuse-cwd-${process.pid}-${cwdCaptureSeq++}`)
  // git-bash 重定向用正斜杠路径最稳；POSIX 上 replace 无副作用。
  const redirect = file.replace(/\\/g, '/')
  // 反斜杠前缀绕过用户经快照 source 进来的 pwd alias —— 否则 `\pwd -W` 可能被改写,破坏 cwd 捕获。
  const pwdCmd = process.platform === 'win32' ? '\\pwd -W' : '\\pwd -P'
  // 命令前先 source 登录 shell 快照（仅 bash 有,sh/降级时为 null）。2>/dev/null 吞掉
  // 快照内部噪音,不污染用户命令输出。source 不含 cd,不影响 cwd。
  const prefix = snapshot ? `source '${snapshot}' 2>/dev/null\n` : ''
  const exec = `${prefix}${command}\n__zuse_ec=$?; ${pwdCmd} 1>'${redirect}' 2>/dev/null; exit $__zuse_ec`
  return { exec, file }
}

/** 读取捕获文件里的新 cwd 并回写 ctx；无论成败都清理临时文件。 */
function applyCapturedCwd(file: string, setCwd: ((p: string) => void) | undefined): void {
  try {
    if (setCwd && existsSync(file)) {
      const captured = readFileSync(file, 'utf8').trim()
      if (captured && path.isAbsolute(captured)) setCwd(captured)
    }
  } catch {
    // 捕获失败不影响命令结果 —— cwd 维持原值即可。
  } finally {
    try {
      unlinkSync(file)
    } catch {
      // 临时文件可能从未创建（命令在写入前就退出）；忽略。
    }
  }
}

interface BashInput {
  command: string
  timeout?: number
  description?: string
}

const inputSchema: JSONSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description:
        'The shell command to run. Executed via the system shell in the working directory.',
    },
    timeout: {
      type: 'number',
      description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT}.`,
    },
    // 对齐 cc-haha：让模型给出一句简短描述，UI 在标题行展示(无则回落到命令本身)。
    description: {
      type: 'string',
      description:
        'Clear, concise description of what this command does in active voice, in 5-10 words. ' +
        "Never use words like \"complex\" or \"risk\" — just describe what it does.",
    },
  },
  required: ['command'],
}

/**
 * BashTool —— 通过系统 shell 跑一次性命令，仿照 Claude Code 的 BashTool。
 * 支持 cwd（ctx.cwd）、超时(到点 kill)、长输出截断、以及 ctx.signal 中断
 * （为 Ctrl+C 铺路）。非零退出/超时以 isError 回喂（故障模式④）。
 * 注：Windows 下 child.kill() 杀子进程树有局限，超时未必能终结所有孙进程。
 */
export const BashTool: Tool = {
  name: 'Bash',
  description:
    'Run a shell command and return its combined stdout/stderr and exit code. ' +
    'Use for one-off commands (builds, tests, git). Long output keeps its head and tail ' +
    '(the full output is saved to a file referenced in the result); commands time out.\n' +
    'IMPORTANT guidelines:\n' +
    '- Prefer dedicated tools over Bash when one fits: Read (not cat/head/tail), ' +
    'Edit (not sed/awk), Glob (not find/ls), Grep (not grep/rg).\n' +
    '- Do NOT use interactive commands (git rebase -i, npm init without -y, etc.).\n' +
    '- Do NOT prefix commands with `cd` — the working directory is already set.\n' +
    '- Always quote file paths containing spaces with double quotes.',
  inputSchema,
  specifierFor: (input: unknown): string | null => {
    // 返回 shell 命令字符串作为限定符；无则 null。
    const c = (input as { command?: unknown }).command
    return typeof c === 'string' ? c : null
  },

  // 权限校验由 agent 循环在调用 run 之前统一过闸（见 core 的 gateAndRunTool /
  // permission.decide,Bash 复合命令会逐子命令校验）,本工具只管执行。
  async run(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = (rawInput ?? {}) as BashInput
    if (!input.command || typeof input.command !== 'string') {
      return { output: 'Bash requires a command.', isError: true }
    }

    const timeout = Math.min(input.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT)
    // 取登录 shell 快照（记忆化,仅首次构建；非 bash/失败时为 null,命令照旧）。
    const snapshot = await primeShellSnapshot()

    // tmux 套接字隔离：命令调用 tmux 时，先就绪 zuse 专属套接字，再把 TMUX 注入子进程环境
    // 覆盖用户原值 —— 模型的 `tmux` 命令只动 zuse 自己的 server，碰不到用户会话（见 tmux-isolation）。
    // 不碰 tmux 的命令完全不触发，零开销；探测不到 tmux 时优雅降级。
    if (isTmuxCommand(input.command)) await ensureTmuxSocket()
    const tmuxEnv = getZuseTmuxEnv()
    const childEnv = buildChildEnv(tmuxEnv)

    return new Promise<ToolResult>((resolvePromise) => {
      // 命令执行后捕获工作目录,让 cd 跨命令持久化（仅 bash/sh；其余 shell 为 null）。
      const capture = buildCwdCapture(input.command, snapshot)
      // 经选定的 shell 起子进程（shell 选型 / detached 见 proc/spawn.ts）。
      // childEnv 为 undefined 时不传 env → 继承 process.env（不影响非 tmux 命令）。
      const child = spawnShellCommand(capture ? capture.exec : input.command, {
        cwd: ctx.cwd,
        env: childEnv,
      })

      let timedOut = false
      let aborted = false

      // 输出整形(Phase 9):head+tail 流式塑形,内存恒有界(刷屏命令如 `yes`/
      // `cat 大文件` 不会撑爆进程);截断时完整输出落盘,模型可用 Read/Grep 续查。
      const shaper = new StreamShaper({
        headChars: HEAD_CHARS,
        tailChars: TAIL_CHARS,
        spill: { dir: spillDir(ctx.cwd), prefix: 'bash' },
      })
      const append = (text: string): void => shaper.append(text)

      // 跨 chunk 的 UTF-8 解码 + Windows 原始字节留存（供收尾时 OEM 重解码），
      // 见 proc/output.ts。OEM 代码页在此惰性解析、进程内记忆化，检测成本不落在 server 启动路径。
      const decoder = new ProcOutputDecoder()
      // **这两条监听必须同步挂在 spawn 之后，而且绝不能给流加 pause()/背压。**
      // 收尾判据（proc/settle.ts）成立的前提是消费者一直 flowing：node 在 emit 'exit'
      // **之后**才强制冲刷 stdio，不 flowing 的话那一冲的字节落在 exit 之后 —— 而我们
      // 那时已经收尾了，输出会**静默丢一截**。
      child.stdout.on('data', (chunk: Buffer) => { append(decoder.writeStdout(chunk)) })
      child.stderr.on('data', (chunk: Buffer) => { append(decoder.writeStderr(chunk)) })

      /**
       * 杀之后的**硬截止**。
       *
       * 病根是「收尾寄托在一个可能永不到达的事件上」：超时定时器只置标志 + killTree，
       * 自己不 resolve。收尾改判 `exit` 之后，「孙进程握管道」那一类已经解决了；
       * 但一个**扛得住 taskkill 的前台进程**照样让这个 promise 永远挂着 ——
       * 实测过一次 15 秒硬闸到点仍未 resolve（timeout 参数只有 2000ms）。
       *
       * 所以杀完再挂一条无条件的退路。取 5 秒：比 run 那边的两段 grace（3s+3s）短，
       * 因为这里没有升级重杀那一步，等下去也不会有转机。
       */
      let hardTimer: ReturnType<typeof setTimeout> | null = null
      let gaveUp = false
      let orphanNote = ''
      // 在下面赋值 —— 硬截止（可能先跑）要用它，所以声明提到这里。
      let settleHandle: { stopNow(): void }
      const armHardDeadline = (): void => {
        if (hardTimer !== null) return
        hardTimer = setTimeout(() => {
          gaveUp = true
          // **必须先停止收集，再组装。** 只 resolve 不停收集的话，进程还在刷屏，
          // `shaper.append` 继续被调 —— 而 `finalize()` 之后再 append 会
          // **新开一个永远不会被关闭的 spill 文件**（实测：finalize 后继续灌 1MB，
          // 目录里多出第二个文件并一直长）。那正好是这个 bug 自己列的危害之一，
          // 修了主路却在兜底路上原样留着。
          settleHandle.stopNow()
          // 走和正常收尾同一条组装路径，别在这里另写一套输出拼接 —— 那必然和主路分叉。
          settleNow(null, null)
        }, killHardDeadlineMs())
      }

      const timer = setTimeout(() => {
        timedOut = true
        killTree(child.pid)
        armHardDeadline()
      }, timeout)

      // ctx.signal 中断 -> kill 进程树（Ctrl+C 铺路）。
      const onAbort = (): void => {
        aborted = true
        killTree(child.pid)
        armHardDeadline()
      }
      ctx.signal.addEventListener('abort', onAbort, { once: true })

      const finish = (result: ToolResult): void => {
        clearTimeout(timer)
        if (hardTimer !== null) clearTimeout(hardTimer)
        ctx.signal.removeEventListener('abort', onAbort)
        resolvePromise(result)
      }

      child.on('error', (err) => {
        finish({ output: `Failed to spawn command: ${err.message}`, isError: true })
      })

      /**
       * 收尾改判 `exit`，不再是 `close` —— 见 `proc/settle.ts` 的文件头。
       *
       * `close` 的语义是「进程退出 **且** 所有管道都关了」，而管道由**所有持有写端的
       * 进程**决定，包括继承了同一根 stdout 的孙进程。`node x.js & echo done`
       * 这类命令前台秒退、孙进程握着不放，close **永不到达** —— 而 `finish()` 原来
       * 只挂在 close 上，超时定时器又不自己 resolve，于是整个工具调用**永不返回**
       *（实测：timeout=2000ms 的调用 15 秒硬闸到点仍挂着），
       * 期间 StreamShaper 的 spill 文件还在无上界地长。
       */
      let settled = false
      const settleNow = (code: number | null, signal: NodeJS.Signals | null): void => {
        // **幂等闸。** 硬截止到点之后进程若真的退了，helper 的回调还会来一次 ——
        // 不挡的话会第二次 `applyCapturedCwd`（在工具**已经返回之后**改会话 cwd）
        // 和第二次 `finalize()`（再开一个 spill 文件）。
        if (settled) return
        settled = true
        // 冲刷 decoder 里可能缓着的尾字节（已封顶则丢弃）。
        append(decoder.endStdout())
        append(decoder.endStderr())
        // 回写命令执行后的工作目录（cd 持久化）。即便超时/中断也读一次：进程被杀前
        // 可能已写入,读到就用,读不到自然跳过。
        if (capture) applyCapturedCwd(capture.file, ctx.setCwd)
        const shaped = shaper.finalize()
        let body = shaped.body
        // Windows OEM fallback: if UTF-8 decoding densely corrupted the output, re-decode the raw
        // bytes in the OEM codepage and re-shape (same head/tail + spill contract).
        const oem = decoder.redecodeOem(body)
        if (oem !== null) {
          // The mojibake shaping may have already spilled a garbage file; drop it before the reshaper
          // spills the correctly-decoded one, so we don't orphan it on disk.
          if (shaped.spillPath) { try { unlinkSync(shaped.spillPath) } catch { /* best-effort cleanup */ } }
          const reshaper = new StreamShaper({ headChars: HEAD_CHARS, tailChars: TAIL_CHARS, spill: { dir: spillDir(ctx.cwd), prefix: 'bash' } })
          reshaper.append(oem)
          body = reshaper.finalize().body
        }
        // 硬截止到点 = 杀了但进程没退。必须点破：否则模型看到「timed out」会以为
        // 进程已经没了，接着去改文件 / 重跑，而那个进程还在占端口、占锁、写盘。
        const stuck = gaveUp
          ? `\n[the process did not exit after being killed — it may still be running; check for leftover processes]`
          : ''
        if (timedOut) {
          // 错误回传契约(Phase 8):timeout 是模型自己可调的入参,点给它。
          finish({
            output: `${body}\n[timed out after ${timeout}ms; partial output above. Increase the timeout parameter for long-running commands]${stuck}`,
            isError: true,
          })
        } else if (aborted) {
          finish({ output: `${body}\n[interrupted]${stuck}`, isError: true })
        } else if (code === null) {
          // code 为 null 表示被信号杀死（段错误、被外部 kill 等），真正原因在 signal。
          finish({ output: `${body}\n[killed by signal: ${signal}]`, isError: true })
        } else if (code === 127) {
          // 127 = POSIX/git-bash 的"command not found",高频失因,点破并给下一步。
          // 其余非零码不猜原因——stderr 已在 body 里,模型自己读。
          finish({
            output: `${body}\n[exit code: 127 — command not found. Check the spelling, install it, or use an absolute path]`,
            isError: true,
          })
        } else if (code !== 0) {
          finish({ output: `${body}\n[exit code: ${code}]${orphanNote}`, isError: true })
        } else {
          finish({ output: (body === '' ? '(no output)' : body) + orphanNote, isError: false })
        }
      }

      // drainMs 在 `exit` 事件里求值 —— 所以这里能按「是不是被我们杀的」给不同的值。
      settleHandle = onChildSettled(
        child,
        { drainMs: () => (timedOut || aborted ? KILLED_DRAIN_MS : DRAIN_MS) },
        (r) => {
          // `drained:false` = 进程退了但管道还被别人握着 = **有东西还在后台跑**。
          // 不说的话用户看到的是「成功、退出码 0」，而那个 server 还占着端口。
          // 「刻意选的代价」也得是用户知道的代价。
          if (!r.drained) orphanNote = '\n[the command exited, but something it started is still running and holding the output pipe]'
          settleNow(r.code, r.signal)
        },
      )
    })
  },
}

export const toolModule = { make: () => BashTool } satisfies import('./tool-module.js').ToolModule
