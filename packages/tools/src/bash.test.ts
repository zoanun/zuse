import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BashTool, getShellLabel } from './bash.js'
import { createFileTracker, type ToolContext } from '@zuse/core'

function makeCtx(signal?: AbortSignal): ToolContext {
  return {
    cwd: process.cwd(),
    signal: signal ?? new AbortController().signal,
    tracker: createFileTracker(),
  }
}

// cwd 持久化只在 bash/sh 下实现（POSIX 全平台 + Windows git-bash）；pwsh/cmd 跳过。
const cwdPersists = getShellLabel() === 'bash' || getShellLabel() === 'sh'

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

  // cd 改变工作目录后，经 ctx.setCwd 回写，下一条命令在新目录里执行。
  it.runIf(cwdPersists)('persists cwd across calls via setCwd', async () => {
    let sessionCwd = process.cwd()
    const mkctx = (): ToolContext => ({
      cwd: sessionCwd,
      signal: new AbortController().signal,
      tracker: createFileTracker(),
      setCwd: (p: string): void => {
        sessionCwd = p
      },
    })
    const dir = mkdtempSync(path.join(tmpdir(), 'zuse-cwdtest-'))
    try {
      const cd = await BashTool.run({ command: `cd '${dir.replace(/\\/g, '/')}'` }, mkctx())
      expect(cd.isError).toBeFalsy()
      // 第二条命令用新的 ctx（cwd 已接续到 dir）：打印实际工作目录。
      const pwd = await BashTool.run(
        { command: `node -e "process.stdout.write(process.cwd())"` },
        mkctx(),
      )
      expect(pwd.output).toContain(path.basename(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
