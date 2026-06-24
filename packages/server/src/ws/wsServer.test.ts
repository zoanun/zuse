import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { startServer } from '../startServer.js'

let dir: string, server: Awaited<ReturnType<typeof startServer>>, cookie: string
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'zuse-auth-'))
  server = await startServer({ host: '127.0.0.1', port: 0, authDir: dir, tokenTtlSec: 3600 })
  const json = (b: unknown) => ({ method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } })
  await fetch(`${server.url}/api/auth/setup`, json({ password: 'pw' }))
  const login = await fetch(`${server.url}/api/auth/login`, json({ password: 'pw' }))
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
})
afterEach(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }) })

function wsUrl(u: string) { return u.replace('http', 'ws') + '/ws' }

describe('ws echo', () => {
  it('authed client echoes', async () => {
    const ws = new WebSocket(wsUrl(server.url), { headers: { cookie } })
    const msg = await new Promise<string>((resolve, reject) => {
      ws.on('open', () => ws.send('ping'))
      ws.on('message', (d) => resolve(d.toString()))
      ws.on('error', reject)
    })
    expect(msg).toContain('ping')
    ws.close()
  })
  it('unauthenticated client is rejected', async () => {
    const ws = new WebSocket(wsUrl(server.url))
    const rejected = await new Promise<boolean>((resolve) => {
      ws.on('open', () => { ws.close(); resolve(false) })
      ws.on('close', () => resolve(true))
      ws.on('error', () => resolve(true))
      ws.on('unexpected-response', () => resolve(true))
    })
    expect(rejected).toBe(true)
  })
})
