# A2 远程访问（TLS / 隧道）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让远程访问跑在加密信道上：支持直连 TLS（自带证书）与隧道（tailscale / cloudflared）两条路径，并修掉会话 cookie 缺 `Secure` 的真隐患。

**Architecture:** 新增 `isSecureRequest(req, trustProxy)` 判定「客户端那侧是不是 https」（直连看 `socket.encrypted`；仅在显式 `--trust-proxy` 时才认 `X-Forwarded-Proto`），登录/登出 cookie 的 `Secure` 据此自适应；`--tls-cert/--tls-key` 让 `startServer` 改用 `node:https`（WS 同 server 升级即变 wss）；启动横幅按模式三分支。

**Tech Stack:** TypeScript（纯）、`node:https`、`node:tls`、vitest。**零新依赖**。

**Spec:** `docs/superpowers/specs/2026-07-29-A2-remote-access-tls-design.md`

**分支**：从 master 切 `a2-remote-access`。

**约束**：不改 `packages/web`（**故 /ship 的 Playwright 环节 N/A**）；server 无 test 脚本 → 根 vitest（`pnpm exec vitest run packages/server`）；typecheck `pnpm --filter @zouyj/zuse-server exec tsc --noEmit`；`noUncheckedIndexedAccess: true`（数组下标要守卫）。

**既知环境性失败（勿当回归）**：`packages/server` 的 `wsServer.test.ts` / `SessionService.test.ts` 在本机高 node 进程负载下会超时（已在 master 上同条件复现）；隔离重跑取证即可。

---

## Task 1：`isSecureRequest` —— 判定客户端侧是否 https

**Files:**
- Create: `packages/server/src/http/requestSecurity.ts`
- Test: `packages/server/src/http/requestSecurity.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { isSecureRequest } from './requestSecurity.js'

/** 造一个最小 req：encrypted 决定直连 TLS，headers 提供转发头。 */
const req = (opts: { encrypted?: boolean; xfp?: string | string[] } = {}): IncomingMessage =>
  ({
    socket: { encrypted: opts.encrypted } as never,
    headers: opts.xfp === undefined ? {} : { 'x-forwarded-proto': opts.xfp },
  }) as IncomingMessage

describe('isSecureRequest', () => {
  it('直连 TLS（socket.encrypted）→ true，与 trustProxy 无关', () => {
    expect(isSecureRequest(req({ encrypted: true }), false)).toBe(true)
    expect(isSecureRequest(req({ encrypted: true }), true)).toBe(true)
  })

  it('明文且不信任代理 → false（X-Forwarded-Proto 不可伪造成加密）', () => {
    expect(isSecureRequest(req({ xfp: 'https' }), false)).toBe(false)
  })

  it('信任代理时按 X-Forwarded-Proto 判定', () => {
    expect(isSecureRequest(req({ xfp: 'https' }), true)).toBe(true)
    expect(isSecureRequest(req({ xfp: 'http' }), true)).toBe(false)
  })

  it('逗号链取第一段（最靠近客户端的一跳）', () => {
    expect(isSecureRequest(req({ xfp: 'https, http' }), true)).toBe(true)
    expect(isSecureRequest(req({ xfp: 'http, https' }), true)).toBe(false)
  })

  it('大小写与空白不敏感；数组头取第一个；头缺失 → false', () => {
    expect(isSecureRequest(req({ xfp: '  HTTPS ' }), true)).toBe(true)
    expect(isSecureRequest(req({ xfp: ['https', 'http'] }), true)).toBe(true)
    expect(isSecureRequest(req(), true)).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/server/src/http/requestSecurity.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
import type { IncomingMessage } from 'node:http'
import type { TLSSocket } from 'node:tls'

/**
 * 这次请求在**客户端那一侧**是不是走的 HTTPS —— 用来决定会话 cookie 要不要打 Secure。
 *
 * - 直连 TLS：socket 是 TLSSocket，带 encrypted 标记。
 * - 隧道 / 反向代理（tailscale serve、cloudflared）：外层已终止 TLS，daemon 收到的是回环明文，
 *   只能靠 X-Forwarded-Proto 得知。该头**任何客户端都能伪造**，所以仅在运维显式声明
 *   「我确实跑在可信前置之后」（--trust-proxy）时才采信。
 *   头可能是逗号分隔的链（`https, http`），取第一段 = 最靠近客户端的那一跳。
 */
export function isSecureRequest(req: IncomingMessage, trustProxy: boolean): boolean {
  if ((req.socket as TLSSocket).encrypted) return true
  if (!trustProxy) return false
  const raw = req.headers['x-forwarded-proto']
  const value = Array.isArray(raw) ? raw[0] : raw
  return value?.split(',')[0]?.trim().toLowerCase() === 'https'
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run packages/server/src/http/requestSecurity.test.ts`
Expected: PASS（5 用例）

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/http/requestSecurity.ts packages/server/src/http/requestSecurity.test.ts
git commit -m "feat(server): isSecureRequest — detect client-side https (direct TLS or trusted X-Forwarded-Proto)"
```

---

## Task 2：cookie `Secure` 自适应

**Files:**
- Modify: `packages/server/src/http/server.ts`（`RequestHandlerDeps` 加 `trustProxy`；登录分支 ~line 215 的 `secure: false`；登出分支 ~line 234 的清除 cookie）
- Test: `packages/server/src/http/server.test.ts`（追加用例）

- [ ] **Step 1: 写失败测试**（沿用该文件既有的 handler 构造 helper；若 helper 不传 `trustProxy`，给它加可选参数并默认 false）

```ts
describe('会话 cookie 的 Secure 属性随传输自适应', () => {
  it('明文 http 登录 → 不带 Secure（否则本地开发会被浏览器丢弃）', async () => {
    const res = await login({ trustProxy: false })          // 按本文件既有的登录调用方式
    expect(res.headers.get('set-cookie')).not.toMatch(/Secure/i)
  })

  it('trustProxy + X-Forwarded-Proto: https → 带 Secure', async () => {
    const res = await login({ trustProxy: true, headers: { 'x-forwarded-proto': 'https' } })
    expect(res.headers.get('set-cookie')).toMatch(/Secure/i)
  })

  it('不信任代理时，伪造 X-Forwarded-Proto 不会让 cookie 变 Secure', async () => {
    const res = await login({ trustProxy: false, headers: { 'x-forwarded-proto': 'https' } })
    expect(res.headers.get('set-cookie')).not.toMatch(/Secure/i)
  })
})
```

> 实现者：先读 `server.test.ts` 现有的登录用例，复用它的 fixture/请求方式；上面的 `login(...)` 是示意，落地时改成该文件真实的调用形态。

- [ ] **Step 2: 跑确认失败**

Run: `pnpm exec vitest run packages/server/src/http/server.test.ts`
Expected: FAIL（当前恒不带 Secure）

- [ ] **Step 3: deps 加字段**（`RequestHandlerDeps`，`tokenTtlSec` 附近）

```ts
  /** 信任前置代理/隧道的 X-Forwarded-Proto（--trust-proxy）。默认 false。 */
  trustProxy?: boolean
```

- [ ] **Step 4: 登录分支用动态 secure**（替换 `secure: false,` 那一行）

```ts
            // 直连 TLS 或（显式信任的）隧道 → 打 Secure；本地明文 http 必须不打，
            // 否则浏览器直接丢弃这枚 cookie，本地开发登不进去。
            secure: isSecureRequest(req, deps.trustProxy ?? false),
```
并在文件顶部 `import { isSecureRequest } from './requestSecurity.js'`。

- [ ] **Step 5: 登出清除 cookie 属性对齐**（替换 logout 的 `serializeCookie(...)` 调用）

```ts
      // 清除用的属性要与下发时一致（尤其 Secure/Path），否则部分浏览器不认这次清除。
      res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', {
        maxAgeSec: 0, path: '/', httpOnly: true, sameSite: 'Lax',
        secure: isSecureRequest(req, deps.trustProxy ?? false),
      }))
```

- [ ] **Step 6: 跑确认通过**

Run: `pnpm exec vitest run packages/server/src/http/server.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/http/server.ts packages/server/src/http/server.test.ts
git commit -m "fix(server): session cookie Secure now follows the actual transport (was hardcoded false)"
```

---

## Task 3：config + CLI（`--tls-cert` / `--tls-key` / `--trust-proxy`）

**Files:**
- Modify: `packages/server/src/config.ts`（`ServerConfig` 三个可选字段）
- Modify: `packages/server/src/cliArgs.ts`（解析三个新参数）
- Test: `packages/server/src/cliArgs.test.ts`（若不存在则新建）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { parseArgs } from './cliArgs.js'

describe('parseArgs — TLS / 代理相关参数', () => {
  it('解析 --tls-cert / --tls-key / --trust-proxy', () => {
    const a = parseArgs(['--tls-cert', 'c.pem', '--tls-key', 'k.pem', '--trust-proxy'])
    expect(a.tlsCert).toBe('c.pem')
    expect(a.tlsKey).toBe('k.pem')
    expect(a.trustProxy).toBe(true)
  })

  it('缺省时三者均为 undefined / false', () => {
    const a = parseArgs([])
    expect(a.tlsCert).toBeUndefined()
    expect(a.tlsKey).toBeUndefined()
    expect(a.trustProxy).toBe(false)
  })

  it('不回归既有参数', () => {
    const a = parseArgs(['--port', '5000', '--host', '0.0.0.0', '--set-password'])
    expect(a.port).toBe(5000)
    expect(a.host).toBe('0.0.0.0')
    expect(a.setPassword).toBe(true)
  })
})
```

- [ ] **Step 2: 跑确认失败**

Run: `pnpm exec vitest run packages/server/src/cliArgs.test.ts`
Expected: FAIL

- [ ] **Step 3: `ParsedArgs` + 解析分支**（`cliArgs.ts`）

```ts
export interface ParsedArgs {
  port?: number
  host?: string
  setPassword: boolean
  /** TLS 证书 / 私钥路径（两者都给才启用 https）。 */
  tlsCert?: string
  tlsKey?: string
  /** 信任前置代理的 X-Forwarded-Proto。 */
  trustProxy: boolean
}
```
初始值 `{ setPassword: false, trustProxy: false }`；循环里加三个分支（`--tls-cert` / `--tls-key` 取下一个 argv 值，`--trust-proxy` 置 true）。并更新函数上方注释里的「Recognizes:」清单。

- [ ] **Step 4: `ServerConfig` 加字段**（`config.ts`，`webDir` 之后）

```ts
  /** TLS 证书 / 私钥文件路径。两者都给才启用 https（缺一由 bin 报错退出）。 */
  tlsCert?: string
  tlsKey?: string
  /** 信任前置代理/隧道的 X-Forwarded-Proto。默认 false。 */
  trustProxy?: boolean
```
（`defaultConfig()` 不需要给默认值——`undefined`/falsy 即默认关闭。）

- [ ] **Step 5: 跑确认通过 + typecheck**

Run: `pnpm exec vitest run packages/server/src/cliArgs.test.ts`
Expected: PASS
Run: `pnpm --filter @zouyj/zuse-server exec tsc --noEmit`
Expected: EXIT 0

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/cliArgs.ts packages/server/src/cliArgs.test.ts packages/server/src/config.ts
git commit -m "feat(server): --tls-cert / --tls-key / --trust-proxy CLI + config fields"
```

---

## Task 4：startServer 走 https + WS 类型放宽 + 启动横幅

**Files:**
- Modify: `packages/server/src/startServer.ts`（import、createServer 分支 ~line 200、横幅 ~line 205、返回 url）
- Modify: `packages/server/src/ws/wsServer.ts`（`attachWsServer` 参数类型放宽）
- Modify: `packages/server/src/bin.ts`（把新参数塞进 config + fail-fast 校验）
- Test: `packages/server/src/startServer.tls.test.ts`（新建）

- [ ] **Step 1: 写失败测试**（用测试内生成的自签证书起真 https；`rejectUnauthorized:false` 取 `/healthz`）

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { request as httpsRequest } from 'node:https'
import { startServer } from './startServer.js'
// 测试夹具：内联一对自签 PEM（仅供测试；实现者可用 `openssl req -x509 -newkey rsa:2048
// -keyout key.pem -out cert.pem -days 3650 -nodes -subj "/CN=localhost"` 生成后内联，
// 或用 node:crypto 的 generateKeyPairSync + 一个最小 X.509 组装工具）。
import { TEST_CERT_PEM, TEST_KEY_PEM } from './testCerts.js'

let stop: (() => Promise<void>) | undefined
afterEach(async () => { await stop?.(); stop = undefined })

it('给了证书就起 https，/healthz 可经 TLS 取到', async () => {
  const { url, close } = await startServer({ /* 复用本仓既有 startServer 测试的最小 deps/cfg */
    host: '127.0.0.1', port: 0, tlsCert: writePem(TEST_CERT_PEM), tlsKey: writePem(TEST_KEY_PEM),
  } as never, {} as never)
  stop = close
  expect(url.startsWith('https://')).toBe(true)
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpsRequest(`${url}/healthz`, { rejectUnauthorized: false }, (res) => resolve(res.statusCode ?? 0))
    req.on('error', reject); req.end()
  })
  expect(status).toBe(200)
})
```

> 实现者：先读现有 `startServer` 的测试（`packages/server/src/**/*.test.ts` 里已有起服务器的用例），**复用它的 cfg/deps 构造方式**，上面的调用是示意。证书夹具优先用 openssl 生成后内联为常量（无新依赖）；若环境无 openssl，用 `node:crypto.generateKeyPairSync` + 手写最小自签 X.509 亦可，但**不要为此引入新依赖**。

- [ ] **Step 2: 跑确认失败**

Run: `pnpm exec vitest run packages/server/src/startServer.tls.test.ts`
Expected: FAIL（当前恒 http）

- [ ] **Step 3: WS 类型放宽**（`wsServer.ts`）

```ts
import type * as https from 'node:https'
// …
export function attachWsServer(httpServer: http.Server | https.Server, deps: WsServerDeps): { closeAll(): void } {
```
（实现不变：两种 server 都发 `upgrade` 事件。）

- [ ] **Step 4: startServer 分支建服务器**（替换 `const httpServer = createServer(...)`）

```ts
  const handler = makeRequestHandler({ /* …现有全部字段原样… */, trustProxy: cfg.trustProxy ?? false })
  // 两者都给才走 TLS；只给一半在 bin 里已 fail fast，这里按「有就用」处理。
  const useTls = !!(cfg.tlsCert && cfg.tlsKey)
  const httpServer = useTls
    ? createHttpsServer({ cert: readFileSync(cfg.tlsCert!), key: readFileSync(cfg.tlsKey!) }, handler)
    : createServer(handler)
```
顶部加 `import { createServer as createHttpsServer } from 'node:https'` 与 `import { readFileSync } from 'node:fs'`（若未导入）。

- [ ] **Step 5: url 与横幅三分支**

```ts
  const scheme = useTls ? 'https' : 'http'
  // …
  if (useTls) {
    console.log(`[zuse-server] TLS 已启用 — ${scheme}://${cfg.host}:${port}`)
  } else if (cfg.trustProxy) {
    console.log(`[zuse-server] 明文监听，信任前置代理的 X-Forwarded-Proto — 请确保只有隧道能连到这个端口`)
  } else if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost') {
    console.warn(`[zuse-server] bound to ${cfg.host}:${port} — plaintext HTTP on a network interface. ` +
      `Use TLS (--tls-cert/--tls-key) or a tunnel (+ --trust-proxy); see docs/remote-access.md`)
  }
  return { url: `${scheme}://${cfg.host}:${port}`, close: /* 不变 */ }
```

- [ ] **Step 6: bin.ts 透传 + fail fast**（在 `defaultConfig()` 展开处附近）

```ts
    ...(args.tlsCert !== undefined ? { tlsCert: args.tlsCert } : {}),
    ...(args.tlsKey !== undefined ? { tlsKey: args.tlsKey } : {}),
    ...(args.trustProxy ? { trustProxy: true } : {}),
```
并在起服务器之前校验（**静默降级成明文比崩溃危险，所以这里直接退出**）：

```ts
  if (!!cfg.tlsCert !== !!cfg.tlsKey) {
    console.error('[zuse-server] --tls-cert 与 --tls-key 必须同时提供')
    process.exit(1)
  }
  for (const p of [cfg.tlsCert, cfg.tlsKey]) {
    if (p && !existsSync(p)) { console.error(`[zuse-server] TLS 文件不存在:${p}`); process.exit(1) }
  }
```

- [ ] **Step 7: 跑确认通过 + 全量 server + typecheck**

Run: `pnpm exec vitest run packages/server/src/startServer.tls.test.ts`
Expected: PASS
Run: `pnpm exec vitest run packages/server`
Expected: PASS（wsServer/SessionService 若在负载下超时 → 隔离重跑取证）
Run: `pnpm --filter @zouyj/zuse-server exec tsc --noEmit`
Expected: EXIT 0

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/startServer.ts packages/server/src/ws/wsServer.ts packages/server/src/bin.ts packages/server/src/startServer.tls.test.ts
git commit -m "feat(server): serve https when a cert/key pair is given; mode-aware startup banner"
```

---

## Task 5：用户文档

**Files:**
- Create: `docs/remote-access.md`

- [ ] **Step 1: 写文档**（面向用户，中文，每条路径给可照抄命令）

必须覆盖（spec §4.6）：
- **tailscale（推荐）**：`tailscale serve --bg 4180`；daemon 保持 `127.0.0.1` 绑定 + `--trust-proxy`；说明真证书、无警告、设备级鉴权与 zuse 密码是叠加关系。
- **Cloudflare Tunnel**：`cloudflared tunnel --url http://127.0.0.1:4180` + `--trust-proxy`。
- **直连 TLS**：`mkcert <主机名或局域网 IP>` 或 `tailscale cert <host>.<tailnet>.ts.net` → `zuse-server --host 0.0.0.0 --tls-cert cert.pem --tls-key key.pem`。
- **为什么不提供自签证书生成**（spec §2 的三条理由，尤其 WSS 对未受信证书直接握手失败）。
- 安全提醒：绑 `0.0.0.0` 前确认防火墙；`--trust-proxy` 只在真有前置时开（否则等于让客户端自称 https）。
- 顺带好处：走上 https 后浏览器视为 secure context，`crypto.randomUUID` 恢复可用（web 侧的非 secure context 兜底不再触发，但保留）。

- [ ] **Step 2: Commit**

```bash
git add docs/remote-access.md
git commit -m "docs: remote access guide (tailscale / cloudflared / direct TLS)"
```

---

## Task 6：/ship

- [ ] **Step 1: 调用 ship 技能**，参数：

`分支 a2-remote-access → 本地 master。A2 远程访问（TLS / 隧道），只改 packages/server + 新增 docs/remote-access.md，**不改 packages/web → Playwright N/A**。重点核对:①isSecureRequest 不信任未授权的 X-Forwarded-Proto、逗号链取第一段 ②cookie Secure 自适应且本地明文 http 登录仍能拿到 cookie（写死 true 会让本地开发登不进去）、logout 清除属性与下发一致 ③--tls-cert/--tls-key 只给一半时 fail fast 退出而非静默降级成明文 ④https 下 WS 能经 wss 升级（attachWsServer 类型放宽后实现未变）⑤启动横幅三分支不再对已加密部署误报明文。已知环境性失败：wsServer.test / SessionService.test 在本机高负载下超时，已在 master 同条件复现，隔离重跑取证即可。`

---

## Self-Review

**1. Spec 覆盖**：§4.1 config+CLI→T3；§4.2 https+WS→T4；§4.3 isSecureRequest→T1；§4.4 cookie→T2；§4.5 横幅→T4；§4.6 文档→T5；§5 分期→T1-T5 一一对应；§6 测试→各 Task 的 TDD。✓

**2. 占位符扫描**：无 TBD。两处标注「示意、需按现有测试的构造方式落地」（server.test.ts 的登录 helper、startServer 测试的 cfg/deps）——这是刻意的：这些 fixture 已存在于仓库，硬编一份猜测的调用形态反而会误导实现者去造重复夹具。测试**断言内容**是明确的。

**3. 类型一致性**：`ParsedArgs.trustProxy: boolean`（T3，非可选，默认 false）与 `ServerConfig.trustProxy?: boolean`（T3，可选）与 `RequestHandlerDeps.trustProxy?: boolean`（T2）三处语义一致（缺省即 false）；`isSecureRequest(req, trustProxy: boolean)`（T1）的调用点在 T2 统一用 `deps.trustProxy ?? false`。
