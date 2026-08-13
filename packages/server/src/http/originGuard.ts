import { isIP } from 'node:net'
import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * DNS rebinding / 跨站写入的两道闸。
 *
 * ## 为什么是**两把**锁，缺一条都留着完整的洞
 *
 * 这是本模块最关键、也最反直觉的一点，写在最前面：
 *
 * **DNS rebinding 下 `Origin` 恒等于 `Host`。** 页面来自 `http://evil.com:4180`，
 * DNS 重绑到 127.0.0.1 之后，`fetch('http://evil.com:4180/api/…')` 是**同源**请求 ——
 * 浏览器要么不发 Origin（导航/GET），要么发 `Origin: http://evil.com:4180`，
 * 与 `Host: evil.com:4180` 逐字一致。
 * **所以「Origin 必须等于 Host」这种一致性校验对 rebinding 毫无作用**，
 * 挡它的只能是 **Host 白名单**。
 *
 * 反过来，Host 白名单挡不住 `evil.com` 直接
 * `fetch('http://127.0.0.1:4180/…', {mode:'no-cors'})` —— 那时 `Host` 就是
 * `127.0.0.1:4180`，完全合法。挡这条的只能是 **Origin 白名单**。
 *
 * 两条攻击路径、两把锁，**必须同时上**。只上一把会造成「以为修好了」。
 *
 * ## 修的是什么洞
 *
 * 修之前：`POST /api/auth/setup` 在未设口令时唯一的门是「是否已配置」，
 * 而全仓 server 侧**零处**读 `headers.origin` / `headers.host`。于是
 * 恶意页面（配合 rebinding）可以 `status → setup → login → POST /api/runs`（任意命令）
 * `+ PUT /api/files/content`（任意写盘）—— **从「访问一个网页」到开发机 RCE**。
 *
 * ## 这两把锁**不能**防什么（别把它吹过头）
 *
 * 它们是**纯浏览器侧**的防御。`curl`、本机恶意进程、局域网扫描器想发什么 Host / Origin
 * 就发什么。它们防的是「用户访问了一个恶意网页」这条链路 —— 恰好是上面那个洞，但不是全部。
 * 局域网里抢先 setup 那条要靠一次性 token（见 startServer 的 `setupToken`）。
 *
 * 纯函数、无 IO（`buildHostPolicy` 除外，它读证书），与 `requestSecurity.ts` 同风格，便于单测。
 */
export interface HostPolicy {
  /** 显式声明的名字，全小写。支持 `*.suffix`。来源见 buildHostPolicy。 */
  names: string[]
  /** 用户给了裸 `*`：任何名字都放行。单独存一位，好在启动横幅上告警。 */
  anyName: boolean
}

/**
 * `Host` 头 → `{hostname, port}`；畸形一律 null（= 拒绝）。
 *
 * **字符白名单必须在 `new URL` 之前。** `new URL('http://a/b')` 会把 `a/b` 宽容地解析成
 * hostname `a` —— 不挡的话，`Host: 127.0.0.1/../evil.com` 会被解析成 hostname
 * `127.0.0.1`，直接吃到 IP 字面量豁免。
 */
export function splitHostHeader(h: string | undefined): { hostname: string; port: string } | null {
  if (!h) return null
  if (!/^[A-Za-z0-9._:[\]-]+$/.test(h)) return null
  try {
    const u = new URL('http://' + h)
    if (!u.hostname) return null
    // **`URL` 不会去掉 IPv6 的方括号** —— 实测 `new URL('http://[::1]:4180').hostname`
    // 返回的是 `'[::1]'`。而 `isIP('[::1]')` 是 0（认不出来），于是 `http://[::1]:4180`
    // 这个再正常不过的本机访问会被当成「未声明的域名」拒掉。设计稿在这里想当然了，
    // 是单测把它抓出来的。手工剥括号。
    const hostname = u.hostname.replace(/^\[(.+)\]$/, '$1').toLowerCase()
    return { hostname, port: u.port }
  } catch {
    return null
  }
}

function matchesName(name: string, p: HostPolicy): boolean {
  if (p.anyName) return true
  for (const n of p.names) {
    if (n === name) return true
    // `*.foo.com` 匹配 `a.foo.com` / `a.b.foo.com`，**不**匹配裸 `foo.com`，
    // 也不匹配 `evilfoo.com`（长度判据保证 `.` 真的在那儿）
    if (n.startsWith('*.') && name.endsWith(n.slice(1)) && name.length > n.length - 1) return true
  }
  return false
}

/**
 * `Host` 头闸门。
 *
 * **IP 字面量无条件放行。** DNS rebinding 本质上需要一个**域名** —— 浏览器只有在用户
 * 访问的 URL 本身就是这个 IP 时才会发 IP 字面量 Host，那个 origin 就是 daemon 自己。
 * 攻击者从 `evil.com` 盲打 `http://127.0.0.1:4180` 同样会得到 IP 字面量 Host，
 * 但那条由 Origin 闸拦 —— 这正是文件头说的「两把锁」。
 */
export function isAllowedHostHeader(h: string | undefined, p: HostPolicy): boolean {
  const parsed = splitHostHeader(h)
  if (!parsed) return false
  if (isIP(parsed.hostname) !== 0) return true
  if (parsed.hostname === 'localhost') return true
  return matchesName(parsed.hostname, p)
}

/**
 * `Origin` 头闸门。
 *
 * **与 Host 闸刻意不对称：这里不放行任意 IP、不放行 localhost。** 这条最容易写反 ——
 * 若照搬 Host 闸的 IP 豁免，局域网里另一台机器（`Origin: http://192.168.1.99`）
 * 就能打进来。
 *
 * 缺失 Origin 放行：地址栏导航、curl、非浏览器客户端本来就不发它。强制要求它存在
 * **换不到任何安全性**（非浏览器伪造 Origin 是零成本的），只会打死脚本客户端。
 */
export function isAllowedOrigin(
  origin: string | undefined,
  hostHeader: string | undefined,
  p: HostPolicy,
): boolean {
  if (origin === undefined) return true
  if (origin === 'null') return false // opaque origin：sandbox iframe / data: / 某些重定向
  let u: URL
  try {
    u = new URL(origin)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  // 同源：Origin 的 host:port 与 Host 头逐字相等。Host 已经单独过闸，所以这条是安全的。
  if (u.host.toLowerCase() === (hostHeader ?? '').toLowerCase()) return true
  // 兜底：前置代理把 Host 改写成 127.0.0.1、而 Origin 仍是公网名的隧道形态。
  // 只认显式声明的名字。
  return matchesName(u.hostname.toLowerCase(), p)
}

export interface GuardReject {
  code: 'host_not_allowed' | 'origin_not_allowed'
  message: string
}

/** 请求级总闸。返回 null = 放行。 */
export function guardRequest(
  req: { headers: { host?: string | undefined; origin?: string | undefined } },
  p: HostPolicy,
  opts: { checkOrigin: boolean },
): GuardReject | null {
  const host = req.headers.host
  if (!isAllowedHostHeader(host, p)) {
    const name = splitHostHeader(host)?.hostname ?? '<域名>'
    return {
      code: 'host_not_allowed',
      // 报错必须直接写出该加什么参数、什么值 —— 这是隧道用户唯一的线索。
      message:
        `Host "${host ?? '(缺失)'}" 不在允许列表。若这是你的隧道 / 远程域名，` +
        `用 --allowed-host ${name} 重启 daemon（见 docs/remote-access.md）。`,
    }
  }
  if (opts.checkOrigin && !isAllowedOrigin(req.headers.origin, host, p)) {
    return {
      code: 'origin_not_allowed',
      message:
        `跨站请求被拒（Origin: ${req.headers.origin}）。zuse 只接受同源请求；` +
        `若这是你的隧道域名，用 --allowed-host 声明它。`,
    }
  }
  return null
}

/**
 * 组装策略。
 *
 * **TLS 证书的 DNS SAN 自动进白名单。** 证书是运维**显式提供的文件**，SAN 就是
 * 「本服务器为哪些名字应答」的机器可读声明，且不受攻击者控制。少了这条，
 * `docs/remote-access.md` 里两条直连 TLS 的配方会当场坏掉。
 *
 * **通配 SAN（`*.example.com`）不自动采纳** —— 一张野生通配证书会把白名单宽到整个域，
 * 而那不是运维声明「这台机器叫什么」的本意。要用就显式 `--allowed-host`。
 *
 * 对比：`os.hostname()` **不**自动进白名单。那是隐式扩权、让规则不可预测，
 * 而且局域网里 mDNS 名可被投毒。两者的区别在于「是不是用户显式提供的文件」。
 */
export function buildHostPolicy(opts: {
  host: string
  allowedHosts?: string[] | undefined
  tlsCertPath?: string | undefined
}): HostPolicy {
  const names = new Set<string>()
  let anyName = false
  for (const raw of opts.allowedHosts ?? []) {
    const v = raw.trim().toLowerCase()
    if (!v) continue
    if (v === '*') {
      anyName = true
      continue
    }
    names.add(v)
  }
  // --host 给的是域名（不是 IP、不是空）→ 运维已经显式声明了这个名字
  if (opts.host && isIP(opts.host) === 0 && opts.host.toLowerCase() !== 'localhost') {
    names.add(opts.host.toLowerCase())
  }
  if (opts.tlsCertPath) {
    try {
      const san = new X509Certificate(readFileSync(opts.tlsCertPath)).subjectAltName
      for (const part of (san ?? '').split(',')) {
        // 只吃规整的裸值；带引号/逗号的一律忽略。`*.` 开头的通配不采纳，见上。
        const m = /^\s*DNS:([A-Za-z0-9.-]+)\s*$/.exec(part)
        if (m?.[1]) names.add(m[1].toLowerCase())
      }
    } catch {
      // 读不到 / 解析不了就不加 —— 证书本身的 fail-fast 在 appServer.ts 里已有
    }
  }
  return { names: [...names], anyName }
}
