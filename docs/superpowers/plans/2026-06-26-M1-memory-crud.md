# M1 实现计划 — Memory CRUD + 管理抽屉

> spec：[`2026-06-26-M1-memory-crud-design.md`](../specs/2026-06-26-M1-memory-crud-design.md)
> 执行：subagent 驱动,两阶段(后端 / 前端),阶段边界停下做 spec-合规 + 代码质量 review。

## 阶段 A — 引擎 + 后端 + 协议
### A1. `@zuse/tools` memory-store
- `MemoryStore` 接口加 `update(id, {type?, content?, hook?, project?}): MemoryRow | null`。
- 实现:动态拼 `UPDATE memories SET <字段...>, updated_at=? WHERE id=?`;`changes===0`→null;否则 `SELECT * WHERE id=?` 查回 → `toRow`。
- 测:`memory-store.test.ts` 加 update（改 content/type/hook、updatedAt 变、search 命中新内容/不命中旧、未知 id→null）。

### A2. protocol
- `@zuse/protocol` 加 `MemoryItem`（id/type/content/project/hook/createdAt/updatedAt）。

### A3. server `MemoryService`(`packages/server/src/memory/MemoryService.ts`)
- 惰性持有 `openMemoryStore(dbPath?)`(opts 注入 dbPath 供测)。
- `list({project?,q?,limit?})` / `create({type,content,project?,hook?})` / `update(id,fields)` / `remove(id)` / `close()`。见 spec §3.1。
- 测:临时 db(`ZUSE_MEMORY_DB` 或注入路径)create→list→update→search→delete。

### A4. HTTP `/api/memory`(`http/server.ts`)
- GET/POST `/api/memory` + PATCH/DELETE `/api/memory/<id>`,全 `isAuthed`;校验(type/content/id)→ 400/404;形态见 spec §3.2。
- `startServer` 构造并注入 `MemoryService`(降级不崩,同 sessionErr 思路);`makeRequestHandler` deps 加 `memory`。
- 测:`server.test.ts` 加 memory 路由集成(临时 db + cookie)。

### 阶段 A 验收
server+tools+protocol typecheck 干净、相关 vitest 绿、零 tui import。**停下 review**。

## 阶段 B — 前端
### B1. `state/manageApi.ts`
- `listMemory(params)/createMemory(body)/updateMemory(id,body)/deleteMemory(id)`;复用 `request()`(从 session.ts **导出**它,或在此重写同款)。`import type { MemoryItem }`。

### B2. 管理抽屉外壳
- Header 加 ⚙ 按钮(`onOpenManage`)。
- 新组件 `components/ManageDrawer.tsx`:右侧 slide-over + 遮罩 + Esc/点遮罩关;竖排导航(Memory 可用,其余灰显 soon);渲染当前面板。
- Shell:`useState` 管 drawerOpen + activePanel;接线 ⚙→开、传给 ManageDrawer。
- styles：`.manage-drawer`/`.manage-nav`/遮罩(沿用暗色主题 + 触屏友好)。

### B3. `components/MemoryPanel.tsx`
- 搜索框(防抖→listMemory({q}))+ project 筛选 + 新增按钮;列表按 type 分组、每条 hook/截断+project+相对时间+编辑/删除;新增/编辑表单(type/content/hook/project);删除内联确认(沿用 Sidebar 模式)。
- 纯组件 + props 注入(数据/回调由 Shell 或一个小 hook 提供),便于单测。
- 测:`MemoryPanel.test.tsx`(渲染/搜索/增改删回调/确认删除)、`manageApi.test.ts`(mock fetch)、ManageDrawer 开关。

### 阶段 B 验收
web typecheck 干净、vitest 绿、build 成功、零 web→core/server/tui(仅 import type protocol)。**停下 review**。

## 收尾
根 vitest(容忍既有 bash/anthropic-live/workflow.test 环境性失败);`pnpm -C packages/web build`;更新跨会话记忆。浏览器完成判据见 spec §7。
