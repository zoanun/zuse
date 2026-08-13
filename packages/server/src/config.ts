import { homedir } from 'node:os'
import { join } from 'node:path'

export const SESSION_COOKIE = 'zuse_session'
/** F3 单会话的固定 id;多会话 id 生成留 S1。 */
export const DEFAULT_SESSION_ID = 'default'

export interface ServerConfig {
  host: string
  port: number
  authDir: string
  tokenTtlSec: number
  /** 会话工作目录(会话起始 cwd)。bin 传 INIT_CWD;缺省 process.cwd()。 */
  cwd: string
  /** 已构建的 web 目录(packages/web/dist);undefined → 回落到 dev page。 */
  webDir?: string
  /** TLS 证书 / 私钥文件路径(A2)。两者都给才启用 https;只给一半由 bin 报错退出。 */
  tlsCert?: string
  tlsKey?: string
  /** 信任前置代理/隧道的 X-Forwarded-Proto(A2)。默认 false。 */
  trustProxy?: boolean
  /**
   * 允许的 Host / Origin 域名（见 `http/originGuard.ts`）。回环名与 IP 字面量始终允许。
   * 也可用环境变量 `ZUSE_ALLOWED_HOSTS`（逗号分隔）—— 本仓的 `/restart` 技能、cron
   * 这类场景改环境变量比改命令行方便。**CLI 给了就整体覆盖 env，不做合并**：
   * 合并语义（是并集还是覆盖？重复怎么办？）没人猜得中，而猜错的后果是安全策略比预期宽。
   */
  allowedHosts?: string[]
}

export function defaultConfig(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 4180,
    authDir: join(homedir(), '.zuse'),
    tokenTtlSec: 60 * 60 * 24 * 30,
    cwd: process.cwd(),
    webDir: process.env.ZUSE_WEBDIR,
    allowedHosts: (process.env.ZUSE_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }
}
