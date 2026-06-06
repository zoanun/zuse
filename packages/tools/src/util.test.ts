import { describe, it, expect } from 'vitest'
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
})

describe('killTree', () => {
  it('is a no-op for undefined pid', () => {
    expect(() => killTree(undefined)).not.toThrow()
  })
})
