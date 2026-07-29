import { createServer as createHttpServer, type RequestListener, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { readFileSync } from 'node:fs'

/** 监听服务器 + 它对外的 scheme(WS 也随之 ws/wss —— 同一个 server 的 upgrade 事件)。 */
export interface AppServer {
  server: HttpServer | HttpsServer
  scheme: 'http' | 'https'
}

export interface TlsPaths {
  cert?: string
  key?: string
}

/**
 * 按是否配了证书对决定起 http 还是 https(A2)。
 *
 * 两者都给才走 TLS —— 只给一半在 bin 里已 fail fast 退出(安全配置**不静默降级**:
 * 「以为在跑 https、其实是明文」比直接崩溃危险得多)。这里再判一次是纯防御。
 * 证书在此处同步读盘:读不到就应当在监听之前抛出,而不是起一个明文服务器。
 */
export function createAppServer(handler: RequestListener, tls: TlsPaths = {}): AppServer {
  if (tls.cert && tls.key) {
    return {
      server: createHttpsServer({ cert: readFileSync(tls.cert), key: readFileSync(tls.key) }, handler),
      scheme: 'https',
    }
  }
  return { server: createHttpServer(handler), scheme: 'http' }
}
