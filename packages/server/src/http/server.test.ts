import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { PasswordStore } from '../auth/passwordStore.js'
import { LocalPasswordAuth } from '../auth/authProvider.js'
import { makeRequestHandler } from './server.js'

let dir: string, srv: Server, base: string
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'zuse-auth-'))
  const auth = new LocalPasswordAuth(new PasswordStore(dir), 3600)
  srv = createServer(makeRequestHandler({ auth, devPage: false }))
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const addr = srv.address(); const port = typeof addr === 'object' && addr ? addr.port : 0
  base = `http://127.0.0.1:${port}`
})
afterEach(async () => { await new Promise<void>((r) => srv.close(() => r())); rmSync(dir, { recursive: true, force: true }) })

const json = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

describe('http server', () => {
  it('GET /healthz → 200 ok', async () => {
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('ok')
  })
  it('auth flow: status→setup→login→protected', async () => {
    expect((await (await fetch(`${base}/api/auth/status`)).json()).configured).toBe(false)
    expect((await fetch(`${base}/api/auth/setup`, json({ password: 'pw' }))).status).toBe(200)
    const login = await fetch(`${base}/api/auth/login`, json({ password: 'pw' }))
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('zuse_session=')
    expect((await fetch(`${base}/api/auth/logout`, { method: 'POST' })).status).toBe(401)
    const ok = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: cookie.split(';')[0] ?? '' } })
    expect(ok.status).toBe(200)
  })
  it('login with wrong password → 401', async () => {
    await fetch(`${base}/api/auth/setup`, json({ password: 'pw' }))
    expect((await fetch(`${base}/api/auth/login`, json({ password: 'no' }))).status).toBe(401)
  })
  it('setup twice → 409', async () => {
    await fetch(`${base}/api/auth/setup`, json({ password: 'pw' }))
    expect((await fetch(`${base}/api/auth/setup`, json({ password: 'x' }))).status).toBe(409)
  })
})
