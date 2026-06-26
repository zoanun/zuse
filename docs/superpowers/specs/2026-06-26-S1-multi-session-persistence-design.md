# S1 — 多会话持久化 + 列表 设计

> **日期**: 2026-06-26
> **所属**: [Web UI 路线图总纲](./2026-06-22-web-ui-roadmap.md) 多会话 S1
> **前置**: F1–F4 + M6 均已在 master（单内存会话 `DEFAULT_SESSION_ID`）
> **解锁**: S2（侧边栏切换 UI）、S3（项目切换）、S4（搜索）
> **额外职责**: 落地总纲 §5.1"统一资源 API 约定"（用 HTTP REST），M1–M7 管理面板将照此模式。

---

## 1. 目标与边界

把当前**单个内存会话**变成**多会话 + JSON 文件持久化 + HTTP REST CRUD**，WS 按 sessionId attach，会话重启不丢。

**已定决策**：JSON 文件/会话；会话 CRUD 走 HTTP REST。

**S1 范围**（后端为主 + 最小前端接线）：
- 后端：会话存储（JSON）、REST CRUD、WS 按 sessionId attach、attach 时从盘恢复、每回合 autosave。
- 最小前端：web 连接时带 sessionId（localStorage 记住）；"New chat" 改为**创建新会话**（POST）并切过去。
- **不在 S1**：可视化**会话列表侧边栏 / 切换 UI = S2**；每会话独立 cwd 选择 = S3；搜索 = S4。S1 只把 List API + 最小连接接线做出来。

**解耦**：`@zuse/server` 不 import `@zuse/tui`。复用 TUI 的 `SessionRecord` 格式靠**镜像**（格式纯数据，依赖只 core/tools）。

## 2. 存储

- 目录：`~/.zuse/web-sessions/`（平铺，每会话一个 `<id>.json`；web 会话不按 cwd 分目录——cwd 存进记录）。可被 `authDir`/config 覆盖（测试用临时目录）。
- `SessionRecord`（server 本地定义，镜像 TUI v3 + 加 id/title/model）：
  ```ts
  interface SessionRecord {
    version: 1
    id: string
    title: string          // 列表展示名：首条用户消息前 ~60 字，缺省 'New chat'
    cwd: string
    model?: string
    createdAt: string
    updatedAt: string
    messages: Message[]        // conversation.toJSON().messages
    totalUsage: Usage          // conversation.toJSON().totalUsage
    checkpoints: SessionCheckpoint[]
  }
  ```
- `sessionStore.ts`（新）：`saveSession(dir, rec)` / `loadSession(dir, id): SessionRecord | null` / `listSessions(dir): SessionMeta[]`（读目录，返回 `{id,title,createdAt,updatedAt,cwd,messageCount}` 摘要，不读全量 messages 也行——但 v1 简单起见可读全量取 count）/ `deleteSession(dir, id)`。原子写（tmp+rename）、坏文件跳过。
- sessionId 生成：镜像 TUI `newSessionId()`（时间戳 + 4 随机 hex），server 本地实现（`new Date()` 在 server runtime 可用）。

## 3. SessionManager 改动（最小）

- **加取数器**（供持久化）：`getConversation(): Conversation`（或 `toRecordParts(): {messages, totalUsage}`）、`getCheckpoints(): SessionCheckpoint[]`、`getTitle()/getModel()`（或复用 getState）。当前 conversation/checkpoints 私有，需暴露只读。
- **加恢复入参**：构造器 `SessionManagerOptions += checkpoints?: SessionCheckpoint[]`（已有 `conversation?`/`createdAt?`）；构造时若传入则 `this.checkpoints = opts.checkpoints ?? []`。
- 其余不变（reset() 保留）。

## 4. createSession 改动

`createSession(opts: { sessionId: string; cwd: string; conversation?: Conversation; checkpoints?: SessionCheckpoint[]; createdAt?: string; client?; snapshotStore? }): SessionManager`
- 用传入 sessionId（不再硬编 DEFAULT_SESSION_ID）。
- 若传 conversation/checkpoints/createdAt → 透传给 SessionManager（恢复路径）。
- 其余装配（settings/client/registry/systemPrompt/snapshotStore）不变。
- 注：snapshotStore 仍 `createSnapshotStore(cwd)`（影子 git 按 cwd-slug，跨会话同 cwd 共享是既有行为）。

## 5. SessionService（会话生命周期，包住 SessionRegistry）

新增一层 `SessionService`（或扩展 registry 用法）统管 内存 registry + 磁盘 store：
- `getOrLoad(id): SessionManager | null`：registry 命中→返回；否则 `loadSession(id)`→有则 `createSession({sessionId:id, conversation: fromJSON, checkpoints, createdAt})` 入 registry 返回；无则 null。
- `create({cwd?, title?}): {id}`：新 id → `createSession({sessionId, cwd: cwd ?? serverCwd})` → 入 registry → 立即落盘一条空记录（或首回合再落）→ 返回 id。
- `list(): SessionMeta[]`：合并磁盘 `listSessions()` 与内存中未落盘的新会话，按 updatedAt 倒序。
- `delete(id)`：registry.remove + deleteSession(file)。（若正 attach？S1 简单处理：删了之后该连接下条消息 attach 失败/转默认；多端一致性细节留 S2/后续。）
- **autosave**：SessionService 给每个活动 SessionManager 订阅事件，在 `turn-end` 与 `checkpoint-recorded` 时 fire-and-forget 落盘（debounce 可选）；`reset()` 后也落。title 在首条用户消息后据其更新。

## 6. HTTP REST（§5.1 资源 API 约定的首个落地）

全部经现有鉴权中间件（未登录 401）。统一 JSON、错误 `{error:{code,message}}`。
| 路由 | 方法 | 行为 |
|------|------|------|
| `/api/sessions` | GET | `service.list()` → `SessionMeta[]` |
| `/api/sessions` | POST | body `{cwd?, title?}` → `service.create(...)` → `{id}` |
| `/api/sessions/<id>` | DELETE | `service.delete(id)` → `{ok:true}`（未知 id 也 200/404，定一个）|

> 这套 list/create/delete + 资源路径形态即 §5.1 约定；M1–M7（memory/prompt/skill/MCP…）照搬此形状（各自资源名）。路由解析：在 http/server.ts 的 if-链里加一段 `/api/sessions` 前缀分派（含 `/<id>` 提取）。

## 7. WS 按 sessionId attach（替换硬编 DEFAULT）

- `wsServer.ts`：解析 `?session=<id>`（URL query）；`const mgr = service.getOrLoad(id)`；未提供 id 或 load 不到 → 发 error 帧（或回退创建？——S1 取严格：必须带有效 id，前端负责先 create/选 id）。鉴权不变（cookie）。
- attach 成功后照旧发 snapshot（M6 已含 messages+checkpoints，恢复的会话天然带历史）+ 订阅事件。
- 多连接 attach 同一 id → 共享同一 SessionManager（既有广播成立）。

## 8. 最小前端接线（full 列表 UI 留 S2）

- WS 客户端连接 URL 带 `?session=<id>`；id 存 localStorage（`zuse.sessionId`）。首次无 id → 先 `POST /api/sessions` 拿 id 存下再连。
- "New chat"：改为 `POST /api/sessions` → 拿新 id → 存 localStorage → 重连 WS 到新会话（替代当前的 reset-session；reset() 后端保留备用）。
- 刷新页面 → 用 localStorage 的 id 重连 → snapshot 带历史 → 对话还在（这点 M6 已使能，S1 让它跨会话/跨重启成立）。
- 可见的**会话列表 + 点选切换 = S2**；S1 只做"记住当前 + 新建"。

## 9. 边角 / 鲁棒性
- 坏/缺 JSON 记录：list 跳过、load 返回 null（不崩）。
- 影子 git 跨机/被删：revert 时 `restore` 抛错 → 已有 revert 契约把错误回传（M6/F2）；list/attach 不受影响。
- 空会话（没发过消息）：可不落盘（像 TUI `conv.length===0` 跳过），或落一条占位——定为"create 即落占位记录"以便 list 立刻可见。
- 并发落盘：原子 tmp+rename；同会话短时间多次 turn-end → 末次覆盖即可（debounce 可选）。
- 删除正在 attach 的会话：S1 允许，删后该 mgr 仍在内存直到断开；下次 getOrLoad 落空。多端严格一致留后续。

## 10. 测试
- **sessionStore 单测**：save→load 往返（messages/checkpoints/usage/title/cwd）；list 摘要正确、坏文件跳过；delete 删文件；newSessionId 形态。
- **SessionManager**：getConversation/getCheckpoints 取数；构造器 checkpoints 恢复后 getState/snapshot 正确。
- **createSession**：传 conversation+checkpoints → 装配出的 mgr 账本/检查点已恢复（注入假 client 离线）。
- **SessionService**：create→list 见到；getOrLoad 命中内存 vs 从盘恢复；delete 后 list 不见；autosave 在 turn-end 落盘（脚本化一回合，断言文件出现/更新）。
- **HTTP**：集成（端口 0 + 临时 web-sessions 目录 + 鉴权 cookie）：POST 建会话→GET 列出含它→DELETE→GET 不含；未登录 401。
- **WS**：`?session=<id>` attach 到对应会话；两连接同 id 共享；attach 已存在会话收到带历史的 snapshot。
- **web**：reducer/客户端连接带 sessionId；New chat 走 POST 再重连（mock fetch + ws）。
- 不打真实模型/网络；临时目录隔离，绝不碰真实 `~/.zuse/web-sessions`。

## 11. 完成判据
浏览器：发几句 → 刷新页面对话还在；New chat → 新空会话（旧的仍在盘上）；重启 daemon → 之前的会话仍能用其 id 连上看到历史；`GET /api/sessions` 列出多个会话；DELETE 删除。`@zuse/server` + `@zuse/web` 测试全绿、typecheck 干净、零 tui 依赖。

## 12. follow-up（非本期）
- **S2**：会话列表侧边栏 + 点选切换 + 删除按钮 + 重命名 title。
- **S3**：每会话独立 cwd / 项目维度。
- **S4**：跨会话全文搜索（可能引 SQLite 索引）。
- 多端删除/切换的严格一致性；空闲会话内存驱逐（LRU）。
- Agent/ScheduleWakeup/MCP 工具接线（与会话无关的既有 follow-up）。
