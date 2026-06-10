import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Tool, ToolContext, ToolResult, JSONSchema } from '@zuse/core'
import { findOnPath, killTree } from './util.js'
import { ensureShellSnapshot } from './shell-snapshot.js'
import { ensureTmuxSocket, getZuseTmuxEnv, isTmuxCommand } from './tmux-isolation.js'

/** 默认超时（毫秒）。 */
const DEFAULT_TIMEOUT = 120_000
/** 超时上限（毫秒）。 */
const MAX_TIMEOUT = 600_000
/** 合并输出的字符上限（让输出有界）。 */
const MAX_OUTPUT = 30_000

/** git-bash 相对 Git 安装根目录的两种固定布局。 */
function gitBashUnder(root: string): string | undefined {
  for (const rel of ['bin\\bash.exe', 'usr\\bin\\bash.exe']) {
    const p = path.join(root, rel)
    if (existsSync(p)) return p
  }
  return undefined
}

/**
 * 解析 Bash 工具实际使用的 shell。
 *
 * POSIX：优先用户登录 shell（$SHELL，通常 /bin/bash 或 /bin/zsh）。不直接用
 * spawn 的 shell:true（那会落到 /bin/sh，多为 dash）—— 用户的 alias、shell 函数、
 * rc 注入的 PATH 都只存在于其登录 shell 里；/bin/sh 既看不到这些、也没有
 * declare -f / 别名展开能力，登录 shell 快照（见 shell-snapshot.ts）就无从建立。
 * $SHELL 须是 bash/zsh 才取（这两类快照已支持）；否则按序探测常见安装路径，
 * 都不可用才回退 shell:true（/bin/sh），此时快照优雅降级、命令仍照常执行。
 *
 * Windows 上 shell:true 会落到 cmd.exe —— 没有 pwd/ls，而模型几乎总按 Unix 习惯
 * 出命令，于是频繁 "'pwd' is not recognized"。所以优先找 git-bash，让 Unix 命令
 * （含 && / ; / | 等分隔符）跨平台一致可用；没有 git-bash 退到 pwsh7，再不行才回退 cmd.exe。
 *
 * 不直接在 PATH 上搜 bash.exe：那样会误抓 System32 的 WSL bash 或 WindowsApps
 * 的商店占位，二者路径语义与 git-bash 完全不同。改为定位 PATH 上的 git.exe 再
 * 反推 git-bash —— git 几乎总在开发者 PATH 上，且兼容任意安装位置（不限 Program Files）。
 *
 * 没有 git-bash 时退一步找 pwsh.exe（PowerShell 7+）：它的 && / || / ; / | 都支持，
 * 且 pwd/ls/cd/cat 有别名，比 cmd 更接近 Unix 习惯。注意只认 pwsh.exe，不认
 * powershell.exe —— 后者是系统自带的 Windows PowerShell 5.1，恰恰不支持 && / ||
 * （5.1 会解析报错），回退到它反而会弄坏模型最常出的 `a && b` 命令链，还不如 cmd。
 * 两者都没有才回退 cmd.exe（始终存在、支持 &&、且 Node spawn 对它有特殊处理最稳）。
 *
 * 可用 ZUSE_SHELL 环境变量显式覆盖（两平台通用）。路径在进程生命周期内不变，
 * 模块加载时解析一次即可。
 */
function resolveShell(): string | true {
  if (process.env.ZUSE_SHELL && existsSync(process.env.ZUSE_SHELL)) return process.env.ZUSE_SHELL
  if (process.platform !== 'win32') {
    // 用户登录 shell 优先（仅取 bash/zsh，快照已支持这两类）。
    const login = process.env.SHELL
    if (login && /(?:bash|zsh)$/.test(login) && existsSync(login)) return login
    // $SHELL 缺失/不是 bash/zsh 时，按序探测常见安装路径。
    for (const p of ['/bin/bash', '/usr/bin/bash', '/bin/zsh', '/usr/bin/zsh']) {
      if (existsSync(p)) return p
    }
    return true // 回退 /bin/sh，快照随之降级
  }
  const git = findOnPath('git.exe')
  if (git) {
    // git 可能在 <root>\cmd\git.exe、<root>\bin\git.exe 或 <root>\mingw64\bin\git.exe，
    // 各自到 Git 根目录的层级不同 —— 从 git.exe 所在目录逐级上溯，命中即止。
    let dir = path.dirname(git)
    for (let i = 0; i < 4; i++) {
      const bash = gitBashUnder(dir)
      if (bash) return bash
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  // 标准安装位置兜底（git 不在 PATH 时）。
  for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe']) {
    if (existsSync(p)) return p
  }
  // 没有 git-bash：优先 PowerShell 7+（pwsh.exe），不行才回退 cmd.exe。
  const pwsh = findOnPath('pwsh.exe')
  if (pwsh) return pwsh
  return true // 回退 cmd.exe
}

/** 模块加载时解析一次；spawn 与 getShellLabel 共用同一结果。 */
const SHELL: string | true = resolveShell()

/**
 * 当前 Bash 工具实际使用的 shell 的人类可读标签，供系统提示词的环境块使用，
 * 让模型按真实 shell（bash / pwsh / cmd.exe / sh）出命令，而不是凭训练惯性瞎猜。
 */
export function getShellLabel(): string {
  if (SHELL === true) return process.platform === 'win32' ? 'cmd.exe' : 'sh'
  // zsh 在 bash 之前判：避免 "/usr/bin/zsh" 这类路径里万一含子串时误判（且语义独立）。
  if (/zsh/i.test(SHELL)) return 'zsh'
  if (/bash/i.test(SHELL)) return 'bash'
  if (/pwsh/i.test(SHELL)) return 'pwsh'
  return SHELL
}

/**
 * 预热登录 shell 环境快照（记忆化,进程内仅首次真正构建）。TUI 启动时调用一次,
 * 把 ≤10s 的首次构建挪离首条命令路径；BashTool.run 也会 await 它确保就绪。
 * label 为 bash/zsh（Windows git-bash 或 POSIX 用户 $SHELL）时真正建快照,
 * 其余（/bin/sh、pwsh、cmd）返回 null（降级,见 shell-snapshot.ts）。
 */
export function primeShellSnapshot(): Promise<string | null> {
  return ensureShellSnapshot(SHELL, getShellLabel())
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
    'Use for one-off commands (builds, tests, git). Long output is truncated; commands time out.',
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
    const childEnv = tmuxEnv ? { ...process.env, TMUX: tmuxEnv } : undefined

    return new Promise<ToolResult>((resolvePromise) => {
      // 命令执行后捕获工作目录,让 cd 跨命令持久化（仅 bash/sh；其余 shell 为 null）。
      const capture = buildCwdCapture(input.command, snapshot)
      // POSIX 下 detached 让 child 成为进程组组长，killTree 才能用负 pid 杀整组。
      const child = spawn(capture ? capture.exec : input.command, {
        cwd: ctx.cwd,
        shell: SHELL,
        detached: process.platform !== 'win32',
        // tmuxEnv 为空时传 undefined → 继承 process.env（不影响非 tmux 命令）。
        ...(childEnv ? { env: childEnv } : {}),
      })

      let output = ''
      let outputTruncated = false
      let timedOut = false
      let aborted = false

      // 累加时即时封顶：到上限就停止追加，内存恒为 ~MAX_OUTPUT，而不是把整条流
      // 都堆进内存、最后才截断（刷屏命令如 `yes`/`cat 大文件` 会先把进程撑爆）。
      const append = (text: string): void => {
        if (outputTruncated || text === '') return
        if (output.length + text.length > MAX_OUTPUT) {
          output += text.slice(0, MAX_OUTPUT - output.length)
          outputTruncated = true
        } else {
          output += text
        }
      }

      // 每条流各用一个 StringDecoder：多字节 UTF-8 码点跨 chunk 边界时，decoder 会
      // 缓存半个字符等下一块，避免 chunk.toString() 各自解码造成的乱码（中文/emoji）。
      const outDecoder = new StringDecoder('utf8')
      const errDecoder = new StringDecoder('utf8')
      child.stdout.on('data', (chunk: Buffer) => append(outDecoder.write(chunk)))
      child.stderr.on('data', (chunk: Buffer) => append(errDecoder.write(chunk)))

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
        append(outDecoder.end())
        append(errDecoder.end())
        // 回写命令执行后的工作目录（cd 持久化）。即便超时/中断也读一次：进程被杀前
        // 可能已写入,读到就用,读不到自然跳过。
        if (capture) applyCapturedCwd(capture.file, ctx.setCwd)
        const body = outputTruncated
          ? output + `\n…[truncated: output exceeded ${MAX_OUTPUT} chars]`
          : output
        if (timedOut) {
          finish({ output: `${body}\n[timed out after ${timeout}ms]`, isError: true })
        } else if (aborted) {
          finish({ output: `${body}\n[interrupted]`, isError: true })
        } else if (code === null) {
          // code 为 null 表示被信号杀死（段错误、被外部 kill 等），真正原因在 signal。
          finish({ output: `${body}\n[killed by signal: ${signal}]`, isError: true })
        } else if (code !== 0) {
          finish({ output: `${body}\n[exit code: ${code}]`, isError: true })
        } else {
          finish({ output: body === '' ? '(no output)' : body, isError: false })
        }
      })
    })
  },
}
