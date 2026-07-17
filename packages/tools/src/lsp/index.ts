import { readFileSync } from 'node:fs'
import { resolvePath, type Tool, type ToolContext, type ToolResult, type JSONSchema } from '@zuse/core'
import { LANGUAGE_SERVERS, lookupLanguage, type LanguageServerConfig } from './servers.js'
import { locateSymbol } from './symbol.js'
import {
  formatDefinition,
  formatReferences,
  formatHover,
  formatSymbols,
  type LineReader,
} from './format.js'
import { LspError } from './client.js'
import { findSeedFiles } from './seed.js'
import { findOnPath } from '../util.js'
import type { LspManager } from './manager.js'

// references 输出最多展示 100 条，超出截断并提示
const REFERENCES_LIMIT = 100

/** Lsp 工具的输入字段（来自模型 JSON 调用）。 */
interface LspInput {
  operation?: 'definition' | 'references' | 'hover' | 'symbol'
  file?: string
  symbol?: string
  line?: number
  lang?: string
}

// 工具对模型暴露的 JSON Schema 描述
const inputSchema: JSONSchema = {
  type: 'object',
  properties: {
    operation: {
      type: 'string',
      enum: ['definition', 'references', 'hover', 'symbol'],
      description:
        "Which query: 'symbol' searches the whole project for a symbol by name (no file needed — use this when you don't yet know where the symbol lives); " +
        "'definition' jumps to where the symbol is defined; 'references' lists all uses; 'hover' shows its type/signature/doc. " +
        "definition/references/hover need 'file'; 'symbol' does not.",
    },
    file: {
      type: 'string',
      description:
        "Path to the source file containing the symbol. Required for definition/references/hover; for 'symbol' it is optional (only used to pick the language).",
    },
    symbol: { type: 'string', description: 'The identifier to look up (e.g. a function or variable name).' },
    line: {
      type: 'number',
      description: 'Optional 1-based line number to disambiguate when the symbol appears multiple times.',
    },
    lang: {
      type: 'string',
      enum: LANGUAGE_SERVERS.map((c) => c.id),
      description:
        "Optional language id for 'symbol' search when no file is given (e.g. 'typescript', 'python'). Defaults to the installed language server.",
    },
  },
  required: ['operation', 'symbol'],
}

/**
 * 为 symbol(workspace/symbol)操作选定语言服务器：
 * 给了 file → 按扩展名定；给了 lang → 按 id 定；都没给 → 取首个命令在 PATH 上的已装服务器，
 * 仍无 → 回落到首条配置（typescript），让 start() 凭其 installHint 快速失败给出安装提示。
 */
function pickSymbolConfig(input: LspInput): LanguageServerConfig | null {
  if (input.file) return lookupLanguage(input.file)
  if (input.lang) return LANGUAGE_SERVERS.find((c) => c.id === input.lang) ?? null
  return LANGUAGE_SERVERS.find((c) => findOnPath(c.command)) ?? LANGUAGE_SERVERS[0] ?? null
}

/**
 * 把异常归一为 ToolResult：取消优先；LspError 带 installHint 时原样回喂安装提示。
 * 若该语言可被 LspInstall 自动安装(配置里有 installCommand),额外引导模型走 LspInstall
 * (经用户确认);否则只留手动提示,让模型回退 Grep。
 */
function lspErrorResult(e: unknown, aborted: boolean, config?: LanguageServerConfig | null): ToolResult {
  if (aborted) return { output: 'Lsp cancelled.', isError: true }
  if (e instanceof LspError) {
    let msg = e.installHint ? e.message : `Lsp error: ${e.message}`
    if (e.installHint && config?.installCommand) {
      msg += `\nThis language can be auto-installed. Call LspInstall with lang="${config.id}" now — the user will be asked to confirm. Do NOT silently switch to Grep; only fall back to Grep if the user declines the install.`
    }
    return { output: msg, isError: true }
  }
  return { output: `Lsp error: ${(e as Error).message}`, isError: true }
}

/**
 * 按绝对路径构造一个「读第 line0 行（0-based）源码」的 LineReader。
 * 带文件级缓存，同一次工具调用内多次读同文件不重复 I/O。
 */
function makeLineReader(): LineReader {
  const cache = new Map<string, string[]>()
  return (absPath: string, line0: number): string => {
    // 未缓存则读文件并分行，读失败以空数组兜底
    let lines = cache.get(absPath)
    if (!lines) {
      try {
        lines = readFileSync(absPath, 'utf8').split('\n')
      } catch {
        lines = []
      }
      cache.set(absPath, lines)
    }
    // noUncheckedIndexedAccess：lines[line0] 可能 undefined，用 ?? '' 兜底
    return lines[line0] ?? ''
  }
}

/**
 * Lsp 工具：对项目代码做只读的定义跳转 / 找引用 / 悬停类型查询。
 * 需要会话级进程池 LspManager，用工厂闭包注入（对齐 createWebSearchTool）。
 * readOnly:true 使其不进权限闸。
 */
export function createLspTool(manager: LspManager): Tool {
  return {
    name: 'Lsp',
    description:
      'Read-only code intelligence over the project via a language server. ' +
      "Prefer this over Grep/Read when you need a symbol's definition, all its references, or its type/signature — " +
      'it resolves them semantically and exactly, whereas text search returns false matches ' +
      '(comments, substrings, unrelated same-named identifiers). ' +
      "When you don't yet know which file a symbol lives in (e.g. \"where/how is X defined?\"), " +
      "use operation 'symbol' with just the name — it searches the whole project, no file needed, " +
      'so you do NOT have to Grep for the file first. ' +
      "Once you have a file, use 'definition'/'references'/'hover' (give file, symbol, and optionally a 1-based line to disambiguate). " +
      'Supports TS/JS, Python, Vue, Java, Rust, Go, Lua, Bash. ' +
      "If the language server isn't installed it returns an install hint. When that hint says the language can be " +
      'auto-installed via LspInstall, you MUST call LspInstall first (the user confirms the install) rather than ' +
      'silently switching to Grep — fall back to Grep only if the user declines, or if no LspInstall option is offered.',
    inputSchema,
    readOnly: true,

    // 返回文件路径供规则限定符匹配
    specifierFor: (input: unknown): string | null => {
      const f = (input as LspInput).file
      return typeof f === 'string' ? f : null
    },

    async run(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
      // 字段完整性校验：operation 与 symbol 必填（file 仅 definition/references/hover 需要）
      const input = (rawInput ?? {}) as LspInput
      if (!input.operation || !input.symbol) {
        return { output: 'Lsp requires operation and symbol.', isError: true }
      }

      // 用户取消时快速返回
      if (ctx.signal.aborted) return { output: 'Lsp cancelled.', isError: true }

      manager.setCwd(ctx.cwd)
      const readLine = makeLineReader()

      // symbol：按符号名全工程搜索，不需要 file（冷查询的入口）
      if (input.operation === 'symbol') {
        const config = pickSymbolConfig(input)
        if (!config) return { output: 'Lsp: no language server configured.', isError: true }
        try {
          const client = await manager.getClient(config, ctx.signal)
          // workspace/symbol(navto)需要服务器已加载工程,否则 tsserver 抛 No Project,
          // 且 navto 只搜已加载的工程。先给每个工程播一个种子文件 didOpen:给了 file 用它,
          // 否则在 cwd 下为每个工程根(含 tsconfig 的目录)各挑一个代表性源文件 —— 多包仓库
          // 由此跨包命中。读不到的种子跳过(大不了回到原错误,模型再回退 Grep)。
          const seeds = input.file
            ? [resolvePath(ctx.cwd, input.file)]
            : await findSeedFiles(ctx.cwd, config.extensions, ctx.signal)
          for (const seed of seeds) {
            try {
              client.openDocument(seed, readFileSync(seed, 'utf8'))
            } catch {
              // 种子文件不可读:忽略这一个,继续其余
            }
          }
          const syms = await client.workspaceSymbol(input.symbol, ctx.signal)
          return {
            output: formatSymbols(syms, ctx.cwd, readLine, REFERENCES_LIMIT, input.symbol),
            isError: false,
          }
        } catch (e) {
          return lspErrorResult(e, ctx.signal.aborted, config)
        }
      }

      // definition / references / hover：需要 file
      if (!input.file) {
        return { output: `Lsp ${input.operation} requires a file.`, isError: true }
      }

      // 按文件扩展名查语言配置，不支持的类型直接返回错误
      const config = lookupLanguage(input.file)
      if (!config) {
        const exts = '.ts .tsx .js .jsx .py .vue .java .rs .go .lua .sh …'
        return {
          output: `Lsp: unsupported file type for ${input.file}. Supported: ${exts}`,
          isError: true,
        }
      }

      // 读取源文件内容（用于 didOpen 和 locateSymbol）
      const abs = resolvePath(ctx.cwd, input.file)
      let text: string
      try {
        text = readFileSync(abs, 'utf8')
      } catch (e) {
        return { output: `Lsp: cannot read ${input.file}: ${(e as Error).message}`, isError: true }
      }

      // 在文件内定位符号，找不到时返回错误
      const loc = locateSymbol(text, input.symbol, input.line)
      if (!loc) {
        return {
          output: input.line
            ? `Lsp: symbol '${input.symbol}' not found on line ${input.line} of ${input.file}.`
            : `Lsp: symbol '${input.symbol}' not found in ${input.file}.`,
          isError: true,
        }
      }

      try {
        const client = await manager.getClient(config, ctx.signal)
        // 首次访问该文件前发 didOpen，让服务器加载文件
        client.openDocument(abs, text)

        if (input.operation === 'definition') {
          const locs = await client.definition(abs, loc.position, ctx.signal)
          return { output: formatDefinition(locs, ctx.cwd, readLine, input.symbol), isError: false }
        }
        if (input.operation === 'references') {
          const locs = await client.references(abs, loc.position, ctx.signal)
          return {
            output: formatReferences(locs, ctx.cwd, readLine, REFERENCES_LIMIT, input.symbol),
            isError: false,
          }
        }
        // operation === 'hover'
        const hover = await client.hover(abs, loc.position)
        return { output: formatHover(hover, input.symbol), isError: false }
      } catch (e) {
        return lspErrorResult(e, ctx.signal.aborted, config)
      }
    },
  }
}

export const toolModule = {
  make: (o) => createLspTool(o.lsp!),
  enabled: (o) => !!o.lsp,
} satisfies import('../tool-module.js').ToolModule
