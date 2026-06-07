import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createFileTracker, type ToolContext } from '@zuse/core'
import { createLspTool } from './index.js'
import { LspManager } from './manager.js'
import { LspError, LspClient } from './client.js'

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
    // 缺少 symbol，应返回错误
    const r = await tool.run({ operation: 'definition' }, makeCtx())
    expect(r.isError).toBe(true)
  })

  it('definition without a file errors asking for a file', async () => {
    // definition/references/hover 仍需要 file
    const r = await tool.run({ operation: 'definition', symbol: 'x' }, makeCtx())
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/requires a file/i)
  })

  it('symbol operation does not require a file — proceeds to start a client', async () => {
    // symbol 是冷查询入口：无 file 也应越过文件校验，直接尝试起 client
    // （这里 starter 被注入为抛错，故落到错误映射，但错误来自 starter 而非「缺 file」）
    const r = await tool.run({ operation: 'symbol', symbol: 'resolvePath' }, makeCtx())
    expect(r.isError).toBe(true)
    expect(r.output).not.toMatch(/requires a file/i)
    expect(r.output).toMatch(/should not start/)
  })

  // 记录 openDocument / workspaceSymbol 调用顺序的假 client（不起真服务器）。
  function recordingClient(calls: string[]): LspClient {
    return {
      openDocument: (): void => {
        calls.push('open')
      },
      workspaceSymbol: async (): Promise<never[]> => {
        calls.push('symbol')
        return []
      },
    } as unknown as LspClient
  }

  it('symbol seeds the project by opening the given file before workspace/symbol', async () => {
    // No Project 修复：navto 前必须先 didOpen 一个文件给 tsserver 播工程种子。
    const dir = mkdtempSync(path.join(tmpdir(), 'zuse-lsptool-'))
    try {
      writeFileSync(path.join(dir, 'seed.ts'), 'export const a = 1')
      const calls: string[] = []
      const t = createLspTool(new LspManager(async () => recordingClient(calls)))
      const r = await t.run({ operation: 'symbol', symbol: 'a', file: 'seed.ts' }, makeCtx(dir))
      expect(r.isError).toBeFalsy()
      expect(calls).toEqual(['open', 'symbol'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('symbol with no file discovers a seed file and opens it before workspace/symbol', async () => {
    // 冷查询不带 file：应自动在 cwd 下找一个同语言源文件当种子,先 open 再 navto。
    const dir = mkdtempSync(path.join(tmpdir(), 'zuse-lsptool-'))
    try {
      mkdirSync(path.join(dir, 'src'))
      writeFileSync(path.join(dir, 'src', 'x.ts'), 'export const a = 1')
      const calls: string[] = []
      const t = createLspTool(new LspManager(async () => recordingClient(calls)))
      const r = await t.run({ operation: 'symbol', symbol: 'a', lang: 'typescript' }, makeCtx(dir))
      expect(r.isError).toBeFalsy()
      expect(calls).toEqual(['open', 'symbol'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('symbol failure with an install hint points the model to LspInstall for an installable lang', async () => {
    // 注入抛「没装」LspError 的 starter;typescript 是可自动装的语言,错误里应引导去 LspInstall。
    const t = createLspTool(
      new LspManager(async () => {
        throw new LspError("Language server 'typescript-language-server' not found.", 'npm i -g typescript-language-server typescript')
      }),
    )
    const r = await t.run({ operation: 'symbol', symbol: 'x', lang: 'typescript' }, makeCtx())
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/LspInstall/)
    expect(r.output).toMatch(/typescript/)
  })
})
