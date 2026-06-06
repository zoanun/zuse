import { describe, it, expect } from 'vitest'
import { ProxyAgent } from 'undici'
import { installProxy } from './proxy.js'
import type { ResolvedSettings } from './types.js'

const base = (over: Partial<ResolvedSettings>): ResolvedSettings => ({
  tools: {},
  permissions: { defaultMode: 'default', allow: [], ask: [], deny: [] },
  providers: {},
  ...over,
})

describe('installProxy', () => {
  it('未配置 proxy → 不安装、返回 undefined', () => {
    let called = false
    const result = installProxy(base({}), () => {
      called = true
    })
    expect(result).toBeUndefined()
    expect(called).toBe(false)
  })

  it('proxy 为空串/纯空白 → 视为未配置，不安装', () => {
    let called = false
    const setter = (): void => {
      called = true
    }
    expect(installProxy(base({ proxy: '' }), setter)).toBeUndefined()
    expect(installProxy(base({ proxy: '   ' }), setter)).toBeUndefined()
    expect(called).toBe(false)
  })

  it('配置了 proxy → 用 ProxyAgent 调用 setter，返回（去空白后的）地址', () => {
    let received: ProxyAgent | undefined
    const result = installProxy(base({ proxy: '  http://127.0.0.1:9002  ' }), (d) => {
      received = d
    })
    expect(result).toBe('http://127.0.0.1:9002')
    expect(received).toBeInstanceOf(ProxyAgent)
  })

  it('地址漏写协议（如 localhost:8080）→ 抛出清晰错误，不调用 setter', () => {
    let called = false
    expect(() => installProxy(base({ proxy: 'localhost:8080' }), () => {
      called = true
    })).toThrow(/代理地址/)
    expect(called).toBe(false)
  })

  it('非 http/https 协议（如 ftp://）→ 抛出协议无效错误', () => {
    expect(() => installProxy(base({ proxy: 'ftp://host:21' }), () => undefined)).toThrow(/协议无效/)
  })
})
