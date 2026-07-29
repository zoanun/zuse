import type { IncomingMessage } from 'node:http'
import type { TLSSocket } from 'node:tls'

/**
 * 这次请求在**客户端那一侧**是不是走的 HTTPS —— 用来决定会话 cookie 要不要打 Secure。
 *
 * - 直连 TLS：socket 是 TLSSocket,带 encrypted 标记。
 * - 隧道 / 反向代理(tailscale serve、cloudflared):外层已终止 TLS,daemon 收到的是回环明文,
 *   只能靠 X-Forwarded-Proto 得知。该头**任何客户端都能伪造**,所以仅在运维显式声明
 *   「我确实跑在可信前置之后」(--trust-proxy)时才采信。
 *   头可能是逗号分隔的链(`https, http`),取第一段 = 最靠近客户端的那一跳。
 */
export function isSecureRequest(req: IncomingMessage, trustProxy: boolean): boolean {
  if ((req.socket as TLSSocket | undefined)?.encrypted) return true
  if (!trustProxy) return false
  const raw = req.headers['x-forwarded-proto']
  const value = Array.isArray(raw) ? raw[0] : raw
  return value?.split(',')[0]?.trim().toLowerCase() === 'https'
}
