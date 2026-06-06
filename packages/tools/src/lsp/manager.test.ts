import { describe, it, expect, vi } from 'vitest'
import { LspManager } from './manager.js'
import type { LanguageServerConfig } from './servers.js'

// 用于测试的假语言配置（不会真正 spawn）
const cfg = {
  id: 'fake',
  extensions: ['.fk'],
  command: 'x',
  args: [],
  ready: 'immediate',
  installHint: '',
} as LanguageServerConfig

describe('LspManager', () => {
  it('dedupes concurrent starts of the same language (one spawn)', async () => {
    // 验证：并发两次 getClient 只触发一次 starter（进程池去重）
    let starts = 0
    const fakeClient = { dispose: vi.fn(async () => {}) }
    const starter = vi.fn(async () => {
      starts++
      await new Promise((r) => setTimeout(r, 20))
      return fakeClient as never
    })
    const m = new LspManager(starter)
    m.setCwd(process.cwd())
    const [a, b] = await Promise.all([
      m.getClient(cfg, new AbortController().signal),
      m.getClient(cfg, new AbortController().signal),
    ])
    // 两次拿到的是同一个对象
    expect(a).toBe(b)
    // starter 只被调用一次
    expect(starts).toBe(1)
    await m.dispose()
    // dispose 后 fakeClient.dispose 被调
    expect(fakeClient.dispose).toHaveBeenCalled()
  })

  it('reuses an already-started client', async () => {
    // 验证：第二次调用不会再 spawn，直接复用
    const fakeClient = { dispose: vi.fn(async () => {}) }
    const starter = vi.fn(async () => fakeClient as never)
    const m = new LspManager(starter)
    m.setCwd(process.cwd())
    await m.getClient(cfg, new AbortController().signal)
    await m.getClient(cfg, new AbortController().signal)
    // 只应被调一次
    expect(starter).toHaveBeenCalledTimes(1)
  })
})
