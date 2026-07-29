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
 * **安全配置绝不静默降级**:「以为在跑 https、其实是明文」比直接崩溃危险得多。所以
 * 只给了 cert 或只给了 key —— 一个明显想要 TLS 却配错了的调用 —— 在这里**抛错**,
 * 而不是悄悄返回一个明文服务器。bin 里还有一层更早的 fail fast(能在启动 MCP 子进程、
 * 打开 sqlite 之前就退出,报错更干净),但 startServer 是公开导出,嵌入方不走 bin,
 * 所以这道闸必须在这里也有。
 * 证书同步读盘:读不到就在 listen 之前抛出,同样不会退化成明文监听。
 */
export function createAppServer(handler: RequestListener, tls: TlsPaths = {}): AppServer {
  if (tls.cert || tls.key) {
    if (!tls.cert || !tls.key) {
      throw new Error('TLS 配置不完整:cert 与 key 必须成对提供(拒绝退回明文)')
    }
    return {
      server: createHttpsServer({ cert: readFileSync(tls.cert), key: readFileSync(tls.key) }, handler),
      scheme: 'https',
    }
  }
  return { server: createHttpServer(handler), scheme: 'http' }
}
