import { spawn } from 'node:child_process'
import type { Tool, ToolContext, ToolResult, JSONSchema } from '@zuse/core'
import { LANGUAGE_SERVERS } from './servers.js'
import { findOnPath } from '../util.js'

/**
 * 执行安装命令的注入点:跑一条 argv,返回退出码与合并输出(stdout+stderr)。
 * 抽成可注入的 seam 是为了让工具逻辑可纯测 —— 单测注入假 runner,绝不真跑全局安装。
 */
export type InstallRunner = (
  cmd: string[],
  cwd: string,
  signal: AbortSignal,
) => Promise<{ code: number; output: string }>

/**
 * 默认 runner:先确认包管理器在 PATH 上(本机没装 npm 时给清晰错误,不必等 spawn 的 ENOENT),
 * 再 spawn 执行并捕获输出。Windows 上 npm 是 npm.cmd —— 裸名 spawn 不套 PATHEXT 会 ENOENT,
 * 故 win32 走 shell(cmd.exe)按 PATHEXT 解析(与 LspClient 同款思路)。
 */
const defaultRunner: InstallRunner = (cmd, cwd, signal) =>
  new Promise((resolve) => {
    const [exe, ...rest] = cmd
    if (!exe) {
      resolve({ code: 127, output: 'empty install command' })
      return
    }
    if (!findOnPath(exe)) {
      resolve({ code: 127, output: `'${exe}' not found on PATH —— 请先安装它,或手动执行该命令` })
      return
    }
    const useShell = process.platform === 'win32'
    // shell:true 下命令与参数以空格拼成一行交给 cmd,含空格的参数需自行加引号免被拆断。
    const args = useShell ? rest.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : rest
    let out = ''
    const child = spawn(exe, args, { cwd, shell: useShell })
    const onData = (b: Buffer): void => {
      out += b.toString()
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const onAbort = (): void => {
      child.kill()
    }
    if (signal.aborted) child.kill()
    else signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e: Error) => {
      signal.removeEventListener('abort', onAbort)
      resolve({ code: 127, output: `${exe} failed: ${e.message}` })
    })
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort)
      resolve({ code: code ?? 0, output: out.trim() })
    })
  })

/** LspInstall 工具的输入字段。 */
interface LspInstallInput {
  lang?: string
}

const inputSchema: JSONSchema = {
  type: 'object',
  properties: {
    lang: {
      type: 'string',
      enum: LANGUAGE_SERVERS.map((c) => c.id),
      description:
        "Language id whose language server to install (e.g. 'typescript', 'python'). " +
        'Only languages with a one-line installer are supported.',
    },
  },
  required: ['lang'],
}

/**
 * LspInstall 工具:为某门语言安装其语言服务器二进制,好让 Lsp 工具能用。
 *
 * 故意 readOnly:false —— 这样它会进权限闸,执行前由用户确认(这正是「是否安装」那一问),
 * 且安装命令明文展示在权限框里。两个触发场景都认:① Lsp 报「server 没装」后;② 用户主动说「帮我装」。
 *
 * 仅支持配置里带 installCommand 的语言(v1:npm 系的 typescript/python/vue/bash);
 * 其余(java/lua/rust/go)婉拒并回显手动提示,让模型回退 Grep。只装语言服务器本身,
 * 绝不碰 JDK/Maven/工具链等系统级前置依赖。
 */
export function createLspInstallTool(run: InstallRunner = defaultRunner): Tool {
  return {
    name: 'LspInstall',
    description:
      'Install the language server binary for a given language so the Lsp tool can work. ' +
      'Use this when Lsp reports the server is not installed, OR when the user explicitly asks to install a language server. ' +
      'The user is asked to confirm before anything runs. ' +
      'Supported only for languages with a known one-line installer (currently npm-based: typescript, python, vue, bash); ' +
      'for others it returns a manual hint — fall back to Grep then. ' +
      'It installs only the language server itself, never system prerequisites like a JDK, Go toolchain, or Maven.',
    inputSchema,
    readOnly: false,

    // 返回 lang 作为权限规则限定符,支持按语言精确放行/拒绝(如 LspInstall(typescript))。
    specifierFor: (input: unknown): string | null => {
      const l = (input as LspInstallInput).lang
      return typeof l === 'string' ? l : null
    },
    // 语言 id（`typescript` / `go`）不是路径。
    specifierKind: 'opaque',

    async run(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
      const input = (rawInput ?? {}) as LspInstallInput
      if (!input.lang) return { output: 'LspInstall requires a lang.', isError: true }

      const config = LANGUAGE_SERVERS.find((c) => c.id === input.lang)
      if (!config) return { output: `LspInstall: unknown lang '${input.lang}'.`, isError: true }

      // 没有可自动执行的安装命令(java/lua/rust/go):婉拒并回显手动提示,不跑任何东西。
      if (!config.installCommand) {
        return {
          output: `Cannot auto-install the ${config.id} language server. Install it manually: ${config.installHint}`,
          isError: true,
        }
      }

      if (ctx.signal.aborted) return { output: 'LspInstall cancelled.', isError: true }

      const cmdStr = config.installCommand.join(' ')
      const { code, output } = await run(config.installCommand, ctx.cwd, ctx.signal)
      if (code === 0) {
        return {
          output: `Installed the ${config.id} language server (${cmdStr}). Retry the Lsp query now.`,
          isError: false,
        }
      }
      return {
        output: `Failed to install the ${config.id} language server (${cmdStr}), exit ${code}:\n${output}`,
        isError: true,
      }
    },
  }
}

export const toolModule = {
  make: () => createLspInstallTool(),
  enabled: (o) => !!o.lsp,
} satisfies import('../tool-module.js').ToolModule
