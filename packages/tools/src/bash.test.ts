import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BashTool, getShellLabel, primeShellSnapshot, redecodeOemIfMojibake } from './bash.js'
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
    // 错误回传契约(Phase 8):告诉模型 timeout 是它自己可调的入参。
    expect(result.output).toContain('timeout parameter')
  })

  it('keeps head and tail of oversized output and spills the full output to disk', async () => {
    // 输出整形(Phase 9):>30k 的输出应保留首尾、中段省略,完整输出落盘可供 Read/Grep。
    const dir = mkdtempSync(path.join(tmpdir(), 'zuse-spill-'))
    process.env.ZUSE_TOOL_OUTPUT_DIR = dir
    try {
      const script =
        "console.log('HEAD-LINE'); for (let i = 0; i < 400; i++) console.log('mid-' + i + '-' + 'x'.repeat(95)); console.log('TAIL-LINE')"
      const result = await BashTool.run({ command: `node -e "${script}"` }, makeCtx())
      expect(result.isError).toBeFalsy()
      expect(result.output).toContain('HEAD-LINE')
      expect(result.output).toContain('TAIL-LINE')
      expect(result.output).toMatch(/\[truncated: output was \d+ chars/)
      // marker 指向落盘文件,文件含被省略的中段。
      const m = result.output.match(/Full output: (.+?) — use Read or Grep/)
      expect(m).not.toBeNull()
      const spillPath = m![1]!
      expect(spillPath.startsWith(dir)).toBe(true)
      const full = await readFile(spillPath, 'utf8')
      expect(full).toContain('HEAD-LINE')
      expect(full).toContain('mid-200-')
      expect(full).toContain('TAIL-LINE')
    } finally {
      delete process.env.ZUSE_TOOL_OUTPUT_DIR
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves small output untouched (no marker, no spill file)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zuse-nospill-'))
    process.env.ZUSE_TOOL_OUTPUT_DIR = dir
    try {
      const result = await BashTool.run({ command: `node -e "console.log('tiny')"` }, makeCtx())
      expect(result.isError).toBeFalsy()
      expect(result.output).not.toContain('[truncated')
      expect(readdirSync(dir)).toEqual([])
    } finally {
      delete process.env.ZUSE_TOOL_OUTPUT_DIR
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('points out "command not found" on exit code 127', async () => {
    // 127 是 POSIX/git-bash 一致的"命令不存在"退出码,直接 exit 127 跨平台稳定复现。
    const result = await BashTool.run({ command: `node -e "process.exit(127)"` }, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/exit code: 127/)
    // 错误回传契约(Phase 8):点破高频失因并给下一步(查拼写/装它/绝对路径)。
    expect(result.output).toMatch(/command not found/i)
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

  // 接入登录 shell 快照后,命令仍应正常执行（快照前缀不破坏输出/退出码）。
  // bash（Windows git-bash 或 POSIX bash）与 zsh 下真正建快照；其余 primeShellSnapshot
  // 返回 null,此测退化为普通执行。
  it.runIf(getShellLabel() === 'bash' || getShellLabel() === 'zsh')('still runs commands correctly with the shell snapshot', async () => {
    const p = await primeShellSnapshot()
    expect(p === null || p.endsWith('.sh')).toBe(true)
    const result = await BashTool.run(
      { command: `node -e "console.log('after-snapshot')"` },
      makeCtx(),
    )
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('after-snapshot')
  })
})

describe('redecodeOemIfMojibake (Windows OEM output fallback)', () => {
  // "你好" encoded in GBK/CP936 (what a zh-CN Windows `ping` emits) — invalid as UTF-8, so the
  // real pipeline's UTF-8 decode of these bytes yields a body containing U+FFFD.
  const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3])
  const FFFD = String.fromCharCode(0xfffd)

  it('re-decodes OEM bytes when UTF-8 decoding left U+FFFD', () => {
    expect(redecodeOemIfMojibake(`${FFFD}${FFFD} mojibake`, [gbk], false, 'gbk')).toBe('你好')
  })

  it('leaves clean UTF-8 output untouched (no U+FFFD → null)', () => {
    expect(redecodeOemIfMojibake('all good 你好', [gbk], false, 'gbk')).toBeNull()
  })

  it('does NOT flip a mostly-UTF-8 body that has only a stray U+FFFD (density gate)', () => {
    const mostlyClean = 'a'.repeat(500) + FFFD // one replacement char in 501 → far below the ratio
    expect(redecodeOemIfMojibake(mostlyClean, [gbk], false, 'gbk')).toBeNull()
  })

  it('skips when raw overflowed, or no OEM codepage is known', () => {
    expect(redecodeOemIfMojibake(FFFD, [gbk], true, 'gbk')).toBeNull()  // raw truncated → keep UTF-8
    expect(redecodeOemIfMojibake(FFFD, [gbk], false, null)).toBeNull()  // non-Windows / unknown CP
  })
})
