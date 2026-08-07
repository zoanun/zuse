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
} from './proc/index.js'

// 对外 API 保持原样：这三个符号历史上就从 bash.ts 导出（index.ts 与既有测试都按此引入），
// 抽层不改对外形态，故在此原样转出。
export { buildChildEnv, getShellLabel, redecodeOemIfMojibake }

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
      child.stdout.on('data', (chunk: Buffer) => { append(decoder.writeStdout(chunk)) })
      child.stderr.on('data', (chunk: Buffer) => { append(decoder.writeStderr(chunk)) })

      const timer = setTimeout(() => {
        timedOut = true
        killTree(child.pid)
      }, timeout)

      // ctx.signal 中断 -> kill 进程树（Ctrl+C 铺路）。
      const onAbort = (): void => {
        aborted = true
        killTree(child.pid)
      }
      ctx.signal.addEventListener('abort', onAbort, { once: true })

      const finish = (result: ToolResult): void => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        resolvePromise(result)
      }

      child.on('error', (err) => {
        finish({ output: `Failed to spawn command: ${err.message}`, isError: true })
      })

      child.on('close', (code, signal) => {
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
        if (timedOut) {
          // 错误回传契约(Phase 8):timeout 是模型自己可调的入参,点给它。
          finish({
            output: `${body}\n[timed out after ${timeout}ms; partial output above. Increase the timeout parameter for long-running commands]`,
            isError: true,
          })
        } else if (aborted) {
          finish({ output: `${body}\n[interrupted]`, isError: true })
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
          finish({ output: `${body}\n[exit code: ${code}]`, isError: true })
        } else {
          finish({ output: body === '' ? '(no output)' : body, isError: false })
        }
      })
    })
  },
}

export const toolModule = { make: () => BashTool } satisfies import('./tool-module.js').ToolModule
