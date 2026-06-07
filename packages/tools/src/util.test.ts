import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findOnPath, killTree } from './util.js'

describe('findOnPath', () => {
  it('finds node on PATH', () => {
    // node 一定在 PATH 上（测试用 node 跑）
    const exe = process.platform === 'win32' ? 'node.exe' : 'node'
    expect(findOnPath(exe)).toBeTruthy()
  })
  it('returns undefined for a missing executable', () => {
    expect(findOnPath('definitely-not-a-real-exe-xyz.zzz')).toBeUndefined()
  })
  it.skipIf(process.platform !== 'win32')('resolves a bare name to a .cmd via PATHEXT (win32)', () => {
    // Windows 上 npm 全局命令多是 .CMD 启动器；裸名查找必须经 PATHEXT 命中扩展名，
    // 否则"命令在不在"会漏报（正是 LSP server 没装时死等 30s 而非快速失败的根因）。
    const dir = mkdtempSync(path.join(tmpdir(), 'zuse-fop-'))
    writeFileSync(path.join(dir, 'zuse-fake-tool.cmd'), '@echo off\r\n')
    const saved = process.env.PATH
    try {
      process.env.PATH = dir + path.delimiter + (saved ?? '')
      const found = findOnPath('zuse-fake-tool')
      expect(found).toBeTruthy()
      expect(found!.toLowerCase()).toBe(path.join(dir, 'zuse-fake-tool.cmd').toLowerCase())
    } finally {
      process.env.PATH = saved
    }
  })
})

describe('killTree', () => {
  it('is a no-op for undefined pid', () => {
    expect(() => killTree(undefined)).not.toThrow()
  })
})
