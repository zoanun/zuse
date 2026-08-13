export interface ParsedArgs {
  port?: number
  host?: string
  setPassword: boolean
  /** TLS 证书 / 私钥路径(A2)。两者都给才启用 https;只给一半由 bin 报错退出。 */
  tlsCert?: string
  tlsKey?: string
  /** 信任前置代理/隧道的 X-Forwarded-Proto(A2)。缺省不出现 = 不信任。 */
  trustProxy?: boolean
  /**
   * 允许的 Host / Origin 域名（可重复给，也可逗号分隔）。支持 `*.suffix` 通配；
   * 裸 `*` 是逃生口（关掉 Host 白名单，启动横幅会告警）。
   * 回环名与 IP 字面量**始终**允许，不用写。见 `http/originGuard.ts`。
   */
  allowedHosts?: string[]
}

/**
 * Pure CLI argument parser for the zuse-server bin.
 * Recognizes: --port <n>, --host <h>, --set-password, --tls-cert <path>, --tls-key <path>,
 * --trust-proxy, --allowed-host <name>（可重复 / 逗号分隔）。
 * An invalid --port value (non-integer / non-positive) is ignored (leaves port undefined).
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { setPassword: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--set-password') {
      result.setPassword = true
    } else if (arg === '--port') {
      const raw = argv[++i]
      const n = Number(raw)
      if (raw !== undefined && Number.isInteger(n) && n >= 0 && n <= 65535) {
        result.port = n
      }
    } else if (arg === '--host') {
      const h = argv[++i]
      if (h !== undefined) result.host = h
    } else if (arg === '--tls-cert') {
      const p = argv[++i]
      if (p !== undefined) result.tlsCert = p
    } else if (arg === '--tls-key') {
      const p = argv[++i]
      if (p !== undefined) result.tlsKey = p
    } else if (arg === '--trust-proxy') {
      result.trustProxy = true
    } else if (arg === '--allowed-host') {
      // 逗号分隔也吃下（`--allowed-host a.com,b.com` 与重复给等价）—— 省得用户猜哪种写法对。
      const v = argv[++i]
      if (v !== undefined) {
        (result.allowedHosts ??= []).push(...v.split(',').map((s) => s.trim()).filter(Boolean))
      }
    }
  }
  return result
}
