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
}

export function defaultConfig(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 4180,
    authDir: join(homedir(), '.zuse'),
    tokenTtlSec: 60 * 60 * 24 * 30,
    cwd: process.cwd(),
    webDir: process.env.ZUSE_WEBDIR,
  }
}
