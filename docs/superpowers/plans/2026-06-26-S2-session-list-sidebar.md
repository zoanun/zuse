# S2 实现计划 — 会话列表侧边栏

> spec：[`2026-06-26-S2-session-list-sidebar-design.md`](../specs/2026-06-26-S2-session-list-sidebar-design.md)
> 执行：subagent 驱动，**两阶段**（后端 / 前端），阶段边界停下做 spec-合规 + 代码质量两段 review。

---

## 阶段 A — 后端（server + protocol）

### A1. protocol 暴露 `SessionMeta`
- `packages/protocol/src/index.ts`：加 `export interface SessionMeta { id; title; createdAt; updatedAt; cwd; messageCount }`（字段同 server `sessionStore.ts` 现有 `SessionMeta`）。
- `packages/server/src/session/sessionStore.ts`：`SessionMeta` 改为 `import type { SessionMeta } from '@zuse/protocol'` 并 `export type { SessionMeta }`（保持现有导出点不破坏 import 方），删本地重复定义。确认 `listSessions` 返回值类型仍匹配。
- `SessionRecord += titleManual?: boolean`。
- **测**：现有 sessionStore 测全过；加 `titleManual` save→load 往返断言。

### A2. SessionService：unsub + tombstone + rename + manualTitles
- 加字段 `unsubs: Map<string,()=>void>`、`tombstones: Set<string>`、`manualTitles: Map<string,string>`。
- `wireAutosave`：存 `this.unsubs.set(id, mgr.subscribe(...))`（当前返回值被丢）。
- `getOrLoad` / `create` / `adopt`：注册时 `tombstones.delete(id)`；`getOrLoad` 恢复后 `if (rec.titleManual) manualTitles.set(id, rec.title)`。
- `delete(id)`：`unsubs.get(id)?.()` → `unsubs.delete(id)` → `registry.remove(id)` → `tombstones.add(id)` → `persistAgain.delete(id)` → `manualTitles.delete(id)` → `await deleteSession(...)`。
- `persist`：开头 `if (this.tombstones.has(id)) return`；标题 = `forcedTitle ?? this.manualTitles.get(id) ?? deriveTitle(...)`；记录写 `titleManual: this.manualTitles.has(id)`。
- 新 `async rename(id, title)`：`manualTitles.set(id, title)`；live → `await persist(id, live)`；else `loadSession` → 有则 `{...rec, title, titleManual:true, updatedAt:new Date().toISOString()}` → `saveSession`。
- **测**：rename(live) 后 turn-end 不被覆盖；rename(盘上) 直接改盘；delete 不复活（含 tombstone 挡 in-flight 尾随 persist）；getOrLoad 恢复 titleManual。

### A3. HTTP：PATCH + 畸形 id 400
- `http/server.ts`：
  - 新 `PATCH /api/sessions/<id>`（鉴权）：读 body `{title}`，非串/空串 → 400；否则 `service.rename(id, title)` → `{ok:true}`。
  - DELETE 与 PATCH 里调 `service.delete/rename(id)` 包 try/catch → `safeId` 抛错回 `400 {error:{code:'bad_request',message:'invalid session id'}}`。（GET/POST 不涉 id，不需。）
- **测**：PATCH 改名→GET 见新 title；未登录 401；缺/空 title 400；DELETE、PATCH 畸形 id（`%2e%2e%2ffoo` 之类）→ 400 且进程不挂。

### A4. wsServer：畸形 id error 帧
- `ws/wsServer.ts`：async IIFE 里 `getOrLoad` 包 try/catch；catch → `sendJson(ws, {type:'error', message:'invalid session id'})`，不 wireSocket。
- **测**：`?session=<畸形>` 连上收 error 帧、不挂起；正常 id 仍 snapshot。

### 阶段 A 验收
`pnpm -C packages/server build` + server vitest 全绿 + protocol/server typecheck 干净 + 零 tui import。**停下 review**。

---

## 阶段 B — 前端（web）

### B1. `state/session.ts`：list/delete/rename
- `listSessions(): Promise<SessionMeta[]>`（GET，credentials same-origin，非 ok 抛）。
- `deleteSession(id)`（DELETE `/api/sessions/<encodeURIComponent(id)>`）。
- `renameSession(id, title)`（PATCH，body `{title}`）。
- `import type { SessionMeta } from '@zuse/protocol'`。
- **测**：mock fetch 断言方法/URL/body。

### B2. `state/store.tsx`
- `useState<SessionMeta[]>` sessions、`useState<string>` currentSessionId（初值 getSessionId）。
- `refreshSessions()`（listSessions→setSessions，吞错）。bootstrap 末尾、create/switch/delete/rename 后、收到 `turn-end` 事件后调用。
  - turn-end 钩子：在 onMessage 分派里探测 `m.type==='event' && m.event.type==='turn-end'` → refreshSessions（或在 reducer 旁加副作用；取 onMessage 里探测最简）。
- `switchSession(id)`：同 id no-op；否则 setSessionId→reconnect(wsUrl(id))→dispatch reset→setCurrentSessionId→refreshSessions。
- `removeSession(id)`：deleteSession→若 id===current：从最新 sessions 选下一个 switchSession，空则 newSession→refreshSessions。
- `rename(id,title)`：renameSession→refreshSessions。
- `newSession()`：末尾 setCurrentSessionId(newId)+refreshSessions。
- Context 暴露 `sessions/currentSessionId/switchSession/removeSession/rename/refreshSessions`。
- **测**：switchSession 重连+reset；removeSession 删当前→切下一个 / 空→新建；refreshSessions 填充（mock session.ts + ws client）。

### B3. `components/Sidebar.tsx`
- 接收/消费 `sessions/currentSessionId/onSwitch/onDelete/onRename/onNewChat`。
- 列表项：title（空→'New chat'）、active 高亮、点选 onSwitch。
- 删除按钮（×，常驻或 0.5 不透明、触屏友好）→ 内联确认 → onDelete。
- 重命名：双击 title → input（回车/失焦提交、Esc 取消、空串不提交）→ onRename。
- 删占位文案；保留顶部 New chat。
- **测**：渲染列表、active 高亮、点选/删除/改名回调（props 注入纯组件测）。

### B4. `styles.css`
- `.session-list/.session-item(.active)/.session-del/.session-rename-input`，暗色风格。

### 阶段 B 验收
`pnpm -C packages/web build` + web vitest 全绿 + web typecheck 干净 + 零 web→core/server/tui（仅 import type protocol）。**停下 review**。

---

## 全量收尾
- 根 `pnpm vitest run`（容忍既有 bash/anthropic-live 环境性失败）。
- 更新 README（若需）+ 跨会话记忆 `web_ui_program_progress.md`（S2 完成 + follow-up ①③ 闭合）。
- 浏览器完成判据见 spec §7（用户自测）。
