import { describe, it, expect } from 'vitest'
import {
  splitHostHeader,
  isAllowedHostHeader,
  isAllowedOrigin,
  buildHostPolicy,
  guardRequest,
  type HostPolicy,
} from './originGuard.js'

const P = (over: Partial<HostPolicy> = {}): HostPolicy => ({ names: [], anyName: false, ...over })

describe('splitHostHeader', () => {
  it('拆出 hostname 与 port，hostname 小写', () => {
    expect(splitHostHeader('127.0.0.1:4180')).toEqual({ hostname: '127.0.0.1', port: '4180' })
    expect(splitHostHeader('Example.COM')).toEqual({ hostname: 'example.com', port: '' })
  })
  it('IPv6 去掉方括号', () => {
    expect(splitHostHeader('[::1]:4180')).toEqual({ hostname: '::1', port: '4180' })
  })
  /**
   * **字符白名单必须在 URL 解析之前。** `new URL('http://a/b')` 会把 `a/b` 解析成
   * hostname `a` —— 不挡的话，一个带 `/` 的畸形 Host 能骗过白名单：
   * `Host: evil.com/127.0.0.1` 会被解析成 hostname `evil.com`（那还好），
   * 而 `Host: 127.0.0.1/../evil.com` 会被解析成 `127.0.0.1` —— 直接通过 IP 字面量豁免。
   */
  it('畸形 Host 一律 null（不许交给 URL 去「宽容地」解析）', () => {
    expect(splitHostHeader(undefined)).toBeNull()
    expect(splitHostHeader('')).toBeNull()
    expect(splitHostHeader('a b')).toBeNull()
    expect(splitHostHeader('127.0.0.1:4180/../evil.com')).toBeNull()
    expect(splitHostHeader('evil.com/127.0.0.1')).toBeNull()
  })
})

describe('isAllowedHostHeader', () => {
  /**
   * **IP 字面量无条件放行。** DNS rebinding 本质上需要一个**域名** —— 浏览器只有在用户
   * 访问的 URL 本身就是这个 IP 时才会发 IP 字面量 Host，那个 origin 就是 daemon 自己。
   * 攻击者从 evil.com 盲打 `http://127.0.0.1:4180` 也会得到 IP 字面量 Host，
   * 但那条由 Origin 闸拦 —— 这正是两把锁必须同时上的原因。
   */
  it('IP 字面量与 localhost 无条件放行', () => {
    expect(isAllowedHostHeader('127.0.0.1:4180', P())).toBe(true)
    expect(isAllowedHostHeader('192.168.1.23:4180', P())).toBe(true)
    expect(isAllowedHostHeader('[::1]:4180', P())).toBe(true)
    expect(isAllowedHostHeader('localhost:4180', P())).toBe(true)
  })
  it('未声明的域名拒绝 —— 这是挡 DNS rebinding 的那一条', () => {
    expect(isAllowedHostHeader('evil.example:4180', P())).toBe(false)
  })
  it('显式声明的域名放行', () => {
    expect(isAllowedHostHeader('box.ts.net', P({ names: ['box.ts.net'] }))).toBe(true)
  })
  it('通配 *.suffix 匹配子域，但不匹配裸域', () => {
    const p = P({ names: ['*.trycloudflare.com'] })
    expect(isAllowedHostHeader('xyz.trycloudflare.com', p)).toBe(true)
    expect(isAllowedHostHeader('a.b.trycloudflare.com', p)).toBe(true)
    expect(isAllowedHostHeader('trycloudflare.com', p)).toBe(false)
    expect(isAllowedHostHeader('eviltrycloudflare.com', p)).toBe(false)
  })
  it('anyName 放行一切名字（逃生口）', () => {
    expect(isAllowedHostHeader('evil.example', P({ anyName: true }))).toBe(true)
  })
  it('畸形 Host 拒绝', () => {
    expect(isAllowedHostHeader(undefined, P())).toBe(false)
    expect(isAllowedHostHeader('a b', P())).toBe(false)
  })
})

describe('isAllowedOrigin', () => {
  /** 地址栏导航 / curl / 非浏览器客户端没有 Origin 头，这是正常的，不能一刀切拒绝。 */
  it('缺失 Origin 放行', () => {
    expect(isAllowedOrigin(undefined, '127.0.0.1:4180', P())).toBe(true)
  })
  it('opaque origin（sandbox iframe / data:）拒绝', () => {
    expect(isAllowedOrigin('null', '127.0.0.1:4180', P())).toBe(false)
  })
  it('同源（Origin 的 host:port 与 Host 逐字相等）放行', () => {
    expect(isAllowedOrigin('http://127.0.0.1:4180', '127.0.0.1:4180', P())).toBe(true)
    expect(isAllowedOrigin('https://box.ts.net', 'box.ts.net', P())).toBe(true)
  })
  /** 这条是本次修复的另一半：Host 合法（IP 字面量）但 Origin 是外站。 */
  it('跨站拒绝 —— Host 合法也不行', () => {
    expect(isAllowedOrigin('https://evil.example', '127.0.0.1:4180', P())).toBe(false)
  })
  /**
   * **不放行任意 IP。** 这条最容易写反：若这里也照搬 Host 闸的「IP 字面量豁免」，
   * 局域网里另一台机器（`Origin: http://192.168.1.99`）就能打进来。
   * 两个闸门的规则是**刻意不对称**的。
   */
  it('任意 IP 的 Origin 不放行（与 Host 闸刻意不对称）', () => {
    expect(isAllowedOrigin('http://192.168.1.99', '192.168.1.23:4180', P())).toBe(false)
  })
  it('白名单兜底 —— 代理改写了 Host、Origin 仍是外部名的隧道形态', () => {
    const p = P({ names: ['*.trycloudflare.com'] })
    expect(isAllowedOrigin('https://xyz.trycloudflare.com', '127.0.0.1:4180', p)).toBe(true)
  })
  it('非 http(s) 协议拒绝', () => {
    expect(isAllowedOrigin('file://', '127.0.0.1:4180', P())).toBe(false)
    expect(isAllowedOrigin('不是URL', '127.0.0.1:4180', P())).toBe(false)
  })
})

describe('buildHostPolicy', () => {
  it('--host 给域名时自动进白名单；给 IP 时不加名字', () => {
    expect(buildHostPolicy({ host: 'box.ts.net' }).names).toContain('box.ts.net')
    expect(buildHostPolicy({ host: '0.0.0.0' }).names).toEqual([])
  })
  it('allowedHosts 去空白、小写、支持逗号已在 CLI 层拆好', () => {
    const p = buildHostPolicy({ host: '127.0.0.1', allowedHosts: [' A.COM ', '', 'b.com'] })
    expect(p.names.sort()).toEqual(['a.com', 'b.com'])
  })
  it('裸 * 置 anyName 而不是当成名字', () => {
    const p = buildHostPolicy({ host: '127.0.0.1', allowedHosts: ['*'] })
    expect(p.anyName).toBe(true)
    expect(p.names).toEqual([])
  })
})

describe('guardRequest', () => {
  const req = (host?: string, origin?: string) => ({ headers: { host, origin } })

  it('放行本机形态', () => {
    expect(guardRequest(req('127.0.0.1:4180', 'http://127.0.0.1:4180'), P(), { checkOrigin: true })).toBeNull()
  })
  /** 场景 10：DNS rebinding —— Origin 与 Host 完全一致，只有 Host 闸能挡。 */
  it('DNS rebinding：Origin 恒等于 Host，靠 Host 闸拦', () => {
    const r = guardRequest(req('evil.example:4180', 'http://evil.example:4180'), P(), { checkOrigin: true })
    expect(r?.code).toBe('host_not_allowed')
    expect(r?.message).toContain('--allowed-host')   // 报错必须告诉用户怎么补救
  })
  /** 场景 11：evil.com 盲打 127.0.0.1 —— Host 合法，只有 Origin 闸能挡。 */
  it('跨站盲打回环：Host 合法，靠 Origin 闸拦', () => {
    const r = guardRequest(req('127.0.0.1:4180', 'https://evil.example'), P(), { checkOrigin: true })
    expect(r?.code).toBe('origin_not_allowed')
  })
  it('checkOrigin=false 时只过 Host 闸（静态资源 / preview-vendor）', () => {
    expect(guardRequest(req('127.0.0.1:4180', 'null'), P(), { checkOrigin: false })).toBeNull()
    expect(guardRequest(req('evil.example', 'null'), P(), { checkOrigin: false })?.code).toBe('host_not_allowed')
  })
})
