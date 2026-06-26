# M1 — Memory 增删改查 + 管理抽屉外壳 设计

> **日期**: 2026-06-26
> **所属**: [Web UI 路线图总纲](./2026-06-22-web-ui-roadmap.md) 管理面板 M1
> **前置**: F1–F4 + S1/S2 已在 master（§5.1 资源 API 约定已由 S1 的 `/api/sessions` 落地）
> **额外职责**: 立起**管理抽屉外壳**(右侧滑出 + 顶部 ⚙ 入口 + 内部小导航),后续 M2–M7 各塞一个面板进去即可。

---

## 1. 目标与边界
对 core 的记忆库(`~/.zuse/memory.db`,经 `@zuse/tools` 的 `openMemoryStore`)做**完整 CRUD**:列表/搜索、查看、新增、编辑、删除。并立起承载所有 M 面板的**右侧抽屉**。

**范围**:
- 引擎:给 `MemoryStore` 补 `update`(当前缺,编辑必需)。
- server:`MemoryService` + REST `/api/memory`(§5.1 形态,鉴权门禁)。
- protocol:`MemoryItem` DTO(type-only)。
- web:管理抽屉外壳(⚙ 入口 + 导航,先只 Memory)+ Memory 面板(增删改查 UI)。
- **不在 M1**:M2–M7 各自面板(仅在抽屉导航里留位/占位);记忆的自动巩固(已有,引擎侧不动)。

**解耦**:`@zuse/server` 只 import `@zuse/core`/`@zuse/tools`,不碰 tui。web 仅经 HTTP + `import type` protocol。

## 2. 引擎改动(`@zuse/tools` memory-store.ts)
`MemoryStore` 接口新增:
```ts
/** 原地更新一条记忆(保 id/createdAt 不变,刷新 updatedAt;FTS 由 memories_au 触发器同步)。未命中返回 null。 */
update(id: number, fields: { type?: MemoryType; content?: string; hook?: string; project?: string }): MemoryRow | null
```
- 实现:`UPDATE memories SET ... , updated_at=? WHERE id=?`,只改传入字段;`changes===0` 返回 null,否则查回整行返回。
- 不动 save/search/list/remove/all（已够用)。`get(id)` 不单加——`update` 返回新行、list/search 已能取单条;前端查看用列表项即可。
- 单测:update 改 content/type/hook → 行更新、updatedAt 变、FTS 命中新内容、旧内容不再命中;未知 id → null。

## 3. server
### 3.1 `MemoryService`(`packages/server/src/memory/MemoryService.ts`,新)
薄封装,持一个惰性打开的 `MemoryStore`(注入 dbPath 供测;缺省走 `openMemoryStore()` 的默认路径)。
- `list(opts?: {project?: string; q?: string; limit?: number}): MemoryItem[]` —— 有 `q` 走 `store.search(q, project ?? '', limit)`;否则 `project` 给定走 `store.list(project)`、未给走 `store.all()`。
- `create({type, content, project?, hook?}): MemoryItem` —— `store.save(...)`,project 缺省 `''`(全局)。
- `update(id, fields): MemoryItem | null` —— 透传 `store.update`。
- `remove(id): boolean` —— `store.remove`。
- `close()`。
- 注:better-sqlite3 同文件多连接安全;SessionManager 自己在巩固时也开/关连接,与本 service 的连接并存无碍。MemoryItem = MemoryRow 形状。

### 3.2 REST(`http/server.ts` 加 `/api/memory` 前缀分派,全部 `isAuthed` 门禁)
| 路由 | 方法 | 行为 |
|------|------|------|
| `/api/memory` | GET | query `?project=&q=&limit=` → `service.list(...)` → `MemoryItem[]` |
| `/api/memory` | POST | body `{type, content, project?, hook?}`;type 非法 / content 空 → 400;否则 `create` → `MemoryItem` |
| `/api/memory/<id>` | PATCH | body `{type?, content?, hook?, project?}` → `update`;未知 id → 404;非数字 id → 400 |
| `/api/memory/<id>` | DELETE | `remove`;→ `{ok:true}`(未命中也 200/ok:false)|
- id 解析复用 S2 的"路径取 id"思路;非数字 → 400(对照 `runIdScoped` 的兜底风格,这里 id 是数字)。
- `startServer` 构造 `MemoryService` 注入 requestHandler deps(类似 SessionService)。失败不崩 daemon(同 sessionErr 降级:记忆面板报错,不影响聊天)。

### 3.3 protocol
`@zuse/protocol` 加 `export interface MemoryItem { id:number; type:'user'|'project'|'insight'|'reference'; content:string; project:string; hook:string; createdAt:string; updatedAt:string }`。server 的 memory 类型 `import type` 它(单一形状,同 S2 的 SessionMeta)。

## 4. web
### 4.1 管理抽屉外壳(承载所有 M 面板)
- 顶部 Header 加一个 **⚙ 按钮**;点开右侧 **slide-over 抽屉**(`.manage-drawer`,带遮罩、Esc/点遮罩关闭)。
- 抽屉内:**小导航**(竖排:Memory / Prompts / Skills / MCP / Usage …;M1 只 Memory 可用,其余灰显"soon")+ 当前面板内容区。
- 状态:抽屉开关 + 当前激活面板,放 Shell 局部 `useState`(不进事件 reducer)。
- 移动端友好(抽屉占满宽度;触屏关闭)。

### 4.2 Memory 面板
- 顶部:**搜索框**(输入即 `GET ?q=`,防抖)+ **项目筛选**(下拉:全部 / 各 project-slug,从结果聚合)+ **新增**按钮。
- 列表:按 `type` 分组(user/project/insight/reference),每条显示 hook 优先(无则 content 截断)、project 标、相对时间、操作(编辑 ✎ / 删除 ×)。
- **新增**:小表单(type 选择 / content 文本域 / hook 可选 / project 可选默认全局)→ POST → 刷新。
- **编辑**:行内或弹出表单改 type/content/hook → PATCH → 刷新。
- **删除**:内联确认(沿用 S2 Sidebar 的确认模式)→ DELETE → 刷新。
- 数据层:新增 `state/manageApi.ts`(或扩 session.ts 的 `request` 包装器),`listMemory/createMemory/updateMemory/deleteMemory`(同 `credentials:same-origin` + 非 ok 抛)。复用 S2 已抽的 `request()` helper(若导出)。

## 5. 边角 / 鲁棒性
- 记忆 DB 缺失:`openMemoryStore` 会建库,空库 list 返回 []。
- 与 agent 并发写:SessionManager 自动巩固也写同库;sqlite 多连接 OK;面板操作后手动刷新(无需实时推送——M1 不做 subscribe;§5.1 的 subscribe 是可选项,留后续)。
- project 作用域:全局(`''`)记忆在所有 project 视图都出现(store.list 的既有语义);面板"全部"用 `all()`。
- 非法输入:type 不在四类 → 400;content 空 → 400;id 非数字 → 400;未知 id PATCH → 404。
- 删除/编辑 agent 正在引用的记忆:允许(管理面板的职责);id 不复用(AUTOINCREMENT),无悬空引用复活问题。

## 6. 测试
- **tools**:`update` 单测(改字段、updatedAt、FTS 同步、未知 id→null)。
- **server**:`MemoryService`(临时 db:create→list→update→search 命中新内容→delete→list 不见);HTTP 集成(端口0 + 临时 db + cookie):POST→GET 含;PATCH→GET 改;DELETE→GET 不含;未登录 401;坏 type/空 content 400;未知 id PATCH 404、非数字 id 400。
- **web**:manageApi(mock fetch 断言方法/URL/body);Memory 面板(props 注入纯组件:渲染分组、搜索触发、新增/编辑/删除回调、确认删除);抽屉开关 + ⚙ 入口。
- 不打真实模型/网络;临时 db 隔离,绝不碰真实 `~/.zuse/memory.db`。

## 7. 完成判据
浏览器:点 ⚙ → 抽屉滑出 → Memory 面板列出现有记忆 → 搜索能筛 → 新增一条出现在列表 → 编辑改内容生效(刷新/重开仍在)→ 删除消失。`@zuse/server`+`@zuse/web`+`@zuse/tools` 测试全绿、typecheck 干净、零 tui 依赖。抽屉外壳为 M2–M7 留好插槽。

## 8. follow-up(非本期)
- §5.1 的 `subscribe` 实时推送(记忆变更广播给打开的面板);M1 用手动刷新。
- M2–M7 各面板(插进抽屉导航)。
- 记忆"按会话/来源"溯源、批量操作。
