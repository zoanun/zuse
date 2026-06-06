import { readFileSync } from 'node:fs'
import { resolvePath, type Tool, type ToolContext, type ToolResult, type JSONSchema } from '@zuse/core'
import { lookupLanguage } from './servers.js'
import { locateSymbol } from './symbol.js'
import { formatDefinition, formatReferences, formatHover, type LineReader } from './format.js'
import { LspError } from './client.js'
import type { LspManager } from './manager.js'

// references 输出最多展示 100 条，超出截断并提示
const REFERENCES_LIMIT = 100

/** Lsp 工具的输入字段（来自模型 JSON 调用）。 */
interface LspInput {
  operation?: 'definition' | 'references' | 'hover'
  file?: string
  symbol?: string
  line?: number
}

// 工具对模型暴露的 JSON Schema 描述
const inputSchema: JSONSchema = {
  type: 'object',
  properties: {
    operation: {
      type: 'string',
      enum: ['definition', 'references', 'hover'],
      description:
        "Which query: 'definition' jumps to where the symbol is defined; 'references' lists all uses; 'hover' shows its type/signature/doc.",
    },
    file: { type: 'string', description: 'Path to the source file containing the symbol.' },
    symbol: { type: 'string', description: 'The identifier to look up (e.g. a function or variable name).' },
    line: {
      type: 'number',
      description: 'Optional 1-based line number to disambiguate when the symbol appears multiple times.',
    },
  },
  required: ['operation', 'file', 'symbol'],
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
      "Look up a symbol's definition, find all references, or get its type/hover info. " +
      'Give the file, the symbol name, and optionally a 1-based line to disambiguate.',
    inputSchema,
    readOnly: true,

    // 返回文件路径供规则限定符匹配
    specifierFor: (input: unknown): string | null => {
      const f = (input as LspInput).file
      return typeof f === 'string' ? f : null
    },

    async run(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
      // 字段完整性校验：operation / file / symbol 三项必填
      const input = (rawInput ?? {}) as LspInput
      if (!input.operation || !input.file || !input.symbol) {
        return { output: 'Lsp requires operation, file, and symbol.', isError: true }
      }

      // 用户取消时快速返回
      if (ctx.signal.aborted) return { output: 'Lsp cancelled.', isError: true }

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

      // 固定 cwd（首次调用时）并取出该语言的 client
      manager.setCwd(ctx.cwd)
      const readLine = makeLineReader()
      try {
        const client = await manager.getClient(config, ctx.signal)
        // 首次访问该文件前发 didOpen，让服务器加载文件
        client.openDocument(abs, text)

        if (input.operation === 'definition') {
          const locs = await client.definition(abs, loc.position)
          return { output: formatDefinition(locs, ctx.cwd, readLine, input.symbol), isError: false }
        }
        if (input.operation === 'references') {
          const locs = await client.references(abs, loc.position)
          return {
            output: formatReferences(locs, ctx.cwd, readLine, REFERENCES_LIMIT, input.symbol),
            isError: false,
          }
        }
        // operation === 'hover'
        const hover = await client.hover(abs, loc.position)
        return { output: formatHover(hover, input.symbol), isError: false }
      } catch (e) {
        // 用户中途取消
        if (ctx.signal.aborted) return { output: 'Lsp cancelled.', isError: true }
        // 语言服务器错误（含「未安装」场景）
        if (e instanceof LspError) {
          return {
            output: e.installHint ? `${e.message}` : `Lsp error: ${e.message}`,
            isError: true,
          }
        }
        return { output: `Lsp error: ${(e as Error).message}`, isError: true }
      }
    },
  }
}
