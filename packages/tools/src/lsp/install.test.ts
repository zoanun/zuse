import { describe, it, expect } from 'vitest'
import { createFileTracker, type ToolContext } from '@zuse/core'
import { createLspInstallTool, type InstallRunner } from './install.js'

// 构造最小化 ToolContext
function makeCtx(cwd = process.cwd()): ToolContext {
  return { cwd, signal: new AbortController().signal, tracker: createFileTracker() }
}

// 记录被执行命令的假 runner —— 不真跑安装,只回放预设结果并记录调用。
function fakeRunner(result: { code: number; output: string }): { run: InstallRunner; calls: string[][] } {
  const calls: string[][] = []
  const run: InstallRunner = async (cmd) => {
    calls.push(cmd)
    return result
  }
  return { run, calls }
}

describe('LspInstall tool', () => {
  it('is NOT readOnly so it goes through the permission gate', () => {
    const tool = createLspInstallTool(async () => ({ code: 0, output: '' }))
    expect(tool.name).toBe('LspInstall')
    expect(tool.readOnly).toBeFalsy()
  })

  it('specifierFor returns the lang for per-language permission rules', () => {
    const tool = createLspInstallTool(async () => ({ code: 0, output: '' }))
    expect(tool.specifierFor?.({ lang: 'typescript' })).toBe('typescript')
    expect(tool.specifierFor?.({})).toBeNull()
  })

  it('errors when lang is missing, without running anything', async () => {
    const { run, calls } = fakeRunner({ code: 0, output: '' })
    const r = await createLspInstallTool(run).run({}, makeCtx())
    expect(r.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('errors on an unknown lang, without running anything', async () => {
    const { run, calls } = fakeRunner({ code: 0, output: '' })
    const r = await createLspInstallTool(run).run({ lang: 'cobol' }, makeCtx())
    expect(r.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('declines a language with no auto-install command (java) and runs nothing', async () => {
    const { run, calls } = fakeRunner({ code: 0, output: '' })
    const r = await createLspInstallTool(run).run({ lang: 'java' }, makeCtx())
    expect(r.isError).toBe(true)
    // 婉拒时给出手动提示,且绝不触发安装(不会去碰 JDK 等系统依赖)
    expect(r.output).toMatch(/manual|手动|cannot|无法/i)
    expect(calls).toHaveLength(0)
  })

  it('runs the npm command for typescript and reports success on exit 0', async () => {
    const { run, calls } = fakeRunner({ code: 0, output: 'added 1 package' })
    const r = await createLspInstallTool(run).run({ lang: 'typescript' }, makeCtx())
    expect(r.isError).toBeFalsy()
    // 命令从配置来,确定不乱猜
    expect(calls).toEqual([['npm', 'i', '-g', 'typescript-language-server', 'typescript']])
  })

  it('reports failure with captured output when the install command exits non-zero', async () => {
    const { run } = fakeRunner({ code: 1, output: 'EACCES: permission denied' })
    const r = await createLspInstallTool(run).run({ lang: 'typescript' }, makeCtx())
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/EACCES/)
  })

  it('returns cancelled when the signal is already aborted', async () => {
    const { run, calls } = fakeRunner({ code: 0, output: '' })
    const ctx: ToolContext = { cwd: process.cwd(), signal: AbortSignal.abort(), tracker: createFileTracker() }
    const r = await createLspInstallTool(run).run({ lang: 'typescript' }, ctx)
    expect(r.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })
})
