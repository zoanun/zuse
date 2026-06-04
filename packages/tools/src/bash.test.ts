import { describe, it, expect } from 'vitest'
import { BashTool } from './bash.js'
import { createFileTracker, type ToolContext } from '@zuse/core'

function makeCtx(signal?: AbortSignal): ToolContext {
  return {
    cwd: process.cwd(),
    signal: signal ?? new AbortController().signal,
    tracker: createFileTracker(),
  }
}

// 用 `node -e` 写命令，跨 shell（cmd.exe / bash）都可移植 —— spawn({shell:true})
// 在 Windows 上走 cmd.exe，echo/sleep 行为不一致，node 是唯一稳的公分母。
describe('BashTool', () => {
  it('runs a command and returns its output', async () => {
    const result = await BashTool.run({ command: `node -e "console.log('hello-bash')"` }, makeCtx())
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('hello-bash')
  })

  it('captures stderr too', async () => {
    const result = await BashTool.run(
      { command: `node -e "console.error('to-stderr')"` },
      makeCtx(),
    )
    expect(result.output).toContain('to-stderr')
  })

  it('returns is_error with the exit code on non-zero exit', async () => {
    const result = await BashTool.run({ command: `node -e "process.exit(3)"` }, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/exit code: 3/)
  })

  it('times out a long-running command', async () => {
    const result = await BashTool.run(
      { command: `node -e "setTimeout(function(){}, 10000)"`, timeout: 200 },
      makeCtx(),
    )
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/timed out/i)
  })

  it('is interrupted when the signal aborts', async () => {
    const controller = new AbortController()
    const promise = BashTool.run(
      { command: `node -e "setTimeout(function(){}, 10000)"` },
      makeCtx(controller.signal),
    )
    setTimeout(() => controller.abort(), 100)
    const result = await promise
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/interrupted/i)
  })

  it('returns is_error when command is missing', async () => {
    const result = await BashTool.run({}, makeCtx())
    expect(result.isError).toBe(true)
  })
})
