import { homedir } from 'node:os'
import { join } from 'node:path'

export const SESSION_COOKIE = 'zuse_session'

export interface ServerConfig {
  host: string
  port: number
  authDir: string
  tokenTtlSec: number
}

export function defaultConfig(): ServerConfig {
  return { host: '127.0.0.1', port: 4180, authDir: join(homedir(), '.zuse'), tokenTtlSec: 60 * 60 * 24 * 30 }
}
