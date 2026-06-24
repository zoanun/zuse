# F1 — Server 骨架 + 传输 + 鉴权 设计

> **日期**: 2026-06-24
> **所属**: [Web UI 路线图总纲](./2026-06-22-web-ui-roadmap.md) 地基 spec F1
> **前置**: F2 已完成（`@zuse/server` 包 + `SessionManager`/`SessionRegistry` 已在 master）
> **下游**: F3（WS 协议 + 把 SessionManager 接进 WS 端点）消费本层

---

## 1. 目标与边界

把 `@zuse/server` 从"只有 headless 大脑"升级成一个**可运行的常驻 HTTP/WS 服务器**：本地密码门禁 + 鉴权后的 WS 通道 + 健康检查 + 网络绑定。

**本 spec 不接 agent**：WS 端点先做到"鉴权通过后能 echo"级别；把 `SessionManager` 接进来是 **F3**。这样 F1 能独立验证"浏览器/客户端 ↔ 鉴权 ↔ WS 管道"整条链路。

**沿用已定决策**：
- 技术栈 **`node:http` + `ws`**（依赖最省，贴合项目极简风格；新增唯一运行时依赖 `ws`）。
- 鉴权 **本地密码门禁**：scrypt 密码哈希存家目录、HMAC 签名会话 token、httpOnly cookie、重启不掉线（详见 §5）。
- 鉴权做成**可插拔接口**（总纲扩展点 §5.1 的前身）：F1 只实现"本地密码"provider，将来 OAuth 等按 provider 插入。

**解耦约束（不可破）**：`@zuse/server` 只依赖 `@zuse/core`/`@zuse/tools`，**绝不依赖 `@zuse/tui`**；反之亦然。启动入口见 §7（独立 bin，不走 tui）。

## 2. 包内结构（在现有 `packages/server` 内新增）

```
packages/server/src/
  session/            (F2 已有：SessionManager / SessionRegistry / events)
  auth/
    passwordStore.ts  读写 ~/.zuse/web-auth.json（密码哈希 + token 签名密钥）
    hash.ts           scrypt 派生 + 定时安全比较（node:crypto）
    token.ts          HMAC 签名/校验会话 token（node:crypto）
    authProvider.ts   AuthProvider 接口 + LocalPasswordAuth 实现
  http/
    server.ts         createHttpServer(deps): node:http.Server；路由分发 + WS upgrade
    routes.ts         路由表：健康、登录、设密码、(静态留 F4)
    middleware.ts     鉴权中间件（校验 cookie 里的 token）
    cookies.ts        httpOnly cookie 读写小工具
  ws/
    wsServer.ts       基于 ws 的 WebSocketServer；连接鉴权 + echo stub（F3 替换为 SessionManager 接线）
  config.ts           ServerConfig（port/host/paths）+ 默认值
  startServer.ts      组装：HTTP server + WS server + auth，listen，返回 { close() }
  bin.ts              CLI 入口（见 §7）
```

- 测试：每个纯模块（hash/token/passwordStore/middleware/cookies）单测；server 启动用临时端口做集成测试（启动→请求→断言→close）。

## 3. 运行形态与配置

`ServerConfig`：
| 字段 | 默认 | 说明 |
|------|------|------|
| `host` | `127.0.0.1` | 默认仅本机。远程访问需显式设 `0.0.0.0`（配合 A2 的 TLS/隧道）。 |
| `port` | `4180` | 可 CLI/env 覆盖。 |
| `authDir` | `~/.zuse` | 密码哈希 + 签名密钥所在目录。 |
| `tokenTtlSec` | `30 天` | 会话 token 有效期。 |

- 启动绑定 `host:port`；`host` 非回环时 **打印安全警告**（明文 HTTP 暴露到网络需 A2 的 TLS/隧道）。

## 4. HTTP 层

`node:http` 单 server，按 `req.method + url.pathname` 手写分发（无框架）：

| 路由 | 方法 | 鉴权 | 行为 |
|------|------|:----:|------|
| `/healthz` | GET | 否 | `200 {status:'ok', version}`。存活探针。 |
| `/api/auth/status` | GET | 否 | 是否已设密码 / 当前请求是否已登录（供前端决定显示登录页还是设密码页）。 |
| `/api/auth/setup` | POST | 否（仅当未设密码时）| 首次设密码：无哈希时接受 `{password}`，写哈希；已存在则 409。 |
| `/api/auth/login` | POST | 否 | `{password}` 校验通过 → set-cookie 签名 token，返回 200；失败 401（带退避，防爆破，见 §6）。 |
| `/api/auth/logout` | POST | 是 | 清 cookie。（token 无状态，仅靠 cookie 失效即可。）|
| `/ws` | GET(Upgrade) | 是 | WebSocket 升级；鉴权见 §5.3。F1 阶段：echo。 |
| `/` | GET | 否(页面自身) | **F1 极简 dev 测试页**（内联 HTML，见 §4.1）。F4 会用真前端替换此路由。 |
| `/*` | GET | 是 | F4 的前端静态资源挂载点（F1 留桩：404 或占位）。 |

### 4.1 极简 dev 测试页（F1 自带，throwaway）
为让 F1 完成即可在浏览器实测整条管道，`/` 返回一个**单文件内联 HTML**（无构建、无外部依赖、无框架）：
- 一个**设密码/登录**表单：调 `/api/auth/status` 决定显示"设密码"还是"登录"；提交打 `/api/auth/setup` 或 `/api/auth/login`（cookie 自动种下）。
- 一个 **WS echo 控制台**：登录后连 `/ws`，一个输入框 + 发送按钮 + 消息列表，显示服务端 echo 回来的内容。
- 顶部显示 `/healthz` 的版本/状态。
- 明确标注 `<!-- DEV TEST PAGE — replaced by the real SPA in F4 -->`，CSS/JS 全内联，仅用于人工验证 auth+WS 管道。
- 它本身不需要鉴权即可加载（页面内自行处理登录流程）；真正受保护的是 `/ws` 和 API。

- 鉴权中间件：受保护路由先校验 cookie token；失败 401。
- 统一 JSON 错误形状 `{error: {code, message}}`；CORS 默认同源（本地 SPA 同源，无需放开）。

## 5. 鉴权设计（本地密码门禁）

### 5.1 存储 `~/.zuse/web-auth.json`（家目录，全局跨项目，非仓库）
```jsonc
{
  "version": 1,
  "passwordHash": "scrypt$<N>$<salt-b64>$<hash-b64>",  // 无密码时该文件不存在或字段缺失
  "tokenSecret": "<base64 32B 随机>"                     // 首次启动生成并持久化；token 签名用
}
```
- 文件权限尽量收紧（chmod 0600，best-effort，Windows 上忽略）。
- `tokenSecret` 持久化 → 重启后旧 token 仍可验签 → **不掉线**。

### 5.2 密码哈希与校验（`hash.ts`，node:crypto）
- `scryptSync(password, salt, 64)`，随机 16B salt；序列化为 `scrypt$N$salt$hash`。
- 校验用 `timingSafeEqual` 防时序侧信道。
- （argon2 需原生依赖，违背极简；scrypt 是 node 内置且足够。）

### 5.3 会话 token（`token.ts`，HMAC）
- token = `base64url(payload).base64url(hmacSHA256(payload, tokenSecret))`，`payload = {iat, exp}`（单用户，无需 user id）。
- 校验：重算 HMAC `timingSafeEqual` + 检查 `exp` 未过期。
- 存 **httpOnly + SameSite=Lax** cookie（`Secure` 当走 TLS 时置上）。
- WS 升级鉴权：浏览器 `WebSocket` 不能自定义 header，但**会自动带 cookie** → 升级请求里读 cookie 校验 token；失败则在 upgrade 阶段拒绝（销毁 socket）。

### 5.4 可插拔接口
```ts
interface AuthProvider {
  isConfigured(): Promise<boolean>            // 是否已设密码
  setup(secret: string): Promise<void>        // 首次设密码
  verifyCredential(secret: string): Promise<boolean>
  issueToken(): string
  verifyToken(token: string): boolean
}
```
F1 实现 `LocalPasswordAuth`。将来 OAuth 实现同接口插入，HTTP 层不改。

## 6. 安全考量
- **登录退避**：连续失败计数 + 递增延时（内存级，单用户够），防本地/局域网密码爆破。
- **默认仅回环**：`127.0.0.1`，远程访问是显式选择且警告。
- **明文 HTTP 警告**：非回环绑定时强提示需 A2（TLS/隧道）——F1 不内置 TLS（A2 单独做）。
- **token 泄漏面**：httpOnly 防 XSS 读取；SameSite=Lax 防基本 CSRF；无状态签名 token 无法服务端单条吊销（单用户可接受；需要时改 tokenSecret 即全体失效）。
- 不记录密码/token 到日志。

## 7. 启动入口与 CLI（解耦关键）

- `startServer(config): Promise<{ url: string; close(): Promise<void> }>` —— 纯函数式启动，供测试与 bin 共用。
- **`@zuse/server` 自带 bin**（`package.json` `"bin": { "zuse-server": "./dist/bin.js" }`）：`zuse-server [--port N] [--host H] [--set-password]`。
- **不在 `packages/tui` 里加 `zuse --web`**：那会让 tui 依赖 server，破坏解耦。`zuse --web` 这种便捷 UX 作为**待定项**留到地基之后，若要做则用一个**独立顶层 launcher**（既不属 tui 也不属 server），而非让 tui import server。
- `--set-password`：交互式/或读 stdin 设置密码后退出（首次配置用）。CLI 不在 -NonInteractive 场景挂起：无 TTY 时从 env/stdin 读。

## 8. 测试策略
- **纯单测**：`hash`（派生+校验+错误密码拒绝）、`token`（签发→验签→过期→篡改拒绝）、`passwordStore`（读写、缺文件、secret 生成幂等）、`cookies`、`middleware`（有效/无效/缺失 token）。
- **集成测**：`startServer` 绑临时端口（port 0）→ 真发 HTTP：`/healthz` 200；未设密码时 `/api/auth/status` 反映；`setup` 后 `login` 拿到 set-cookie；带 cookie 访问受保护路由 200、无 cookie 401；WS 升级带有效 cookie 成功 echo、无 cookie 被拒。`close()` 干净关闭。
- 不打真实网络；不依赖固定端口（用 0 让 OS 分配）。

## 9. 非目标 / 留给下游
- **接 SessionManager / 真实 agent 回合** → F3（F1 的 `/ws` 只 echo）。
- **WS 业务协议**（send/interrupt/steer/事件下行）→ F3。
- **前端静态资源** → F4（F1 只留挂载点）。
- **TLS / 隧道** → A2。
- **OAuth** → 未来（接口已留）。
- **多用户** → 永不（单用户）。
- **`zuse --web` 便捷入口** → 待定（独立 launcher，避免 tui→server 耦合）。

## 10. F1 完成判据
- curl 级：`/healthz` 200；首次 `setup` 设密码；`login` 拿 cookie；带 cookie 连 `/ws` 收到 echo；无/错 cookie 被 401/拒绝；`zuse-server` bin 能起停。
- **浏览器级（dev 测试页）**：`zuse-server` 起服务后，浏览器打开 `http://127.0.0.1:4180/` → 看到 dev 页 → 首次设密码/登录 → 在 echo 控制台发消息、看到服务端 echo 回显。**这就是你最早能"打开页面测试"的点。**
- 全程零 `@zuse/tui` 依赖。
