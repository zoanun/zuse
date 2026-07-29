import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpsRequest } from 'node:https'
import { get as httpGet } from 'node:http'
import { WebSocketServer } from 'ws'
import WebSocket from 'ws'
import { createAppServer } from './appServer.js'
import { TEST_CERT_PEM, TEST_KEY_PEM } from '../testCerts.js'

let dir: string | undefined
let close: (() => Promise<void>) | undefined

afterEach(async () => {
  await close?.()
  close = undefined
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined }
})

/** 把测试证书落到临时目录,返回两个路径。 */
function writeCerts(): { cert: string; key: string } {
  dir = mkdtempSync(join(tmpdir(), 'zuse-tls-'))
  const cert = join(dir, 'cert.pem')
  const key = join(dir, 'key.pem')
  writeFileSync(cert, TEST_CERT_PEM, 'utf8')
  writeFileSync(key, TEST_KEY_PEM, 'utf8')
  return { cert, key }
}

/** 起服务器并返回端口;close 由 afterEach 统一收。 */
async function listen(app: ReturnType<typeof createAppServer>): Promise<number> {
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()))
  close = () => new Promise<void>((r) => app.server.close(() => r()))
  const addr = app.server.address()
  return typeof addr === 'object' && addr ? addr.port : 0
}

const ok: Parameters<typeof createAppServer>[0] = (_req, res) => { res.writeHead(200); res.end('ok') }

describe('createAppServer', () => {
  it('无证书 → http', async () => {
    const app = createAppServer(ok)
    expect(app.scheme).toBe('http')
    const port = await listen(app)
    const body = await new Promise<string>((resolve, reject) => {
      httpGet(`http://127.0.0.1:${port}/`, (res) => {
        let s = ''
        res.on('data', (c) => { s += String(c) })
        res.on('end', () => resolve(s))
      }).on('error', reject)
    })
    expect(body).toBe('ok')
  })

  it('给了证书对 → https,可经 TLS 取到响应', async () => {
    const { cert, key } = writeCerts()
    const app = createAppServer(ok, { cert, key })
    expect(app.scheme).toBe('https')
    const port = await listen(app)
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpsRequest(
        { host: '127.0.0.1', port, path: '/', method: 'GET', rejectUnauthorized: false },
        (res) => resolve(res.statusCode ?? 0),
      )
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(200)
  })

  it('https 下 WebSocket 能经 wss 升级(WS 挂的是同一个 server)', async () => {
    const { cert, key } = writeCerts()
    const app = createAppServer(ok, { cert, key })
    const wss = new WebSocketServer({ noServer: true })
    app.server.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket as never, head, (ws) => ws.send('hello'))
    })
    const port = await listen(app)
    const msg = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { rejectUnauthorized: false })
      ws.on('message', (d) => { resolve(String(d)); ws.close() })
      ws.on('error', reject)
    })
    expect(msg).toBe('hello')
    wss.close()
  })

  it('只给证书或只给私钥 → 抛错,绝不静默退回明文', () => {
    const { cert, key } = writeCerts()
    // 「以为在跑 https、其实是明文」是本特性最危险的失败形态:半配置必须炸,不能降级。
    expect(() => createAppServer(ok, { cert })).toThrow(/成对/)
    expect(() => createAppServer(ok, { key })).toThrow(/成对/)
  })

  it('完全没配 TLS → 正常 http(不是半配置,不该抛)', () => {
    expect(createAppServer(ok, {}).scheme).toBe('http')
  })
})
