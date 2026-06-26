# S2 — 会话列表侧边栏（列出 / 切换 / 删除 / 重命名）设计

> **日期**: 2026-06-26
> **所属**: [Web UI 路线图总纲](./2026-06-22-web-ui-roadmap.md) 多会话 S2
> **前置**: S1 已在 master（多会话持久化 + REST `GET/POST/DELETE /api/sessions` + WS `?session=<id>` attach + 前端记住当前 id）
> **解锁**: S3（每会话独立 cwd）、S4（搜索）

---

## 1. 目标与边界

S1 把会话存了盘、记住了"当前"，但**界面上没有回到旧会话的路**——点 New chat 后旧会话只能靠 devtools 改 localStorage 切回。S2 补上**可见的会话列表侧边栏**：列出、点选切换、删除、重命名。

**S2 范围**：
- 前端：侧边栏渲染 `GET /api/sessions` 列表、高亮当前会话、点选切换（重连 WS + 本地 reset + snapshot 带回历史）、删除按钮、重命名（内联编辑 title）。New chat 后列表刷新并高亮新会话。
- 后端：新增 `PATCH /api/sessions/<id>`（改 title）+ `service.rename()`；**顺带修掉 S1 的两个 follow-up**：①delete 退订 autosave（防"复活"）、③畸形 id 在 DELETE/WS 无 catch（改成 400 / error 帧而非挂起）。
- **不在 S2**：每会话独立 cwd / 项目维度 = S3；跨会话搜索 = S4；空闲会话 LRU 内存驱逐。

**解耦不变**：`@zuse/server` 不 import `@zuse/tui`。

## 2. 后端改动

### 2.1 SessionRecord / sessionStore（`sessionStore.ts`）
- `SessionRecord += titleManual?: boolean`——标记 title 是用户手动改的（rename 设 true），用于让 autosave 的 `deriveTitle` **不要覆盖**手动标题。`listSessions` / `loadSession` 不变（title 字段已在）。
- 其余 CRUD（save/load/list/delete/safeId）不动。

### 2.2 SessionService（`SessionService.ts`）
**a) 修 follow-up ①（delete 复活）+ 引入 tombstone**
- 加 `private unsubs = new Map<string, () => void>()`：`wireAutosave` 存下 `mgr.subscribe(...)` 的返回值（当前被丢弃）。
- 加 `private tombstones = new Set<string>()`：`delete(id)` 时：调 `unsubs.get(id)?.()` 退订 → `unsubs.delete(id)` → `registry.remove(id)` → `tombstones.add(id)` → `persistAgain.delete(id)`（清掉待决的尾随保存）→ `deleteSession(file)`。
- `persist()` 在 `saveSession` 前检查 `if (this.tombstones.has(id)) return`——堵住"删除时正好有一个 in-flight persist 在 `await saveSession`，删完文件后又被尾随 persist 重写"的竞态窗口。
- `getOrLoad` / `create` / `adopt` 注册时 `tombstones.delete(id)`（同 id 复用时复活合法）。

**b) rename + 手动标题**
- 加 `private manualTitles = new Map<string, string>()`。
- `async rename(id: string, title: string): Promise<void>`：`manualTitles.set(id, title)`；若 `registry.get(id)` 存活 → `await persist(id, live)`（走正常落盘）；否则 `loadSession` → 有则改 `title`+`titleManual=true`+`updatedAt` → `saveSession`（不经 live mgr）。
- `persist()` 标题优先级改为：`forcedTitle ?? manualTitles.get(id) ?? deriveTitle(messages)`；并写 `titleManual: manualTitles.has(id)`。
  - 注：`forcedTitle` 仅 create/adopt 的初始记录用，优先级最高（初始就是 'New chat'，此时还没手动改，无冲突）。
- `getOrLoad` 从盘恢复时：`if (rec.titleManual) manualTitles.set(id, rec.title)`——重启后手动标题不丢。

### 2.3 HTTP（`http/server.ts`）
- **新增 `PATCH /api/sessions/<id>`**（鉴权）：body `{title:string}` → `service.rename(id, title)` → `{ok:true}`。title 缺失/非串 → 400；空串拒绝（或回退默认？取**拒绝空串 400**，避免空标题）。
- **修 follow-up ③（第一半）**：把 `/api/sessions` 系列路由里调 `service.*(id)` 的部分包进 try/catch——`safeId` 对畸形/穿越 id 抛错时返回 `400 {error:{code:'bad_request',...}}`，而非让 `void handle()` 抛未捕获 rejection 使客户端挂起。DELETE / PATCH 都要包。

### 2.4 wsServer（`ws/wsServer.ts`）
- **修 follow-up ③（第二半）**：`getOrLoad(sessionId)` 在 async IIFE 里，`safeId` 抛错会变未捕获 rejection、socket 永久挂起。用 try/catch 包住，捕获后 `sendJson(ws, {type:'error', message:'invalid session id'})`（不 wireSocket）。

## 3. 前端改动

### 3.1 `state/session.ts`（API 客户端）
新增：
- `listSessions(): Promise<SessionMeta[]>` —— `GET /api/sessions`。
- `deleteSession(id): Promise<void>` —— `DELETE /api/sessions/<id>`。
- `renameSession(id, title): Promise<void>` —— `PATCH /api/sessions/<id>` body `{title}`。
- `SessionMeta` 类型：从 `@zuse/protocol` 暴露（见 §4）或前端本地镜像（取**protocol 暴露**，与既有 `import type` 模式一致）。

### 3.2 `state/store.tsx`
- 加一份会话列表状态：`const [sessions, setSessions] = useState<SessionMeta[]>([])`（与事件 reducer 正交，不塞进 AppState）。
- 加 `currentSessionId`（来自 `getSessionId()`，切换时更新，用于侧边栏高亮）。
- `refreshSessions()`：`listSessions()` → `setSessions`。在 bootstrap 后、create/switch/delete/rename 后、以及收到 `turn-end` 事件后（首条消息落定 → 标题从 'New chat' 变实际标题）调用。turn-end 触发可简单防抖/直接调（列表小，单用户）。
- `switchSession(id)`：`setSessionId(id)` → `reconnect(wsUrl(id))` → `dispatch({kind:'reset'})`（清本地，等新会话 snapshot 重建）→ 更新 currentSessionId → `refreshSessions()`。切到当前会话则 no-op。
- `removeSession(id)`：`deleteSession(id)` → 若删的是当前会话：切到列表里下一个（updatedAt 最新的其它会话），都没了则 `newSession()` → `refreshSessions()`。
- `rename(id, title)`：`renameSession(id, title)` → `refreshSessions()`。
- `newSession()`（已有）末尾追加 `refreshSessions()` + 更新 currentSessionId。
- 这些经 Context 暴露给 Sidebar。

### 3.3 `components/Sidebar.tsx`
- 渲染会话列表（`sessions`，已按 updatedAt 倒序）：每项显示 title（空/默认显示 'New chat'）、相对时间或消息数（可选，先只 title）。
- 当前会话高亮（`item.id === currentSessionId`）。
- 点条目 → `switchSession(id)`。
- 每项 hover/常驻一个**删除**按钮（×）→ 确认（内联或 confirm）后 `removeSession(id)`。删当前项也允许。
- **重命名**：双击标题进入内联 input（或每项一个 ✎ 按钮），回车 / 失焦提交 `rename(id, title)`，Esc 取消。空串不提交。
- New chat 按钮保留在顶部；移除"列表稍后到"的占位文案。
- 触屏友好（删除/改名按钮不能纯 hover-only，参照 revert 图标的教训：常驻或 0.5 透明度）。

### 3.4 `styles.css`
- `.session-list` / `.session-item`（active 态、hover）、`.session-del`、`.session-rename-input` 等。沿用现有暗色风格。

## 4. 协议（`@zuse/protocol`）
- 暴露 `SessionMeta`（`{id,title,createdAt,updatedAt,cwd,messageCount}`）类型，前端 `import type` 复用，避免前端本地重复定义、与后端 `sessionStore.ts` 的 `SessionMeta` 保持单一形状。
  - 实现：protocol 定义 `SessionMeta`，server 的 `sessionStore.ts` `import type` 它（或反向——以 **protocol 为权威源**，server 引用）。注意 protocol 是 type-only 包，server/web 都可 `import type`。

## 5. 边角 / 鲁棒性
- **删当前会话**：切到列表里其它最新会话；列表空 → 自动新建（不留空白界面）。
- **重命名 race**：手动标题进 `manualTitles` 内存图 + 盘上 `titleManual` 标记；之后该会话再 turn-end，`persist` 用 manualTitle 不被 `deriveTitle` 覆盖；重启后 `getOrLoad` 重新 seed manualTitles。
- **畸形 id**：DELETE/PATCH → 400；WS attach → error 帧。两处都不再挂起（follow-up ③ 闭合）。
- **delete 复活**：unsub + tombstone 双保险（follow-up ① 闭合）。
- **列表刷新时机**：create/switch/delete/rename/turn-end + bootstrap。多端实时同步（一个浏览器删了另一个浏览器的列表不自动更新）**不做**——单用户单端为主，留后续（可加轮询或 WS 广播）。
- 空会话（msgs=0、title 'New chat'）照常列出（create 即落占位记录，S1 已定）。

## 6. 测试
- **sessionStore**：`titleManual` save→load 往返。
- **SessionService**：
  - `rename` 改 live 会话标题 → 之后 turn-end persist 标题不被 deriveTitle 覆盖（断言文件 title 保持手动值、titleManual=true）。
  - `rename` 改非 live（仅盘上）会话 → 直接改盘。
  - **delete 不复活**：create → 订阅 → delete → 手动触发一次 persist（或模拟 in-flight）→ 断言文件不再出现 / list 不含。
  - `getOrLoad` 恢复带 titleManual 的记录 → 后续不被覆盖。
- **HTTP（集成，端口 0 + 临时目录 + cookie）**：
  - PATCH 改名 → GET 列表 title 更新；未登录 401；缺 title 400；空 title 400。
  - DELETE / PATCH 畸形 id（如 `../foo`、含斜杠 encode）→ 400（不挂起、不 500 未捕获）。
- **wsServer**：`?session=<畸形 id>` → 收到 error 帧（不挂起）。
- **web**：
  - `session.ts`：list/delete/rename 发对的请求（mock fetch）。
  - store：switchSession 重连到新 id + reset；removeSession 删当前 → 切到下一个 / 空则新建；refreshSessions 填充 sessions。
  - Sidebar：渲染列表、高亮 active、点选触发 switch、删除按钮触发 remove、重命名提交 rename（props 注入，纯组件测）。
- 不打真实模型/网络；临时目录隔离，绝不碰真实 `~/.zuse/web-sessions`。

## 7. 完成判据
浏览器：发几句 → 旧会话出现在左侧列表 → 点 New chat 建新会话、旧的仍在列表可点回（**不用再碰 devtools/localStorage**）→ 点旧会话切回看到历史 → 删除会话从列表消失（删当前则自动切走）→ 双击改名持久（刷新 / 重启 daemon 后仍是新名、不被自动标题覆盖）。`@zuse/server` + `@zuse/web` 测试全绿、typecheck 干净、零 tui 依赖。S1 的 follow-up ①③ 闭合。

## 8. follow-up（非本期）
- **S3**：每会话独立 cwd / 项目维度选择。
- **S4**：跨会话全文搜索。
- 多端实时一致（删除/切换/改名的跨浏览器即时同步——轮询或 WS 列表广播）。
- 空闲会话 LRU 内存驱逐。
- follow-up ②（reset-session 上行不触发 autosave）：web 已不发该上行，对 web 是 dead path，S2 不动；若将来复用 reset-session 再处理。
