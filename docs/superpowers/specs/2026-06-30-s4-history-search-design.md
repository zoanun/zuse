# S4 历史搜索 — 设计文档

> **日期**: 2026-06-30
> **路线图**: Web UI 程序 §4.2（多会话/多项目）S4
> **依赖**: S1（会话已持久化为 JSON 文件，含完整 `messages[]`）、S2（会话侧边栏）
> **状态**: 设计已确认，待转实现计划

---

## 1. 背景与目标

会话越攒越多后，"我那句话/那个答案在哪个会话里"成为真实痛点。S4 提供**跨会话全文检索**：在侧边栏顶部搜索框输入关键词，结果按会话分组、定位到**具体消息**，点击直接跳到那个会话并滚动到那条消息。

**已确认的产品决策**（brainstorm 结论）：
1. **搜什么**：全文搜消息正文，结果**定位到具体消息**（不止会话级）。
2. **索引哪些内容**：只索引**人话**——`role ∈ {user, assistant}` 的文本块；**不**索引工具调用参数（tool_use）与工具返回（tool_result），避免命令输出/文件内容把结果淹没。
3. **入口与呈现**：现有会话侧边栏（S2）顶部加搜索框；输入后侧边栏从"会话列表"切到"结果列表"，按会话分组、每条命中显示高亮片段，点击跳转。
4. **范围**：全局（所有会话）。现侧边栏本就是全局列表（`service.list()` 无项目过滤），结果里带各自 `cwd` 以便区分项目。
5. **检索实现**：**按需扫描 + mtime 缓存**（方案 A），不建独立索引。理由见 §2。

## 2. 方案选择：按需扫描（A），不是 FTS 索引（B）

**选 A——按需扫描 + mtime 缓存。** 搜索时遍历会话文件、对人话做大小写无关子串匹配，按会话 `updatedAt` 倒序。复用 `sessionStore` 已有的 mtime 缓存模式：每个会话抽取出的人话按文件 mtime 缓存，只有变动的会话才重新解析。

- **为什么不用 FTS5 索引（B）**：FTS 的真正价值（GB 级语料、相关性排序）在"单用户本地聊天史"这个规模用不上（几百会话 × 几百 KB ≈ 几十 MB 人话，子串扫描是毫秒级）。而 B 会引入一整套索引生命周期——回填已有会话、删除/改名/保存时同步、损坏重建、额外 db 文件与迁移面——是过度工程，且每个同步点都是潜在 bug。
- **A 的代价（明确接受）**：没有语义相关性排序，只有 recency + 命中数排序。对"历史定位"诉求，最近优先恰恰是想要的。
- **中文**：A 用 `includes()` 子串匹配天然支持中文，无需 memory 那套 trigram FTS + LIKE 兜底。

## 3. 架构总览

```
浏览器 Sidebar(搜索框) ──GET /api/search?q=──> http/server.ts ──> SearchService.search()
        │                                                              │
        │ 结果(按会话分组,带消息级片段)                                 │ 扫 sessions 目录
        │                                                              │ + 人话 mtime 缓存
        ▼                                                              ▼
   结果模式列表 ──点击命中──> switchSession(id) + 滚到 msgIndex          会话 JSON 文件(只读)
```

新增一个无状态查询服务 `SearchService`、一个 auth-gated 端点、一组协议类型；前端在 `Sidebar` 加搜索态。**零新增持久化**。

## 4. 后端

### 4.1 `SearchService`（`packages/server/src/search/SearchService.ts`，新）

接口：
```ts
class SearchService {
  constructor(opts: { dir: string })   // dir = 会话存储目录(与 SessionService 同源)
  async search(q: string, opts?: { limit?: number; perSessionCap?: number }): Promise<SessionSearchResult[]>
}
```

`search(q)` 流程：
1. 空/纯空白 `q` → 返回 `[]`（不扫描）。
2. `readdir(dir)` 取所有 `.json`；对每个文件 `stat` 取 `mtimeMs`。
3. **人话缓存**：模块级 `Map<path, { mtimeMs: number; docs: ProseDoc[] }>`。mtime 命中则复用 `docs`；否则 `readFile` + `JSON.parse`，抽取人话入缓存。损坏/不完整文件跳过（不整体失败）。扫描结束清理已消失文件的缓存项（防无界增长）。
4. **抽取人话**（`ProseDoc = { msgIndex: number; role: 'user'|'assistant'; text: string }`）：遍历 `record.messages`，仅 `role ∈ {user, assistant}`；`text` = 该消息 `content` 中 `type==='text'` 块拼接；user 文本剥掉 `submit()` 加的 `[YYYY-MM-DD HH:MM] ` 时间戳前缀；忽略 `tool_use`/`tool_result` 块与空文本消息。
   - **前置小改动**：`stripUserStamp`/`USER_STAMP_RE` 目前是 `SessionManager.ts` 内的**私有**件，SearchService 用不了。把这两个抽到一个共享小模块（如 `packages/server/src/session/userStamp.ts`），`SessionManager` 改 import、行为不变（有现成测试守护），SearchService 复用同一份——避免两份漂移的剥前缀正则。
5. **匹配**：`doc.text.toLowerCase().includes(q.toLowerCase())`。
6. **片段**：取首个命中位置，向前后各扩 `SNIPPET_RADIUS = 40` 字符，截断端补省略号，返回 `{ pre, match, post }`（`match` = 原文中命中的那段，保留原大小写）。
7. **分组/排序/封顶**：按会话分组；会话按 `updatedAt` 倒序；组内按 `msgIndex` 升序。每会话最多 `perSessionCap = 5` 条命中（`hitCount` 记总命中数，可 > `hits.length`）；总会话/命中数受 `limit = 100` 约束。

> mtime 缓存与 `listSessions` 的 `metaCache` 是**两份独立缓存、同一模式**。可选优化：合并一次 `readdir`/`stat` 扫描——非必须，留作实现时判断，不作为设计约束。

### 4.2 端点 `GET /api/search`（`packages/server/src/http/server.ts`）

照 `/api/memory` 的形态：auth-gated（未登录 401）。查询参数 `?q=&limit=`。返回 `200` + `SessionSearchResult[]`。空 `q` 返回 `[]`。`deps` 增加 `search: SearchService`，在 server 装配处构造（与 `SessionService` 同 `dir`）。

## 5. 协议类型（`packages/protocol`）

```ts
export interface SearchSnippet { pre: string; match: string; post: string }
export interface SearchHit {
  msgIndex: number
  role: 'user' | 'assistant'
  snippet: SearchSnippet
}
export interface SessionSearchResult {
  session: { id: string; title: string; cwd: string; updatedAt: string }
  hits: SearchHit[]
  hitCount: number   // 总命中数；可能 > hits.length（每会话封顶后）
}
```

## 6. 前端

### 6.1 Sidebar 搜索态（`packages/web/src/components/Sidebar.tsx`）

- 顶部加 `<input>`，本地 `query` state + **防抖 ~200ms**。
- `query` 非空 → 调 `GET /api/search?q=`（新 `searchSessions(q)` in `state/session.ts` 或 `manageApi`），列表切到**结果模式**：
  - 按 `SessionSearchResult` 分组：组头 = 会话标题（+ `cwd` 小字/项目标识）；每行一条 `SearchHit`：角色标记（user/assistant）+ `snippet`（`pre` + 高亮 `match` + `post`）。
  - 组尾若 `hitCount > hits.length` 显示"还有 N 条"。
- `query` 为空 → 恢复正常会话列表（现有渲染）。
- **竞态**：防抖 + 最新请求优先（请求序号/AbortController，忽略过期响应）。
- 失败 → 行内提示，不崩列表。

### 6.2 跳转到消息

点击某条 `SearchHit`：
1. 复用 `switchSession(session.id)`（已存在）切会话。
2. 携带目标 `msgIndex`：切换后 `MessageList` 滚动到对应消息并短暂高亮（flash）。
3. **id 映射**：`applySnapshot` 给历史消息的 id 是 `'h' + 快照索引`，而快照来自 `SessionManager.getState()` 投影的 `conversation.getMessages()`，与 ledger `msgIndex` 同序——故目标 DOM 由 `'h' + msgIndex` 定位。**实现时复核此映射**（若投影对消息有折叠/过滤导致错位，则改为让快照消息携带 ledgerIndex 字段，按它匹配）。
4. 机制：store 里存 `pendingScrollTo: { id; msgIndex } | null`，`MessageList` 在快照到达后消费一次（scrollIntoView + 高亮 class），随即清空。

## 7. 错误与边界

- 空/纯空白 `q`：不搜，显示会话列表。
- 无结果：结果模式显示"无匹配"。
- 单个会话文件损坏/解析失败：跳过该文件，不影响其余结果。
- 超长会话：只回片段；每会话命中封顶（`perSessionCap`），尾部给"还有 N 条"。
- 只搜 `user`/`assistant` 文本；跳过 system 通知、`tool_use`、`tool_result`。
- 跳转目标消息不存在（会话已被 revert/截断短于 `msgIndex`）：切到会话即可，滚动静默失败（不报错）。

## 8. 测试

**`SearchService` 单测**（`SearchService.test.ts`）：
- 命中 user 与 assistant 人话；**排除** tool_use/tool_result 内容；排除 system。
- 大小写无关；**中文子串**命中（如搜"压缩"）。
- 片段窗口正确（`pre/match/post`、端部省略号、`match` 保留原大小写）。
- 排序：会话按 `updatedAt` 倒序，组内按 `msgIndex`。
- 每会话封顶 + `hitCount > hits.length`；总 `limit`。
- mtime 缓存复用：同一会话二次搜索不重新 `JSON.parse`（用注入的计数 reader 验证）。
- user 文本剥掉时间戳前缀后仍能按原话命中。
- 空/空白 `q` → `[]`。

**路由测试**（扩 `server` http 测试）：`/api/search` 未登录 401；带 `q` 返回分组结构；空 `q` 返回 `[]`。

**前端**（`Sidebar.test.tsx`）：输入触发结果模式渲染、片段高亮分段；点击命中调用 `switchSession` 且设置 `pendingScrollTo`；清空 query 恢复会话列表；防抖/最新优先（最少一个竞态用例）。

## 9. 非目标

- 不建持久化索引（FTS/向量）。
- 不做相关性/语义排序（只 recency + 命中数）。
- 不搜工具输出、不搜附件/图片。
- 不做搜索结果分页（封顶 + "还有 N 条"足够；真需要再议）。
- 不改 TUI。

## 10. 涉及文件清单（实现参考）

| 文件 | 改动 |
|------|------|
| `packages/protocol/src/index.ts` | 新增 `SearchSnippet`/`SearchHit`/`SessionSearchResult` |
| `packages/server/src/session/userStamp.ts` | 新建：从 `SessionManager` 抽出 `stripUserStamp`/`USER_STAMP_RE`（`SessionManager` 改 import）|
| `packages/server/src/search/SearchService.ts` | 新建：扫描 + 人话缓存 + 匹配 + 片段 + 分组 |
| `packages/server/src/search/SearchService.test.ts` | 新建：单测 |
| `packages/server/src/http/server.ts` | 新增 `GET /api/search`；`deps.search` |
| `packages/server/src/http/server.test.ts`（或对应） | 路由测试 |
| server 装配处（startServer / deps 构造） | 构造 `SearchService({ dir })` |
| `packages/web/src/state/session.ts`（或 manageApi） | `searchSessions(q)` 客户端 |
| `packages/web/src/state/store.tsx` | `pendingScrollTo` 状态 + 透传 |
| `packages/web/src/components/Sidebar.tsx` | 搜索框 + 结果模式渲染 + 点击跳转 |
| `packages/web/src/components/Sidebar.test.tsx` | 前端测试 |
| `packages/web/src/components/MessageList.tsx` | 消费 `pendingScrollTo`：滚动 + 高亮 |
