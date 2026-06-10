import { describe, it, expect, vi } from 'vitest'
import { createStdinManager, ESC_FLUSH_TIMEOUT_MS } from './stdin.js'
import type { ParsedKey } from './parseKeypress.js'
import {
  ENABLE_BRACKETED_PASTE,
  DISABLE_BRACKETED_PASTE,
} from './protocol.js'

function makeFakeStdin(isTTY: boolean) {
  const listeners: Record<string, ((chunk: string) => void)[]> = {}
  return {
    isTTY,
    raw: null as boolean | null,
    encoding: '',
    resumed: false,
    setRawMode(m: boolean) {
      this.raw = m
    },
    setEncoding(e: string) {
      this.encoding = e
    },
    resume() {
      this.resumed = true
    },
    pause() {},
    on(ev: string, fn: (chunk: string) => void) {
      ;(listeners[ev] ??= []).push(fn)
    },
    off(ev: string, fn: (chunk: string) => void) {
      listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn)
    },
    emit(ev: string, chunk: string) {
      ;(listeners[ev] ?? []).forEach((f) => f(chunk))
    },
    listenerCount(ev: string) {
      return (listeners[ev] ?? []).length
    },
  }
}

function makeFakeBus(collected: ParsedKey[]) {
  return {
    subscribe: () => () => {},
    // 测试中不需要粘贴订阅,提供空实现满足 InputBus 类型约束。
    subscribePaste: () => () => {},
    dispatch: (k: ParsedKey) => {
      collected.push(k)
    },
  }
}

describe('createStdinManager', () => {
  it('TTY:start 设 raw、utf8、resume,并推开启协议', () => {
    const stdin = makeFakeStdin(true)
    const out: string[] = []
    const stdout = { write: (s: string) => out.push(s) }
    const mgr = createStdinManager({ stdin: stdin as never, stdout, bus: makeFakeBus([]) })
    mgr.start()
    expect(stdin.raw).toBe(true)
    expect(stdin.encoding).toBe('utf8')
    expect(stdin.resumed).toBe(true)
    expect(out[0]).toBe(ENABLE_BRACKETED_PASTE)
    expect(stdin.listenerCount('data')).toBe(1)
  })

  it('data chunk 经解析后派发到 bus', () => {
    const stdin = makeFakeStdin(true)
    const keys: ParsedKey[] = []
    const mgr = createStdinManager({
      stdin: stdin as never,
      stdout: { write: () => {} },
      bus: makeFakeBus(keys),
    })
    mgr.start()
    // raw 模式下击键通常分块到达;分两次 emit 同时验证 onData 的跨 chunk 状态串联。
    stdin.emit('data', 'a')
    stdin.emit('data', '\r')
    expect(keys.map((k) => k.name)).toEqual(['a', 'return'])
  })

  it('stop:卸监听、还原协议、关 raw', () => {
    const stdin = makeFakeStdin(true)
    const out: string[] = []
    const mgr = createStdinManager({
      stdin: stdin as never,
      stdout: { write: (s: string) => out.push(s) },
      bus: makeFakeBus([]),
    })
    mgr.start()
    out.length = 0
    mgr.stop()
    expect(stdin.listenerCount('data')).toBe(0)
    expect(stdin.raw).toBe(false)
    expect(out[out.length - 1]).toBe(DISABLE_BRACKETED_PASTE)
  })

  it('非 TTY:降级,不设 raw、不挂监听、不推协议', () => {
    const stdin = makeFakeStdin(false)
    const out: string[] = []
    const mgr = createStdinManager({
      stdin: stdin as never,
      stdout: { write: (s: string) => out.push(s) },
      bus: makeFakeBus([]),
    })
    mgr.start()
    expect(stdin.raw).toBe(null)
    expect(stdin.listenerCount('data')).toBe(0)
    expect(out).toEqual([])
  })

  it('start 幂等:连调两次不重复挂 data 监听', () => {
    const stdin = makeFakeStdin(true)
    const mgr = createStdinManager({
      stdin: stdin as never,
      stdout: { write: () => {} },
      bus: makeFakeBus([]),
    })
    mgr.start()
    mgr.start()
    expect(stdin.listenerCount('data')).toBe(1)
  })

  it('stop 幂等:未 start 直接 stop 无副作用;stop 两次只还原一次', () => {
    const stdin = makeFakeStdin(true)
    const out: string[] = []
    const mgr = createStdinManager({
      stdin: stdin as never,
      stdout: { write: (s: string) => out.push(s) },
      bus: makeFakeBus([]),
    })
    mgr.stop()
    expect(out).toEqual([])
    expect(stdin.raw).toBe(null)
    mgr.start()
    mgr.stop()
    const len = out.length
    mgr.stop()
    expect(out.length).toBe(len)
  })

  it('信号钩子:start 后注册、stop 后摘除(按增量断言)', () => {
    const stdin = makeFakeStdin(true)
    const mgr = createStdinManager({
      stdin: stdin as never,
      stdout: { write: () => {} },
      bus: makeFakeBus([]),
    })
    const before = process.listenerCount('SIGINT')
    mgr.start()
    expect(process.listenerCount('SIGINT')).toBe(before + 1)
    mgr.stop()
    expect(process.listenerCount('SIGINT')).toBe(before)
  })

  it('stop 时 flush 粘贴残留:中途 stop 吐出已累积内容', () => {
    const stdin = makeFakeStdin(true)
    const keys: ParsedKey[] = []
    const mgr = createStdinManager({
      stdin: stdin as never,
      stdout: { write: () => {} },
      bus: makeFakeBus(keys),
    })
    mgr.start()
    stdin.emit('data', '\x1b[200~partial')
    expect(keys).toEqual([])
    mgr.stop()
    expect(keys.length).toBe(1)
    expect(keys[0]!.isPasted).toBe(true)
    expect(keys[0]!.sequence).toBe('partial')
  })

  it('孤立 ESC:50ms 内无续字节则 flush 派发为 escape', () => {
    vi.useFakeTimers()
    try {
      const stdin = makeFakeStdin(true)
      const keys: ParsedKey[] = []
      const mgr = createStdinManager({
        stdin: stdin as never,
        stdout: { write: () => {} },
        bus: makeFakeBus(keys),
      })
      mgr.start()
      stdin.emit('data', '\x1b') // 孤立 ESC,被 tokenizer 缓冲,暂不派发
      expect(keys).toEqual([])
      vi.advanceTimersByTime(ESC_FLUSH_TIMEOUT_MS)
      expect(keys.map((k) => k.name)).toEqual(['escape'])
      mgr.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ESC 后 50ms 内到达续字节:合并为完整序列,不误判为 escape', () => {
    vi.useFakeTimers()
    try {
      const stdin = makeFakeStdin(true)
      const keys: ParsedKey[] = []
      const mgr = createStdinManager({
        stdin: stdin as never,
        stdout: { write: () => {} },
        bus: makeFakeBus(keys),
      })
      mgr.start()
      stdin.emit('data', '\x1b')
      stdin.emit('data', '[A') // 续字节在超时前到达 → 方向上
      expect(keys.map((k) => k.name)).toEqual(['up'])
      vi.advanceTimersByTime(ESC_FLUSH_TIMEOUT_MS) // 定时器已被第二次 onData 清除
      expect(keys.map((k) => k.name)).toEqual(['up'])
      mgr.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop 清理孤立 ESC 定时器:卸载后不再追加派发', () => {
    vi.useFakeTimers()
    try {
      const stdin = makeFakeStdin(true)
      const keys: ParsedKey[] = []
      const mgr = createStdinManager({
        stdin: stdin as never,
        stdout: { write: () => {} },
        bus: makeFakeBus(keys),
      })
      mgr.start()
      stdin.emit('data', '\x1b')
      mgr.stop() // stop 自身会 flush 一次 ESC(不丢字符)
      const afterStop = keys.length
      vi.advanceTimersByTime(ESC_FLUSH_TIMEOUT_MS)
      expect(keys.length).toBe(afterStop) // 定时器已清,不再追加
    } finally {
      vi.useRealTimers()
    }
  })
})
