import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Tool, ToolContext, ToolResult, JSONSchema } from '@zuse/core'

/** 默认超时（毫秒）。 */
const DEFAULT_TIMEOUT = 120_000
/** 超时上限（毫秒）。 */
const MAX_TIMEOUT = 600_000
/** 合并输出的字符上限（让输出有界）。 */
const MAX_OUTPUT = 30_000

/** 在 PATH 列出的目录里找一个可执行文件，返回首个命中的绝对路径。 */
function findOnPath(exe: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const full = path.join(dir, exe)
    if (existsSync(full)) return full
  }
  return undefined
}

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
 * POSIX 直接交给系统默认 shell（spawn 的 shell:true → /bin/sh）。
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
 * 可用 ZUSE_SHELL 环境变量显式覆盖。路径在进程生命周期内不变，模块加载时解析一次即可。
 */
function resolveShell(): string | true {
  if (process.platform !== 'win32') return true
  if (process.env.ZUSE_SHELL && existsSync(process.env.ZUSE_SHELL)) return process.env.ZUSE_SHELL
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
  if (/bash/i.test(SHELL)) return 'bash'
  if (/pwsh/i.test(SHELL)) return 'pwsh'
  return SHELL
}

interface BashInput {
  command: string
  timeout?: number
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
  },
  required: ['command'],
}

/**
 * 杀掉整棵进程树。child 是 shell（Windows 上是 git-bash 或回退的 cmd.exe），
 * 真正干活的命令是它的子进程。只 child.kill() 会留下占着输出管道的孙进程，
 * 导致 close 事件迟迟不触发。Windows 用 taskkill /T 杀树，POSIX 杀进程组。
 */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'])
  } else {
    try {
      process.kill(-pid, 'SIGTERM') // 负 pid = 整个进程组
    } catch {
      process.kill(pid, 'SIGTERM')
    }
  }
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

  // TODO Phase 5: 执行前做权限校验（Bash 是高危工具）
  run(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = (rawInput ?? {}) as BashInput
    if (!input.command || typeof input.command !== 'string') {
      return Promise.resolve({ output: 'Bash requires a command.', isError: true })
    }

    const timeout = Math.min(input.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT)

    return new Promise<ToolResult>((resolvePromise) => {
      // POSIX 下 detached 让 child 成为进程组组长，killTree 才能用负 pid 杀整组。
      const child = spawn(input.command, {
        cwd: ctx.cwd,
        shell: SHELL,
        detached: process.platform !== 'win32',
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
