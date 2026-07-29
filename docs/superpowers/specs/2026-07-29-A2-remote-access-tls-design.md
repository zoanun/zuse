# A2 远程访问（TLS / 隧道）设计

> **日期**: 2026-07-29
> **性质**: 单个功能 spec（Web UI 路线图 §4.1 的 A2）
> **依赖**: F1（server 骨架 + 本地密码鉴权）✓
> **一句话**: 让「从手机/平板/外网访问 zuse」在加密信道上可用，并修掉当前会话 cookie 缺 `Secure` 的真隐患。

---

## 1. 现状（已核实）

| 事实 | 位置 |
|---|---|
| 默认绑 `127.0.0.1:4180` | `packages/server/src/config.ts:21` |
| `--host` / `--port` CLI 已支持（**已经可以绑 0.0.0.0**） | `packages/server/src/cliArgs.ts` |
| 绑非 localhost 时已警告「明文 HTTP，请用 TLS 隧道(A2)」 | `packages/server/src/startServer.ts:205` |
| 会话 cookie：`httpOnly` ✓、`SameSite=Lax` ✓、**`secure: false` 硬编码** | `packages/server/src/http/server.ts:215-221` |
| **完全没有** `X-Forwarded-Proto` 处理 | 全仓 grep 无命中 |
| 只用 `node:http`，无 TLS 路径 | `startServer.ts:1,200` |
| WS 挂在 `httpServer` 的 `upgrade` 事件上 | `packages/server/src/ws/wsServer.ts:29,32` |

**结论**：远程访问今天在"能连上"层面已经可行（`--host 0.0.0.0`），但**传输是明文**，且**即使放到 TLS 隧道后面，cookie 也不会被标记 `Secure`** —— 这是本 spec 要修的核心。

## 2. 目标与非目标

**目标**
1. 支持**直连 TLS**：自带证书 → `https` + `wss`。
2. 支持**隧道**（tailscale / Cloudflare Tunnel 在前面终止 TLS）：正确识别外层是 https。
3. 会话 cookie 的 `Secure` 属性**随实际传输自适应**，且本地 http 开发不被破坏。
4. 启动横幅按模式给出**正确**的安全提示（不再对已加密的部署误报"明文"）。
5. 文档：两条路径各给一条能直接照抄的命令。

**非目标（明确不做，附理由）**
- **不自动生成自签证书。** ①移动端要手动安装/信任证书，iOS 尤其麻烦；②**WSS 对未受信证书会直接握手失败**——页面还能点"继续前往"，WebSocket 不能，结果是"页面打开了但聊天连不上"的糟糕半死状态；③`mkcert`（本地 CA、系统受信）与 `tailscale cert`（真 Let's Encrypt 证书）给出的都是受信证书，体验碾压自签。把证书获取交给这两个成熟工具，我们只负责加载。
- 不做 HTTP→HTTPS 自动跳转（单端口、单用户，加一个跳转端口是净复杂度）。
- 不做 mTLS / 客户端证书（超出单用户场景）。
- 不做内置 ACME/Let's Encrypt 申请（需要公网 80/DNS 挑战，隧道方案已顺带解决）。
- 不改鉴权模型（仍是 F1 的本地密码 + 签名 cookie）。

## 3. 两条支持路径

### 3.1 隧道（推荐路径）

外层（tailscale serve / cloudflared）终止 TLS，daemon 仍然只听 `127.0.0.1:4180` 明文——**本机回环上的明文不构成暴露面**。

需要的代码支持只有一件事：daemon 得知道"客户端那一侧其实是 https"，才能把 cookie 标成 `Secure`。走标准的 `X-Forwarded-Proto`。

**为什么推荐**：真证书、无浏览器警告、无需端口转发、tailscale 还自带设备级鉴权（等于在 zuse 密码之外多一道），从任何网络可达。

### 3.2 直连 TLS（自带证书）

`--tls-cert <path> --tls-key <path>` → 用 `node:https` 建服务器，WS 自动变成 `wss`（同一个 server 的 upgrade 事件）。

**证书从哪来**（文档给命令，代码不管）：
- LAN 场景：`mkcert`（装一次本地 CA，签的证书系统受信）
- 有 tailscale：`tailscale cert <host>.<tailnet>.ts.net`（真证书）

**为什么保留这条**：不依赖外部服务、纯内网/离线可用；也是给"我已经有证书"的用户的直通车。

## 4. 设计

### 4.1 配置面（`ServerConfig` + CLI）

```ts
export interface ServerConfig {
  // …现有字段…
  /** TLS 证书 / 私钥文件路径。两者都给才启用 https（缺一即报错退出，避免"以为加密了其实没有"）。 */
  tlsCert?: string
  tlsKey?: string
  /**
   * 信任反向代理/隧道的 X-Forwarded-Proto。默认 false —— 不能无条件信任请求头。
   * 仅在 daemon 确实跑在 tailscale serve / cloudflared 之类的前置之后时开启。
   */
  trustProxy?: boolean
}
```

CLI 新增：`--tls-cert <path>`、`--tls-key <path>`、`--trust-proxy`。

**校验（fail fast，不静默降级）**：只给了 cert 或只给了 key → 打印错误并**退出**；文件读不到 → 打印错误并**退出**。理由：安全配置的静默降级（"以为在跑 https，其实明文"）比崩溃危险得多。

### 4.2 服务器构造（`startServer`）

```
tlsCert && tlsKey  →  https.createServer({ cert, key }, handler)
否则                →  http.createServer(handler)
```

`attachWsServer` 的参数类型从 `http.Server` 放宽到 `http.Server | https.Server`（两者都发 `upgrade` 事件；实现无需改动）。

返回的 `url` 相应变成 `https://…`。

### 4.3 「这次请求是不是加密的」判定（新增小模块）

新建 `packages/server/src/http/requestSecurity.ts`：

```ts
/**
 * 这次请求在客户端那一侧是不是走的 HTTPS。
 * - 直连 TLS：socket 上有 encrypted 标记
 * - 隧道/反代：仅当显式 trustProxy 时才认 X-Forwarded-Proto（否则任何客户端都能自称 https）
 */
export function isSecureRequest(req: IncomingMessage, trustProxy: boolean): boolean {
  if ((req.socket as TLSSocket).encrypted) return true
  if (!trustProxy) return false
  const proto = req.headers['x-forwarded-proto']
  const first = (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0]?.trim().toLowerCase()
  return first === 'https'
}
```

要点：`X-Forwarded-Proto` 可能是逗号分隔的链（`https, http`），取**第一段**（最靠近客户端的那一跳）。

### 4.4 cookie `Secure` 自适应

`makeRequestHandler` 的登录分支把硬编码的 `secure: false` 换成 `secure: isSecureRequest(req, deps.trustProxy ?? false)`；logout 清 cookie 同样带上（属性不匹配的清除在部分浏览器会失效）。

**为什么必须是动态的**：写死 `true` 会让本地 `http://127.0.0.1:4180` 的登录直接失效（浏览器丢弃 Secure cookie）；写死 `false` 就是今天的隐患。

`RequestHandlerDeps` 加 `trustProxy: boolean`。

### 4.5 启动横幅（按模式给对提示）

现状：只要 host 不是 localhost 就喊"明文 HTTP"。改成三分支：

| 模式 | 提示 |
|---|---|
| 直连 TLS（有证书） | `TLS 已启用 — https://<host>:<port>` |
| 明文但 `--trust-proxy`（隧道在前） | `明文监听，信任前置代理的 X-Forwarded-Proto — 确保只有隧道能连到这个端口` |
| 明文 + 绑非 localhost + 无 trust-proxy | 保留现有告警，并补一句指向文档的两条路径 |
| 明文 + 只绑 localhost | 不提示（本机开发的正常情形） |

### 4.6 文档

`docs/remote-access.md`（新建，面向用户）：两条路径各一段可照抄的命令 + 各自的取舍；并说明 zuse 的密码鉴权与隧道鉴权是**叠加**关系。

内容要点：
- **tailscale（推荐）**：`tailscale serve --bg 4180` → `https://<机器名>.<tailnet>.ts.net`；daemon 保持默认 `127.0.0.1` 绑定 + 加 `--trust-proxy`。
- **Cloudflare Tunnel**：`cloudflared tunnel --url http://127.0.0.1:4180`；同样加 `--trust-proxy`。
- **直连 TLS**：`mkcert <你的局域网 IP 或主机名>` → `zuse-server --host 0.0.0.0 --tls-cert cert.pem --tls-key key.pem`。
- 安全提醒：绑 `0.0.0.0` 前先确认防火墙；`--trust-proxy` 只在真有前置时开。

> 顺带的好处（写进文档）：一旦走上 https，浏览器把页面视为 **secure context**，`crypto.randomUUID` 等 API 恢复可用 —— web 侧当初为非 secure context 加的 `newMessageId` 兜底（`packages/web/src/state/store.tsx`）不再被触发（兜底保留，不删）。

## 5. 分期

1. **`isSecureRequest` + cookie 自适应**（含 `RequestHandlerDeps.trustProxy`）—— 纯逻辑，单测好写，独立有价值（修掉今天的隐患）。
2. **config + CLI**（`--tls-cert` / `--tls-key` / `--trust-proxy` + fail-fast 校验）。
3. **startServer 走 https + WS 类型放宽 + 启动横幅三分支**。
4. **文档 `docs/remote-access.md`**。
5. **/ship**（typecheck + 单测；**Playwright N/A —— 本特性不改 `packages/web`**）。

## 6. 测试策略

- `isSecureRequest`：直连 TLS(socket.encrypted) → true；无 trustProxy 时 `X-Forwarded-Proto: https` → **false**（不可伪造）；有 trustProxy 时 → true；逗号链取第一段；大小写不敏感；头缺失 → false。
- cookie：明文 http 登录 → `Set-Cookie` **不含** `Secure`（本地开发不被破坏）；trustProxy + `X-Forwarded-Proto: https` 登录 → **含** `Secure`；logout 的清除 cookie 属性与之匹配。
- CLI：`--tls-cert` 只给一半 → 解析出错误状态；`--trust-proxy` 解析为 true；已有参数不回归。
- startServer：给一对**测试用自签证书**（测试夹具内生成或内联 PEM）能起 https 并被 `https.get`（`rejectUnauthorized:false`）取到 `/healthz`；WS 能经 `wss://` 连上。
- 明确不测：真实 tailscale/cloudflared（外部服务）。

## 7. 已知取舍

- **不生成自签证书** → 用户必须装 `mkcert` 或有 tailscale 才能走直连 TLS。这是有意的（见 §2 非目标）。
- `--trust-proxy` 是全局开关，不做「只信任某些来源 IP」的细粒度。单用户 + 隧道场景下，端口本就该只对隧道开放；细粒度是过度设计。
- 不改默认绑定（仍 `127.0.0.1`）：默认安全，远程访问是用户显式开启的动作。
