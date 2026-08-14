import { randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * 暴露形态下的一次性 setup token（回溯审计 D2 · 第 2 步）。
 *
 * ## 它补的是 `originGuard.ts` **补不到**的那半个洞
 *
 * Host / Origin 两把锁是**纯浏览器侧**的防御 —— 它们靠浏览器如实发送这两个头。
 * `curl` 不受任何约束，于是这条链完全没被第 1 步碰到：
 *
 * ```
 * daemon 暴露在网上、尚未设口令
 *   → 任意访客 curl -X POST /api/auth/setup -d '{"password":"attacker"}'
 *   → login（用他自己设的口令）→ POST /api/runs（任意命令）
 * ```
 *
 * 「先到先得」的口令设置，在一台联网的机器上等于把 RCE 挂在公网上。
 * 隧道尤其要命：`cloudflared tunnel --url` 打印的随机域名是**公网可达**的，不是秘密。
 *
 * ## 回环形态**故意不要** token
 *
 * 默认 `127.0.0.1` 绑定网络上根本连不到。同一用户账户下的恶意进程能连 —— 但它已经能
 * 直接读 `~/.zuse/web-auth.json`、直接跑任意命令，token 换不到任何安全性，
 * 却会给每个开发者的首次安装加一步复制粘贴。**安全摩擦要花在真能挡住攻击的地方。**
 *
 * （限定语：这条只对**同一用户账户**成立。共享主机上另一个非特权账户连得到
 * `127.0.0.1:4180` 却读不到 0600 的口令文件 —— 那种机器上这是个真缺口，
 * 但多账户开发机不是本仓的目标场景。）
 */

/** 回环名单。**必须是白名单式判断**，理由见 `isExposedDeployment`。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** token 长度上界。真值恒为 32；给比较设个天花板，别让它成为放大器。 */
const MAX_TOKEN_LEN = 256

export function generateSetupToken(): string {
  // 24 字节 → base64url 32 字符 / 192 bit。爆破不现实，所以不需要限速、不需要 TTL。
  return randomBytes(24).toString('base64url')
}

/**
 * 这台 daemon 是不是「网络上够得着」的形态。
 *
 * **判据只看启动参数，看不见另一个进程里的 cloudflared** —— 所以它必然有漏报，
 * 见 spec `2026-08-14-setup-token-design.md` §2.1 的表格。这里列的是能看见的信号：
 *
 * - `host` 不是回环：显然。
 * - `trustProxy`：**最容易漏的一条**。端口只有本机能连，但开这个参数的唯一理由
 *   就是「前面挂了隧道」，而隧道那一端是公网。
 * - `allowedHosts` 非空 / `tlsCert`：第 1 步之后，任何「浏览器 + 域名」的远程形态
 *   都**必须**给 `--allowed-host`（不给的话 Host 闸或 Origin 闸必拒其一）。
 *   所以它出现 ≈ 运维在声明「这台机器要被远程访问」。TLS 证书同理。
 *
 * **不要写成 falsy 短路**（`if (!host) return false`）：`--host ""` 是能过 `parseArgs` 的，
 * 而 `listen(0, '')` 实测绑的是 `::`（全网卡）—— 那正好把最危险的写法判成安全。
 *
 * **`127.0.0.2` 被判为暴露是刻意的**（多实例开发会多贴一次 token）。
 * 改成 `127.0.0.0/8` 前缀匹配是**放宽**判据，别顺手「优化」。
 */
export function isExposedDeployment(cfg: {
  host: string
  trustProxy?: boolean | undefined
  allowedHosts?: string[] | undefined
  tlsCert?: string | undefined
}): boolean {
  if (!LOOPBACK_HOSTS.has(cfg.host.toLowerCase())) return true
  if (cfg.trustProxy === true) return true
  if ((cfg.allowedHosts?.length ?? 0) > 0) return true
  if (cfg.tlsCert !== undefined) return true
  return false
}

/**
 * 常量时间比较。`expected` 为空一律为假 —— 「没配置 token」绝不能等价于「任何 token 都对」。
 *
 * **两条防线，缺一条都是真实的崩溃/挂死路径**（都实测过）：
 *
 * 1. `typeof given !== 'string'` **必须先判**。这是未鉴权的路由，
 *    `Buffer.from({length: 200000000})` 同步阻塞 **6.6 秒**、分配 200 MB ——
 *    攻击者只要一个 35 字节的 JSON body 就能把整个 daemon 冻住。
 * 2. 长度不等**必须先短路**。`timingSafeEqual` 长度不等会
 *    `throw ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`，那是一个 500。
 */
export function checkSetupToken(expected: string, given: unknown): boolean {
  if (!expected) return false
  if (typeof given !== 'string') return false
  if (given.length === 0 || given.length > MAX_TOKEN_LEN) return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(given, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
