import { describe, it, expect } from 'vitest'
import { generateSetupToken, isExposedDeployment, checkSetupToken } from './setupToken.js'

describe('generateSetupToken', () => {
  it('32 字符 base64url，两次不同', () => {
    const a = generateSetupToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(a).not.toBe(generateSetupToken())
  })
})

describe('isExposedDeployment', () => {
  it('回环三写法不算暴露 —— 本机开发不能被这次改动加一步摩擦', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', 'LocalHost'])
      expect(isExposedDeployment({ host })).toBe(false)
  })

  /**
   * **空串必须算暴露。** `parseArgs` 只要 `--host` 后面跟了东西就设，`--host ""` 能过；
   * 而 `listen(0, '')` 实测绑的是 `::`（全网卡）。所以判据只能写成「回环白名单」，
   * 绝不能顺手优化成 `if (!host) return false` 这种 falsy 短路 —— 那正好把最危险的
   * 一种写法判成安全。
   */
  it('空串 / 0.0.0.0 / :: / LAN IP / 域名 都算暴露', () => {
    for (const host of ['', '0.0.0.0', '::', '192.168.1.23', 'my-box.local'])
      expect(isExposedDeployment({ host })).toBe(true)
  })

  /**
   * 回环 + 隧道：端口只有本机能连，但开这些参数的**唯一理由**就是「前面挂了东西、
   * 要被远程访问」。漏掉任何一条，最危险的形态（临时隧道 + 尚未设口令）恰好不受保护。
   */
  it('回环 + trustProxy / allowedHosts / tlsCert 任一 → 暴露', () => {
    expect(isExposedDeployment({ host: '127.0.0.1', trustProxy: true })).toBe(true)
    expect(isExposedDeployment({ host: '127.0.0.1', allowedHosts: ['x.trycloudflare.com'] })).toBe(true)
    expect(isExposedDeployment({ host: '127.0.0.1', allowedHosts: ['*'] })).toBe(true)
    expect(isExposedDeployment({ host: '127.0.0.1', tlsCert: 'C:/certs/a.pem' })).toBe(true)
  })

  it('空 allowedHosts 数组不算暴露 —— defaultConfig() 未设环境变量时就是空数组', () => {
    expect(isExposedDeployment({ host: '127.0.0.1', allowedHosts: [] })).toBe(false)
  })

  /**
   * `--host 127.0.0.2`（多实例开发）被判成暴露、要 token。**这是刻意的**：
   * 改成 `127.0.0.0/8` 前缀匹配是**放宽**判据，别顺手「修」它。
   */
  it('127.0.0.2 刻意判为暴露（宁可多要一次 token，不可放宽判据）', () => {
    expect(isExposedDeployment({ host: '127.0.0.2' })).toBe(true)
  })
})

describe('checkSetupToken', () => {
  it('相等为真，不等为假', () => {
    expect(checkSetupToken('abc', 'abc')).toBe(true)
    expect(checkSetupToken('abc', 'abd')).toBe(false)
  })

  /**
   * `timingSafeEqual` 长度不等会 **throw ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH**（实测），
   * 而这条路由是**未鉴权**的 —— 直接把长度不同的 token 递进去 = 一个 500。
   */
  it('长度不等不抛，返回 false', () => {
    expect(() => checkSetupToken('abcdef', 'ab')).not.toThrow()
    expect(checkSetupToken('abcdef', 'ab')).toBe(false)
  })

  /**
   * 未鉴权的单线程 DoS：`Buffer.from({length: 2e8})` 实测**同步阻塞 6.6 秒**、分配 200 MB。
   * 攻击者只需要一个 35 字节的 JSON body。所以**必须先判类型再 Buffer.from**。
   *
   * 这条断言同时管住「秒回」：真跑过 `Buffer.from` 的话这里会超时。
   */
  it('非字符串一律为假，且不分配（35 字节的 body 能冻 6.6 秒）', () => {
    const t0 = Date.now()
    expect(checkSetupToken('abc', { length: 200_000_000 } as unknown as string)).toBe(false)
    expect(Date.now() - t0).toBeLessThan(200)
    expect(checkSetupToken('abc', undefined)).toBe(false)
    expect(checkSetupToken('abc', 12345 as unknown as string)).toBe(false)
    expect(checkSetupToken('abc', null as unknown as string)).toBe(false)
  })

  it('超长 token 直接判否（别让比较本身成为放大器）', () => {
    expect(checkSetupToken('abc', 'x'.repeat(300))).toBe(false)
  })

  it('期望值为空时恒假 —— 「没配置 token」绝不能等价于「任何 token 都对」', () => {
    expect(checkSetupToken('', '')).toBe(false)
    expect(checkSetupToken('', 'anything')).toBe(false)
  })
})
