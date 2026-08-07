import { describe, it, expect, vi } from 'vitest'
import { SLASH_COMMANDS, filterCommands } from './commands.js'

describe('filterCommands', () => {
  it('returns [] when input does not start with a slash', () => {
    expect(filterCommands('hello', SLASH_COMMANDS)).toEqual([])
    expect(filterCommands('', SLASH_COMMANDS)).toEqual([])
  })

  it('returns all commands for a bare slash', () => {
    expect(filterCommands('/', SLASH_COMMANDS)).toEqual(SLASH_COMMANDS)
  })

  it('prefix-matches command names case-insensitively', () => {
    const hits = filterCommands('/CO', SLASH_COMMANDS)
    expect(hits.map((c) => c.name)).toEqual(['/compact'])
  })

  it('returns [] when nothing matches the prefix', () => {
    expect(filterCommands('/zzz', SLASH_COMMANDS)).toEqual([])
  })
})

describe('SLASH_COMMANDS table', () => {
  it('runs /compact as a compact uplink', () => {
    const ctx = { send: vi.fn(), newSession: vi.fn(), openPanel: vi.fn(), focusHistorySearch: vi.fn(), showHelp: vi.fn(), openDirPicker: vi.fn(), cyclePermissionMode: vi.fn() }
    SLASH_COMMANDS.find((c) => c.name === '/compact')!.run(ctx)
    expect(ctx.send).toHaveBeenCalledWith({ type: 'compact' })
  })

  it('runs /clear as newSession and /files as openPanel(files)', () => {
    const ctx = { send: vi.fn(), newSession: vi.fn(), openPanel: vi.fn(), focusHistorySearch: vi.fn(), showHelp: vi.fn(), openDirPicker: vi.fn(), cyclePermissionMode: vi.fn() }
    SLASH_COMMANDS.find((c) => c.name === '/clear')!.run(ctx)
    expect(ctx.newSession).toHaveBeenCalled()
    SLASH_COMMANDS.find((c) => c.name === '/files')!.run(ctx)
    expect(ctx.openPanel).toHaveBeenCalledWith('files')
  })

  it('runs /mode as cyclePermissionMode', () => {
    const ctx = { send: vi.fn(), newSession: vi.fn(), openPanel: vi.fn(), focusHistorySearch: vi.fn(), showHelp: vi.fn(), openDirPicker: vi.fn(), cyclePermissionMode: vi.fn() }
    SLASH_COMMANDS.find((c) => c.name === '/mode')!.run(ctx)
    expect(ctx.cyclePermissionMode).toHaveBeenCalled()
    // 键盘入口不该自己拼上行帧 —— 循环顺序只有一份（permissionMode.ts 的 nextMode），
    // 否则 chip 和 /mode 会各转各的。
    expect(ctx.send).not.toHaveBeenCalled()
  })
})
