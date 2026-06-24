# F1 — Server + Transport + Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `@zuse/server` into a runnable `node:http` + `ws` server with a local password gate (scrypt hash + HMAC-signed session cookie), health/auth routes, an auth-gated `/ws` echo endpoint, and a throwaway inline dev test page so the whole pipe is browser-testable — all with zero `@zuse/tui` dependency.

**Architecture:** Pure crypto/auth modules (node:crypto only) → an `AuthProvider` (LocalPasswordAuth) → a hand-routed `node:http` server with an auth middleware → a `ws` WebSocketServer whose upgrade is cookie-authenticated (echo for now; F3 wires SessionManager) → `startServer()` assembly + a `zuse-server` bin. SessionManager wiring, the real SPA, and TLS are out of scope (F3/F4/A2).

**Tech Stack:** TypeScript (ESM, Node ≥22), vitest, `node:http`, `node:crypto`, `ws` (only new runtime dep).

**Spec:** `docs/superpowers/specs/2026-06-24-F1-server-transport-auth-design.md`

**Conventions (from F2 experience):**
- Run server tests from REPO ROOT: `npx vitest run packages/server` (root vitest config; no per-package test script).
- Typecheck: `pnpm -F @zuse/server typecheck`.
- Verify every external API by reading real source before asserting (project rule). `new Date()`/timers are fine (server runtime).
- Each commit message ends with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/server/package.json` | add `ws` dep + `bin` |
| `packages/server/src/auth/hash.ts` | scrypt password hash + timing-safe verify |
| `packages/server/src/auth/token.ts` | HMAC-SHA256 signed session token sign/verify |
| `packages/server/src/auth/passwordStore.ts` | read/write `~/.zuse/web-auth.json` (hash + tokenSecret) |
| `packages/server/src/auth/authProvider.ts` | `AuthProvider` interface + `LocalPasswordAuth` |
| `packages/server/src/http/cookies.ts` | parse/serialize Set-Cookie |
| `packages/server/src/http/server.ts` | node:http server, routing, WS upgrade dispatch |
| `packages/server/src/http/devPage.ts` | inline HTML dev test page |
| `packages/server/src/ws/wsServer.ts` | ws WebSocketServer, cookie-auth, echo |
| `packages/server/src/config.ts` | `ServerConfig` + defaults |
| `packages/server/src/startServer.ts` | assemble + listen + `{url, close()}` |
| `packages/server/src/bin.ts` | CLI entry (`zuse-server`) |
| (tests alongside each) | unit + integration |

---

## Task 1: Add `ws` dependency + bin field

**Files:** Modify `packages/server/package.json`.

- [ ] **Step 1: Read the current manifest**

Run: `cat packages/server/package.json`. Note current deps (`@zuse/core`, `@zuse/tools`), `type: module`, exports.

- [ ] **Step 2: Add `ws` runtime dep + its types + bin field**

Add to `dependencies`: `"ws": "^8.18.0"`. Add to `devDependencies`: `"@types/ws": "^8.5.12"`. Add a `bin` field:
```json
"bin": { "zuse-server": "./dist/bin.js" }
```
(Verify latest compatible `ws`/`@types/ws` versions exist; if the repo pins exact, match the style of sibling packages.)

- [ ] **Step 3: Install**

Run: `pnpm install`. Expected: lockfile updates, `ws` resolves.

- [ ] **Step 4: Verify existing tests still green**

Run: `npx vitest run packages/server`. Expected: the existing 30 F2 tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/server/package.json pnpm-lock.yaml
git commit -m "chore(server): add ws dependency and zuse-server bin field

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `auth/hash.ts` — scrypt password hashing

**Files:** Create `packages/server/src/auth/hash.ts`, `packages/server/src/auth/hash.test.ts`.

- [ ] **Step 1: Write failing tests**

`hash.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from './hash.js'

describe('password hashing', () => {
  it('hashes then verifies the same password', () => {
    const h = hashPassword('correct horse')
    expect(h.startsWith('scrypt$')).toBe(true)
    expect(verifyPassword('correct horse', h)).toBe(true)
  })
  it('rejects a wrong password', () => {
    const h = hashPassword('correct horse')
    expect(verifyPassword('wrong', h)).toBe(false)
  })
  it('produces a different salt/hash each call for the same password', () => {
    expect(hashPassword('x')).not.toBe(hashPassword('x'))
  })
  it('verify returns false on a malformed stored hash', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false)
  })
})
```

- [ ] **Step 2: Run — verify FAIL**

Run: `npx vitest run packages/server/src/auth/hash`.

- [ ] **Step 3: Implement**

`hash.ts`:
```ts
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto'

const N = 16384, KEYLEN = 64

/** Returns `scrypt$<N>$<saltB64>$<hashB64>`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEYLEN, { N })
  return `scrypt$${N}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1])
  if (!Number.isInteger(n) || n <= 1) return false
  let salt: Buffer, expected: Buffer
  try {
    salt = Buffer.from(parts[2], 'base64')
    expected = Buffer.from(parts[3], 'base64')
  } catch { return false }
  let actual: Buffer
  try { actual = scryptSync(password, salt, expected.length, { N: n }) }
  catch { return false }
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
```

- [ ] **Step 4: Run — verify PASS.** `npx vitest run packages/server/src/auth/hash`
- [ ] **Step 5: Commit** `feat(server): scrypt password hashing`

---

## Task 3: `auth/token.ts` — HMAC-signed session token

**Files:** Create `packages/server/src/auth/token.ts`, `token.test.ts`.

- [ ] **Step 1: Write failing tests**

`token.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { signToken, verifyToken } from './token.js'

const secret = 'test-secret-base64-or-any-string'

describe('session token', () => {
  it('signs then verifies', () => {
    const t = signToken(secret, 3600)
    expect(verifyToken(secret, t)).toBe(true)
  })
  it('rejects a token signed with a different secret', () => {
    const t = signToken(secret, 3600)
    expect(verifyToken('other-secret', t)).toBe(false)
  })
  it('rejects a tampered token', () => {
    const t = signToken(secret, 3600)
    expect(verifyToken(secret, t + 'x')).toBe(false)
  })
  it('rejects an expired token', () => {
    const t = signToken(secret, -1) // already expired
    expect(verifyToken(secret, t)).toBe(false)
  })
  it('rejects garbage', () => {
    expect(verifyToken(secret, 'garbage')).toBe(false)
  })
})
```

- [ ] **Step 2: Run — verify FAIL.**

- [ ] **Step 3: Implement**

`token.ts`:
```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

function b64url(buf: Buffer): string { return buf.toString('base64url') }
function hmac(secret: string, data: string): Buffer { return createHmac('sha256', secret).update(data).digest() }

/** token = base64url(payloadJSON) + "." + base64url(hmac). payload = { iat, exp } (seconds). */
export function signToken(secret: string, ttlSec: number): string {
  const now = Math.floor(nowMs() / 1000)
  const payload = JSON.stringify({ iat: now, exp: now + ttlSec })
  const p = b64url(Buffer.from(payload, 'utf8'))
  const sig = b64url(hmac(secret, p))
  return `${p}.${sig}`
}

export function verifyToken(secret: string, token: string): boolean {
  const dot = token.indexOf('.')
  if (dot <= 0) return false
  const p = token.slice(0, dot), sig = token.slice(dot + 1)
  let expected: Buffer, given: Buffer
  try { expected = hmac(secret, p); given = Buffer.from(sig, 'base64url') }
  catch { return false }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false
  let payload: { exp?: number }
  try { payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) }
  catch { return false }
  return typeof payload.exp === 'number' && Math.floor(nowMs() / 1000) < payload.exp
}

function nowMs(): number { return Date.now() }
```
(`Date.now()` is fine here — this is server runtime, not a workflow script.)

- [ ] **Step 4: Run — verify PASS.**
- [ ] **Step 5: Commit** `feat(server): HMAC-signed session tokens`

---

## Task 4: `auth/passwordStore.ts` — `~/.zuse/web-auth.json`

**Files:** Create `packages/server/src/auth/passwordStore.ts`, `passwordStore.test.ts`.

- [ ] **Step 1: Write failing tests** (use a temp dir, NOT the real home)

`passwordStore.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PasswordStore } from './passwordStore.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'zuse-auth-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('PasswordStore', () => {
  it('reports no password initially and generates a persistent tokenSecret', () => {
    const s = new PasswordStore(dir)
    expect(s.hasPassword()).toBe(false)
    const sec1 = s.getTokenSecret()
    expect(sec1.length).toBeGreaterThan(0)
    // secret is stable across instances (persisted)
    expect(new PasswordStore(dir).getTokenSecret()).toBe(sec1)
  })
  it('persists a password hash and reads it back', () => {
    const s = new PasswordStore(dir)
    s.setPasswordHash('scrypt$16384$abc$def')
    expect(s.hasPassword()).toBe(true)
    expect(new PasswordStore(dir).getPasswordHash()).toBe('scrypt$16384$abc$def')
  })
})
```

- [ ] **Step 2: Run — verify FAIL.**

- [ ] **Step 3: Implement** (file at `<dir>/web-auth.json`; create dir if missing; chmod 0600 best-effort)

`passwordStore.ts`:
```ts
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

interface AuthFile { version: 1; passwordHash?: string; tokenSecret: string }

export class PasswordStore {
  private readonly path: string
  private data: AuthFile

  constructor(dir: string) {
    this.path = join(dir, 'web-auth.json')
    this.data = this.load(dir)
  }

  private load(dir: string): AuthFile {
    if (existsSync(this.path)) {
      try {
        const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<AuthFile>
        if (parsed && typeof parsed.tokenSecret === 'string') {
          return { version: 1, passwordHash: parsed.passwordHash, tokenSecret: parsed.tokenSecret }
        }
      } catch { /* fall through to fresh */ }
    }
    const fresh: AuthFile = { version: 1, tokenSecret: randomBytes(32).toString('base64') }
    mkdirSync(dir, { recursive: true })
    this.persist(fresh)
    return fresh
  }

  private persist(data: AuthFile): void {
    writeFileSync(this.path, JSON.stringify(data, null, 2), 'utf8')
    try { chmodSync(this.path, 0o600) } catch { /* windows / best-effort */ }
  }

  hasPassword(): boolean { return typeof this.data.passwordHash === 'string' && this.data.passwordHash.length > 0 }
  getPasswordHash(): string | undefined { return this.data.passwordHash }
  setPasswordHash(hash: string): void { this.data.passwordHash = hash; this.persist(this.data) }
  getTokenSecret(): string { return this.data.tokenSecret }
}
```

- [ ] **Step 4: Run — verify PASS.**
- [ ] **Step 5: Commit** `feat(server): password/secret store at ~/.zuse/web-auth.json`

---

## Task 5: `auth/authProvider.ts` — interface + LocalPasswordAuth

**Files:** Create `packages/server/src/auth/authProvider.ts`, `authProvider.test.ts`.

- [ ] **Step 1: Write failing tests** (temp dir store)

`authProvider.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PasswordStore } from './passwordStore.js'
import { LocalPasswordAuth } from './authProvider.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'zuse-auth-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function auth() { return new LocalPasswordAuth(new PasswordStore(dir), 3600) }

describe('LocalPasswordAuth', () => {
  it('not configured initially; setup then configured', async () => {
    const a = auth()
    expect(await a.isConfigured()).toBe(false)
    await a.setup('pw')
    expect(await a.isConfigured()).toBe(true)
  })
  it('verifyCredential true for right, false for wrong', async () => {
    const a = auth(); await a.setup('pw')
    expect(await a.verifyCredential('pw')).toBe(true)
    expect(await a.verifyCredential('nope')).toBe(false)
  })
  it('issued token verifies; tampered does not', async () => {
    const a = auth(); await a.setup('pw')
    const t = a.issueToken()
    expect(a.verifyToken(t)).toBe(true)
    expect(a.verifyToken(t + 'x')).toBe(false)
  })
  it('setup twice throws (already configured)', async () => {
    const a = auth(); await a.setup('pw')
    await expect(a.setup('again')).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run — verify FAIL.**

- [ ] **Step 3: Implement**

`authProvider.ts`:
```ts
import { hashPassword, verifyPassword } from './hash.js'
import { signToken, verifyToken } from './token.js'
import type { PasswordStore } from './passwordStore.js'

export interface AuthProvider {
  isConfigured(): Promise<boolean>
  setup(secret: string): Promise<void>
  verifyCredential(secret: string): Promise<boolean>
  issueToken(): string
  verifyToken(token: string): boolean
}

export class LocalPasswordAuth implements AuthProvider {
  constructor(private readonly store: PasswordStore, private readonly tokenTtlSec: number) {}
  async isConfigured(): Promise<boolean> { return this.store.hasPassword() }
  async setup(secret: string): Promise<void> {
    if (this.store.hasPassword()) throw new Error('Password already configured')
    if (!secret) throw new Error('Password must not be empty')
    this.store.setPasswordHash(hashPassword(secret))
  }
  async verifyCredential(secret: string): Promise<boolean> {
    const h = this.store.getPasswordHash()
    return h ? verifyPassword(secret, h) : false
  }
  issueToken(): string { return signToken(this.store.getTokenSecret(), this.tokenTtlSec) }
  verifyToken(token: string): boolean { return verifyToken(this.store.getTokenSecret(), token) }
}
```

- [ ] **Step 4: Run — verify PASS.**
- [ ] **Step 5: Commit** `feat(server): AuthProvider interface + LocalPasswordAuth`

---

## Task 6: `http/cookies.ts` — cookie parse/serialize

**Files:** Create `packages/server/src/http/cookies.ts`, `cookies.test.ts`.

- [ ] **Step 1: Write failing tests**

`cookies.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parseCookies, serializeCookie } from './cookies.js'

describe('cookies', () => {
  it('parses a Cookie header', () => {
    expect(parseCookies('a=1; zuse_session=abc.def')).toEqual({ a: '1', zuse_session: 'abc.def' })
  })
  it('parses empty/undefined to {}', () => {
    expect(parseCookies(undefined)).toEqual({})
    expect(parseCookies('')).toEqual({})
  })
  it('serializes an httpOnly cookie', () => {
    const c = serializeCookie('zuse_session', 'v', { httpOnly: true, sameSite: 'Lax', maxAgeSec: 60, secure: false })
    expect(c).toContain('zuse_session=v')
    expect(c).toContain('HttpOnly')
    expect(c).toContain('SameSite=Lax')
    expect(c).toContain('Max-Age=60')
    expect(c).not.toContain('Secure')
  })
  it('adds Secure when requested', () => {
    expect(serializeCookie('k', 'v', { secure: true })).toContain('Secure')
  })
})
```

- [ ] **Step 2: Run — verify FAIL.**

- [ ] **Step 3: Implement**

`cookies.ts`:
```ts
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k) out[k] = v
  }
  return out
}

export interface CookieOpts { httpOnly?: boolean; sameSite?: 'Lax' | 'Strict' | 'None'; maxAgeSec?: number; secure?: boolean; path?: string }

export function serializeCookie(name: string, value: string, opts: CookieOpts = {}): string {
  const segs = [`${name}=${value}`, `Path=${opts.path ?? '/'}`]
  if (opts.maxAgeSec !== undefined) segs.push(`Max-Age=${opts.maxAgeSec}`)
  if (opts.httpOnly) segs.push('HttpOnly')
  if (opts.sameSite) segs.push(`SameSite=${opts.sameSite}`)
  if (opts.secure) segs.push('Secure')
  return segs.join('; ')
}
```

- [ ] **Step 4: Run — verify PASS.**
- [ ] **Step 5: Commit** `feat(server): cookie parse/serialize helpers`

---

## Task 7: `config.ts` + `http/server.ts` + routes (health/auth) — integration

**Files:** Create `packages/server/src/config.ts`, `packages/server/src/http/server.ts`, `packages/server/src/http/server.test.ts`.

> This task builds the HTTP server with routing for `/healthz`, `/api/auth/status|setup|login|logout`, an auth middleware, and a login backoff. The `/ws` upgrade + dev page are added in Tasks 8–9. SessionManager is NOT involved.

- [ ] **Step 1: Define `ServerConfig` (`config.ts`)**

```ts
export const SESSION_COOKIE = 'zuse_session'
export interface ServerConfig {
  host: string        // default 127.0.0.1
  port: number        // default 4180
  authDir: string     // default os.homedir()/.zuse
  tokenTtlSec: number // default 30 days
}
export function defaultConfig(): ServerConfig {
  return { host: '127.0.0.1', port: 4180, authDir: requireHome(), tokenTtlSec: 60 * 60 * 24 * 30 }
}
```
(Implement `requireHome()` via `os.homedir()` + `join('.zuse')`. Read `node:os`/`node:path`.)

- [ ] **Step 2: Write failing integration test (`server.test.ts`)** — create the http server with a temp-dir auth, listen on port 0, drive it with `fetch`.

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { PasswordStore } from '../auth/passwordStore.js'
import { LocalPasswordAuth } from '../auth/authProvider.js'
import { makeRequestHandler } from './server.js'

let dir: string, srv: ReturnType<typeof createServer>, base: string
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'zuse-auth-'))
  const auth = new LocalPasswordAuth(new PasswordStore(dir), 3600)
  srv = createServer(makeRequestHandler({ auth, devPage: false }))
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const addr = srv.address(); const port = typeof addr === 'object' && addr ? addr.port : 0
  base = `http://127.0.0.1:${port}`
})
afterEach(async () => { await new Promise<void>((r) => srv.close(() => r())); rmSync(dir, { recursive: true, force: true }) })

describe('http server', () => {
  it('GET /healthz → 200 ok', async () => {
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('ok')
  })
  it('auth flow: status→setup→login→protected', async () => {
    expect((await (await fetch(`${base}/api/auth/status`)).json()).configured).toBe(false)
    const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', body: JSON.stringify({ password: 'pw' }), headers: { 'content-type': 'application/json' } })
    expect(setup.status).toBe(200)
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', body: JSON.stringify({ password: 'pw' }), headers: { 'content-type': 'application/json' } })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('zuse_session=')
    // a protected API (logout) requires the cookie
    expect((await fetch(`${base}/api/auth/logout`, { method: 'POST' })).status).toBe(401)
    const ok = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: cookie.split(';')[0] } })
    expect(ok.status).toBe(200)
  })
  it('login with wrong password → 401', async () => {
    await fetch(`${base}/api/auth/setup`, { method: 'POST', body: JSON.stringify({ password: 'pw' }), headers: { 'content-type': 'application/json' } })
    expect((await fetch(`${base}/api/auth/login`, { method: 'POST', body: JSON.stringify({ password: 'no' }), headers: { 'content-type': 'application/json' } })).status).toBe(401)
  })
  it('setup twice → 409', async () => {
    await fetch(`${base}/api/auth/setup`, { method: 'POST', body: JSON.stringify({ password: 'pw' }), headers: { 'content-type': 'application/json' } })
    expect((await fetch(`${base}/api/auth/setup`, { method: 'POST', body: JSON.stringify({ password: 'x' }), headers: { 'content-type': 'application/json' } })).status).toBe(409)
  })
})
```

- [ ] **Step 3: Run — verify FAIL.**

- [ ] **Step 4: Implement `makeRequestHandler` (`http/server.ts`)**

Implement a `(deps: { auth: AuthProvider; devPage: boolean }) => http.RequestListener` that:
- reads `URL`, dispatches by method+pathname;
- `GET /healthz` → 200 `{status:'ok', version: VERSION}` (import `VERSION` from `@zuse/core` if available, else a local const);
- `GET /api/auth/status` → `{configured: await auth.isConfigured(), authenticated: <cookie token valid>}`;
- `POST /api/auth/setup` → if already configured 409; else read JSON body `{password}`, `await auth.setup(password)`, 200;
- `POST /api/auth/login` → read `{password}`; apply backoff (see below); if `await auth.verifyCredential` → set-cookie `SESSION_COOKIE = auth.issueToken()` (httpOnly, SameSite=Lax, Max-Age=ttl, Secure only if behind TLS — for now false), 200; else 401;
- `POST /api/auth/logout` → require valid token (else 401); clear cookie (Max-Age=0), 200;
- unknown → 404 `{error:{code,message}}`.
- **Auth check helper**: parse cookie, `auth.verifyToken(cookies[SESSION_COOKIE])`.
- **Login backoff**: module-level failure counter + a small awaited delay that grows with consecutive failures (reset on success). Keep simple (in-memory). Cap the delay (e.g. ≤2s) so tests don't hang.
- Provide a JSON body reader (await the request stream, JSON.parse, guard errors → 400).
- Export `makeRequestHandler`. (The `/ws` upgrade and `GET /` dev page are wired in Tasks 8–9 — leave clear extension points; `devPage` flag reserved.)

- [ ] **Step 5: Run — verify PASS.** `npx vitest run packages/server/src/http/server`
- [ ] **Step 6: Typecheck + Commit** `feat(server): http server with health + password-gate auth routes`

---

## Task 8: `ws/wsServer.ts` — cookie-authed WebSocket echo + upgrade wiring

**Files:** Create `packages/server/src/ws/wsServer.ts`, `ws/wsServer.test.ts`; Modify `http/server.ts` (wire upgrade).

- [ ] **Step 1: Write failing integration test** — start the full server (http + ws), connect a `ws` client with/without a valid cookie.

`wsServer.test.ts`:
```ts
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
  await fetch(`${server.url}/api/auth/setup`, { method: 'POST', body: JSON.stringify({ password: 'pw' }), headers: { 'content-type': 'application/json' } })
  const login = await fetch(`${server.url}/api/auth/login`, { method: 'POST', body: JSON.stringify({ password: 'pw' }), headers: { 'content-type': 'application/json' } })
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
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
    const ws = new WebSocket(wsUrl(server.url)) // no cookie
    const closed = await new Promise<boolean>((resolve) => {
      ws.on('open', () => { ws.close(); resolve(false) })  // should NOT open
      ws.on('error', () => resolve(true))
      ws.on('unexpected-response', () => resolve(true))
    })
    expect(closed).toBe(true)
  })
})
```
> `startServer` is built in Task 10 but this test needs it — implement Task 10's `startServer` first OR write a thin inline assembly here. RECOMMENDED ORDER: do Task 10's `startServer` skeleton before Task 8's test, or merge the assembly. The implementer may reorder: build `wsServer.ts` + a minimal `startServer` together. Adjust as needed; keep each commit green.

- [ ] **Step 2: Run — verify FAIL.**

- [ ] **Step 3: Implement `ws/wsServer.ts`**

Use `ws`'s `WebSocketServer({ noServer: true })`. Export `attachWsServer(httpServer, { auth })` that handles the http `'upgrade'` event: only for `pathname === '/ws'`; parse cookie from `req.headers.cookie`; if `auth.verifyToken(cookies[SESSION_COOKIE])` → `wss.handleUpgrade(...)` and on connection register an **echo** handler (`ws.on('message', m => ws.send(\`echo: ${m}\`))`); else `socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy()`. (Read `ws` docs/types for `handleUpgrade` signature.)

- [ ] **Step 4: Wire upgrade in the assembly** (in `startServer`, Task 10): call `attachWsServer(httpServer, { auth })`.

- [ ] **Step 5: Run — verify PASS.**
- [ ] **Step 6: Commit** `feat(server): cookie-authenticated WebSocket echo endpoint`

---

## Task 9: `http/devPage.ts` — inline dev test page at `/`

**Files:** Create `packages/server/src/http/devPage.ts`, `devPage.test.ts`; Modify `http/server.ts` (serve `/`).

- [ ] **Step 1: Write failing test**

`devPage.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { DEV_PAGE_HTML } from './devPage.js'

describe('dev page', () => {
  it('is self-contained HTML mentioning the auth + ws flow', () => {
    expect(DEV_PAGE_HTML).toContain('<!doctype html>')
    expect(DEV_PAGE_HTML).toContain('/api/auth/login')
    expect(DEV_PAGE_HTML).toContain('/ws')
    expect(DEV_PAGE_HTML).toContain('DEV TEST PAGE')
  })
})
```

- [ ] **Step 2: Run — verify FAIL.**

- [ ] **Step 3: Implement `devPage.ts`** — export `const DEV_PAGE_HTML` (a single self-contained string): `<!doctype html>` + `<!-- DEV TEST PAGE — replaced by the real SPA in F4 -->` + inline `<style>` + inline `<script>` that: calls `/api/auth/status`; shows a set-password form (if `!configured`) posting `/api/auth/setup`, else a login form posting `/api/auth/login`; after login opens `new WebSocket('ws://'+location.host+'/ws')`, with an input + send button echoing messages into a `<ul>`; shows `/healthz` version at top. No external resources.

- [ ] **Step 4: Serve it** in `makeRequestHandler`: `GET /` → 200 `text/html` `DEV_PAGE_HTML` (no auth on the page load itself).

- [ ] **Step 5: Run — verify PASS** + add an integration assertion (optional): `GET /` returns 200 text/html.
- [ ] **Step 6: Commit** `feat(server): inline dev test page at / (throwaway, F4 replaces)`

---

## Task 10: `startServer.ts` + `bin.ts` — assembly + CLI

**Files:** Create `packages/server/src/startServer.ts`, `startServer.test.ts`, `packages/server/src/bin.ts`; Modify `packages/server/src/index.ts` (export `startServer`, `ServerConfig`).

- [ ] **Step 1: Write failing test (`startServer.test.ts`)** — assert start→`/healthz`→close.

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from './startServer.js'

describe('startServer', () => {
  it('starts, serves /healthz, and closes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zuse-auth-'))
    const s = await startServer({ host: '127.0.0.1', port: 0, authDir: dir, tokenTtlSec: 3600 })
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect((await fetch(`${s.url}/healthz`)).status).toBe(200)
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run — verify FAIL.**

- [ ] **Step 3: Implement `startServer.ts`**

```ts
import { createServer } from 'node:http'
import { PasswordStore } from './auth/passwordStore.js'
import { LocalPasswordAuth } from './auth/authProvider.js'
import { makeRequestHandler } from './http/server.js'
import { attachWsServer } from './ws/wsServer.js'
import type { ServerConfig } from './config.js'

export async function startServer(cfg: ServerConfig): Promise<{ url: string; close(): Promise<void> }> {
  const auth = new LocalPasswordAuth(new PasswordStore(cfg.authDir), cfg.tokenTtlSec)
  const httpServer = createServer(makeRequestHandler({ auth, devPage: true }))
  attachWsServer(httpServer, { auth })
  await new Promise<void>((resolve) => httpServer.listen(cfg.port, cfg.host, resolve))
  const addr = httpServer.address()
  const port = typeof addr === 'object' && addr ? addr.port : cfg.port
  if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost') {
    console.warn(`[zuse-server] bound to ${cfg.host}:${port} — plaintext HTTP on a network interface. Use a TLS tunnel (A2) for remote access.`)
  }
  return {
    url: `http://${cfg.host}:${port}`,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  }
}
```

- [ ] **Step 4: Run — verify PASS.**

- [ ] **Step 5: Implement `bin.ts`** (CLI): parse `--port`/`--host`/`--set-password` from `process.argv`; merge over `defaultConfig()`; if `--set-password`, run an interactive/stdin set-password flow against a `LocalPasswordAuth` then exit; else `startServer(cfg)` and log the URL; handle SIGINT → `close()`. Add a shebang `#!/usr/bin/env node` at top. (No test required for the bin's argv parsing beyond a tiny pure `parseArgs` unit test if you extract one — optional.)

- [ ] **Step 6: Update `index.ts`** — `export { startServer } from './startServer.js'`, `export type { ServerConfig } from './config.js'`, `export { defaultConfig } from './config.js'`.

- [ ] **Step 7: Full suite + typecheck**

Run: `npx vitest run packages/server` (all F1 + F2 tests green) and `pnpm -F @zuse/server typecheck`.

- [ ] **Step 8: Manual browser smoke (report to controller)** — `npx tsx packages/server/src/bin.ts` (or built), open `http://127.0.0.1:4180/`, set password, login, echo a message. (Controller verifies via the verify/run flow.)

- [ ] **Step 9: Commit** `feat(server): startServer assembly + zuse-server bin (F1 complete)`

---

## Self-Review notes (verify at implementation time)
1. **`ws` API**: confirm `WebSocketServer({noServer:true})` + `handleUpgrade(req, socket, head, cb)` signature against installed `ws` types before Task 8.
2. **`http.RequestListener` typing** and Node global `fetch` (Node ≥22 has global fetch — used in tests).
3. **`VERSION`** import source (`@zuse/core` exports `VERSION`? confirm; else local const).
4. **Backoff** must be bounded so integration tests don't hang.
5. **Test ordering**: Task 8's WS test depends on `startServer` (Task 10). Implementer may build a minimal `startServer` before Task 8 or merge; keep every commit green.
6. **No `@zuse/tui` import** anywhere in `packages/server` (decoupling — grep before final commit).
7. `bin.ts` must not hang in non-interactive contexts (read password from stdin/env when no TTY).
