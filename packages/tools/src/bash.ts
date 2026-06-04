import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { Tool, ToolContext, ToolResult, JSONSchema } from '@zuse/core'

/** 默认超时（毫秒）。 */
const DEFAULT_TIMEOUT = 120_000
/** 超时上限（毫秒）。 */
const MAX_TIMEOUT = 600_000
/** 合并输出的字符上限（让输出有界）。 */
const MAX_OUTPUT = 30_000

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
 * 杀掉整棵进程树。`shell: true` 下 child 是 shell（Windows 上是 cmd.exe），
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
        shell: true,
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
