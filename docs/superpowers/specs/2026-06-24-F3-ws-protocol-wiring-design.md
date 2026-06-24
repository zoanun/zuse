# F3：WS 协议 + 接线（含会话工厂）— 设计文档

> **日期**: 2026-06-24
> **所属程序**: Web UI 路线图（`docs/superpowers/specs/2026-06-22-web-ui-roadmap.md`），地基 spec F3
> **依赖**: F1（server 骨架 + 传输 + 鉴权，已合并）、F2（headless SessionManager，已合并）
> **产出**: `packages/protocol`（线缆契约）+ 会话工厂 + 把 SessionManager 焊进 F1 的 `/ws`，替换 echo；单会话、内存态、可真聊

---

## 1. 背景与目标

F1 起好了 `packages/server` daemon：`node:http` + `ws`、本地密码鉴权、鉴权后的 `/ws`（当前是 **echo 桩**）。F2 在同包内实现了**传输无关**的 `SessionManager`（回合循环 / 中断 / steer / 权限 / 自动压缩 / failover / 检查点 / 记忆巩固 / switchModel），发射 JSON 安全的 `SessionEvent`，但**至今没有任何代码构造一个真实的 SessionManager**——F2 只用 `testFakes.ts` 单测过。

F3 把两者焊起来，让浏览器能**端到端真聊**：

1. 定义 **WS 消息协议**（上行命令 + 下行事件/快照），放进一个**纯 type-only 的 `packages/protocol`** 作为 web↔server 的唯一线缆契约。
2. 写一个**会话工厂**，把 `@zuse/core` / `@zuse/tools` 的真件接成一个可工作的 `SessionManager`（真模型客户端、真工具集、真系统提示词、真检查点存储）。
3. 把工厂产出的 session 焊进 `/ws`，**替换 echo**：连上发快照、之后转发实时事件、上行帧分派到 SessionManager 方法。

**范围边界（本 spec 明确不做）**：多会话 / 持久化（S1/S2）、多模态 parts（F4/I2）、断线事件补发（需持久化，留 S1）、Agent / ScheduleWakeup 工具接线（需 live client 反向访问 manager，非聊天必需）、管理类命令 compact/revert/setTodos（走各自功能 spec 的资源 API，§5.1）、TLS（A2）、React 前端（F4）。

## 2. 解耦边界（本 spec 必须守住）

- **web 永不 value-import core。** 经核实，`packages/core` 是 Node 引擎：源码用 `node:fs`（settings.ts）、`node:child_process`（agent.ts）、`node:http`、`better-sqlite3` 等（12+ 文件），物理上无法进浏览器 bundle。**但 `import type` 在编译期被擦除**——零运行时、零 bundle 字节。
- 据此，路线图 §3 "web 不 import core" 的**真实含义**是"别把 core 的 *运行时* 拖进浏览器 bundle"，**不是**"web 不能用 core 的类型"。按路线图 §2 自己的原则，复用 core 是**引用库、不构成耦合**；唯一禁止的是 web↛tui。
- **`packages/protocol` 不是 firewall，是线缆契约的单一源头**：它 type-only 地 re-export core 的几个类型，并定义 core 里没有的线缆消息。web 只依赖 protocol（type-only），server 也从 protocol 取这些类型。
- **零 server→tui import 不破**（F1/F2 已守住，本 spec 续守）。

## 3. 包结构变化

| 包 | 变化 |
|----|------|
| `packages/protocol`（新增） | 纯 type-only 包。无运行时逻辑。沿用现有 `type:module` / Node≥22 / tsup / exports→dist 约定。 |
| `packages/server` | 新增 `@zuse/protocol` 依赖；`session/events.ts` 把线缆 DTO 迁到 protocol、改为从 protocol 转手；新增 `session/createSession.ts`（工厂）；`ws/wsServer.ts` 替换 echo；`startServer.ts` 构建并注册 session。 |

## 4. `packages/protocol` 内容

### 4.1 从 core type-only 转导
```ts
export type { Usage, PermissionRequest, PermissionVerdict } from '@zuse/core'
```
> 这三个是 `SessionEvent` / 快照 / `permission-reply` 实际用到的 core 类型。`export type` 保证编译期擦除，web 侧不沾 core 运行时。

### 4.2 从 server 迁入的线缆 DTO
把以下类型从 `server/session/events.ts` **迁到 protocol**（server 改为从 protocol import）：

- `SessionEvent`（F2 已定义的全部成员，原样搬；它本就被设计成"全 JSON 可序列化、镜像 core StreamEvent 字段名"）
- `SessionSnapshot`
- `TodoItemLite`
- `PendingPermissionLite`

> **留在 server**（非线缆类型，是 SessionManager 内部契约）：`SnapshotStore`、`SessionCheckpoint`。

### 4.3 新增线缆消息联合
```ts
// 上行 client → server
export type ClientMessage =
  | { type: 'send'; text: string }
  | { type: 'interrupt' }
  | { type: 'steer'; text: string }
  | { type: 'permission-reply'; id: string; verdict: PermissionVerdict }
  | { type: 'switch-model'; providerId: string; model: string }

// 下行 server → client
export type ServerMessage =
  | { type: 'snapshot'; snapshot: SessionSnapshot }   // 连上即发一次
  | { type: 'event'; event: SessionEvent }            // 每条 live 事件转发
  | { type: 'error'; message: string }                // 协议级错误
```

**约定**：
- discriminant 字段统一用 `type`，与 `SessionEvent` 一致（`{type:'event', event:{type:'text-delta',…}}` 嵌套合法）。
- `send` / `steer` 只带 `text`；多模态 parts 留给 F4/I2（路线图 §5.2）。`SessionManager.submit(text, _parts?, opts?)` 的 parts 形参本就留空，F4 再填。
- **二进制帧**：F3 收到二进制 WS 帧即忽略（不报错、不处理），给 V1 语音留口子（路线图 §5.3）。JSON 帧才是控制/事件通道。
- `permission-reply.verdict` 取 `PermissionVerdict`（`allow` / `deny` / `allow_session` / `allow_persist`），由 SessionManager 的 `resolvePermission` 校验非法值。

## 5. 会话工厂 `createSession`

新模块 `packages/server/src/session/createSession.ts`：把 core/tools 真件接成一个可工作的 `SessionManager`。镜像 TUI 在 `index.tsx` / `App.tsx` / `useConversation.ts` 的构造序列，但**不碰 React、不 import tui**。

### 5.1 签名
```ts
export interface CreateSessionDeps {
  /** 注入用：协议/工厂单测传 fake client，离线不烧 token。缺省走 createModelClient。 */
  client?: ModelClient
  /** 注入用：测试可传假快照存储。缺省 createSnapshotStore(cwd)。 */
  snapshotStore?: SnapshotStore
}
export function createSession(cwd: string, deps?: CreateSessionDeps): SessionManager
```

### 5.2 构造序列（真件）
1. `const settings = loadSettings()`；`installProxy(settings)`（与 TUI 一致：任何出站请求前装代理；失败降级直连、告警不阻断）。
2. `const sel = resolveModelSelection(settings)` → `{ providerId, model }`。
3. `client = deps.client ?? createModelClient(getProviderConfig(settings, sel.providerId), sel.model)`。
4. **registry**：`createDefaultRegistry({ webSearch: getWebSearchConfig(settings), memoryProject: cwdSlug(cwd), skills: scanSkills(...) })`。
   - 经核实，`createDefaultRegistry` **不含** TodoWrite/Agent/ScheduleWakeup（TUI 自行 post-hoc 注册）。故工厂**额外**：
     `registry.register(createTodoWriteTool({ onUpdate: (todos) => mgr.setTodos(todos) }))`
   - `mgr` 此刻尚未构造 → **late-bind**：`let mgr: SessionManager` 先声明，`onUpdate` 闭包引用它，构造后再赋值（镜像 TUI 的 ref 套路）。
   - **不接 Agent / ScheduleWakeup**：二者的 `getClient` / `getSystemPrompt` 需反向访问 manager 的 live client（failover 会热替换），且非聊天必需；显式留作 follow-up。
5. **systemPrompt**：`buildSystemPrompt({ platform, osVersion, shell, cwd, date }, loadPromptSections(homedir(), cwd), sel.model)`（与 TUI `promptInfo` 一致，但启动期算一次；compaction 后系统提示词重建在 SessionManager 内部已注明为"deferred to owner"，F3 不补）。
6. **snapshotStore**：`deps.snapshotStore ?? createSnapshotStore(cwd)`。
7. `permissionPolicy: { interactive: true, config: settings.permissions }`。
8. `mgr = new SessionManager({ sessionId, cwd, client, registry, settings, systemPrompt, permissionPolicy, snapshotStore, providerId: sel.providerId })`；回填 late-bind 的 `mgr`；`return mgr`。

> `sessionId`：F3 单会话，用一个固定 id（如 `'default'`）即可；多会话 id 生成留 S1。

## 6. 接线：替换 echo

### 6.1 startServer 构建并注册 session
`startServer` 在 listen 前**饱和构建一次** session：
```ts
const registry = new SessionRegistry()
let sessionErr: string | undefined
try {
  registry.set('default', createSession(cfg.cwd ?? process.cwd()))
} catch (err) {
  sessionErr = err instanceof Error ? err.message : String(err)
  console.warn(`[zuse-server] session 构建失败：${sessionErr}（/ws 将回 error，health/login 仍可用）`)
}
const ws = attachWsServer(httpServer, { auth, registry, sessionErr })
```
- **工厂抛错不崩 daemon**（如缺 API key / 坏配置）：记日志，health/setup/login 仍可用；/ws 连上回 `{type:'error', message:'session unavailable: …'}`。
- `cfg` 需新增可选 `cwd`（缺省 `process.cwd()`）；bin 传入用户敲命令的目录（参照 TUI 的 `INIT_CWD`）。

### 6.2 attachWsServer 行为（替换第 23–27 行 echo）
鉴权仍在 upgrade 时做（F1 已实现，不动）。每条连接：
1. 若 `sessionErr` 或取不到 session → 发 `{type:'error', message:'session unavailable: …'}`，保持连接（前端可显示原因）。
2. 否则：
   - `const unsub = mgr.subscribe((e) => sendJson(ws, { type: 'event', event: e }))`
   - 立即 `sendJson(ws, { type: 'snapshot', snapshot: mgr.getState() })`
   - `ws.on('message', (data, isBinary) => { if (isBinary) return; dispatch(parse(data)) })`
   - `ws.on('close', unsub)`
3. **上行分派** `dispatch(msg: ClientMessage)`：
   | type | 动作 |
   |------|------|
   | `send` | `mgr.submit(msg.text)`（catch "turn already in progress" → error 帧；其余拒绝同理） |
   | `interrupt` | `mgr.interrupt()` |
   | `steer` | `mgr.steer(msg.text)` |
   | `permission-reply` | `mgr.resolvePermission(msg.id, msg.verdict)` |
   | `switch-model` | `mgr.switchModel(msg.providerId, msg.model)` |
   - `JSON.parse` 失败 / 非对象 / 未知 `type` → 回 `{type:'error', message:'…'}`。
   - `submit` 是异步且自带并发回合守卫（`isThinking` 时抛错）；分派里 `.catch` 成 error 帧，**不** await 阻塞消息泵。
4. **多连接共享同一 session**：每条连接独立 subscribe；多设备同看同一会话。`submit` 的并发守卫保证两端同时 send 时第二个收到 error 帧。
5. `closeAll()`（F1 已有）继续 terminate 所有 clients；session 本身内存态、随进程生命周期。

## 7. 数据流（一次 send 的端到端）

```
浏览器 ──{type:'send',text}──▶ ws.message ──dispatch──▶ mgr.submit(text)
                                                            │
   SessionManager 回合循环 runAgent ── emit SessionEvent ──┤
                                                            ▼
浏览器 ◀──{type:'event',event:{type:'text-delta',…}}── subscribe 回调 sendJson
   （turn-start / message-start / text-delta* / tool-use / tool-result /
     message-stop / usage-update / context-update / checkpoint-recorded / turn-end）
```
权限：回合中 `canUseTool` 命中 ask → emit `permission-request` → 前端按钮 → 上行 `permission-reply` → `resolvePermission` → emit `permission-resolved` → 回合继续。

## 8. 错误处理

| 场景 | 行为 |
|------|------|
| 工厂构造失败（缺 key/坏配置） | daemon 不崩；/ws 连上回 `error` 帧；health/login 正常 |
| 上行帧 JSON.parse 失败 / 非对象 / 未知 type | 回 `{type:'error'}`，连接保持 |
| `submit` 时已有回合在跑 | `submit` 抛错 → catch → `{type:'error', message:'A turn is already in progress'}` |
| 二进制帧 | 忽略（V1 预留） |
| 回合内模型/工具错误 | SessionManager 已 emit `error`/`warning`/`aborted`/`failover`/`model-select-needed` 事件，原样经 `event` 帧转发，前端展示 |
| 客户端断开 | `unsub`；**未决权限不拆**（F2 注明：dropped client 的 pending 留着，重连后可解）|

## 9. 测试策略（vitest，沿用现有约定）

- **protocol**：纯类型包，无运行时测试；可放一个 type-level 编译断言文件确保联合可辨别（可选）。
- **createSession**（`createSession.test.ts`）：注入 fake client（`testFakes.fakeClient`）+ fake snapshotStore；断言
  - 返回的 mgr 能 `submit` 出 turn-start→…→turn-end 事件流；
  - TodoWrite 的 `onUpdate` 接通 `mgr.setTodos`（registry.get('TodoWrite') 跑一次 → 收到 `todos-update`）。
- **wsServer**（扩 `wsServer.test.ts`）：内存 ws 客户端 + 用 fake-client session（直接 `registry.set('default', createSession(cwd,{client:fake}))`）：
  - connect → 收到 `snapshot` 帧；
  - 发 `send` → 收到 `event` 流；
  - `interrupt` / `permission-reply` / `switch-model` 正确分派（可用 spy/事件断言）；
  - 坏帧 / 未知 type → 收到 `error` 帧；
  - `sessionErr` 注入 → 连上收到 `error` 帧而非 snapshot。
- **解耦守护**：现有"零 server→tui import"检查不破；protocol 包对 core 仅 `import type`。
- **F1/F2 既有 62+30 测试不回归。**

## 10. 验收

1. `npx tsx packages/server/src/bin.ts` 起服务，浏览器开 `http://127.0.0.1:4180/`、登录后，dev 页能发消息并看到模型**真流式回复**（替换了 echo）。
2. 中断、权限审批（若 dev 页支持）、failover 提示等事件能到前端（至少在 WS 帧层面可见）。
3. 全 workspace `pnpm test` 绿；`pnpm -F @zuse/server build` 与 `pnpm -F @zuse/protocol build` 通过；`npm pack` tarball 仍干净。

## 11. Follow-ups（不阻断 F3）

- Agent / ScheduleWakeup 工具在 web session 的接线（需 live client/systemPrompt 反向访问 manager）。
- 多会话 + 持久化 + 断线事件补发（S1）。
- 管理类命令（compact/revert/setTodos/setPermissionPolicy）走 §5.1 资源 API（M6 等）。
- compaction 后 systemPrompt 重建（reload MEMORY.md）——SessionManager 已注明 deferred to owner。
