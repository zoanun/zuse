import { describe, it, expect } from 'vitest'
import { createFileTracker, type ToolContext } from '@zuse/core'
import { createLspTool } from './index.js'
import { LspManager } from './manager.js'

// 构造最小化 ToolContext，用于错误路径测试
function makeCtx(cwd = process.cwd()): ToolContext {
  return { cwd, signal: new AbortController().signal, tracker: createFileTracker() }
}

describe('Lsp tool — error paths', () => {
  // 注入一个永远报错的 starter，确认错误路径不会触发真实 LSP 启动
  const tool = createLspTool(new LspManager(async () => { throw new Error('should not start') }))

  it('is readOnly', () => {
    expect(tool.readOnly).toBe(true)
    expect(tool.name).toBe('Lsp')
  })

  it('errors on unsupported file type', async () => {
    // .docx 不在支持列表里，应返回错误
    const r = await tool.run({ operation: 'definition', file: 'a.docx', symbol: 'x' }, makeCtx())
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/unsupported|not support/i)
  })

  it('errors when the file cannot be read', async () => {
    // 支持的扩展名但文件不存在，应返回 isError
    const r = await tool.run({ operation: 'hover', file: 'no-such-file.ts', symbol: 'x' }, makeCtx())
    expect(r.isError).toBe(true)
  })

  it('errors on missing required fields', async () => {
    // 缺少 file 和 symbol，应返回错误
    const r = await tool.run({ operation: 'definition' }, makeCtx())
    expect(r.isError).toBe(true)
  })
})
