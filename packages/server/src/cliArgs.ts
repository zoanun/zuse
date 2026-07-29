export interface ParsedArgs {
  port?: number
  host?: string
  setPassword: boolean
  /** TLS 证书 / 私钥路径(A2)。两者都给才启用 https;只给一半由 bin 报错退出。 */
  tlsCert?: string
  tlsKey?: string
  /** 信任前置代理/隧道的 X-Forwarded-Proto(A2)。缺省不出现 = 不信任。 */
  trustProxy?: boolean
}

/**
 * Pure CLI argument parser for the zuse-server bin.
 * Recognizes: --port <n>, --host <h>, --set-password, --tls-cert <path>, --tls-key <path>, --trust-proxy.
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
    }
  }
  return result
}
