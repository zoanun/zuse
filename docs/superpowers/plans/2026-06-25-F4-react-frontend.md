# F4：React 前端(packages/web)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `packages/web`——一个 Vite + React SPA,通过 WS 连后端,达到当前 dev 页功能对等(聊天流 / Markdown / 主题 / 侧栏抽屉 / 按钮权限 / 任务面板 / ctx 已用·窗口·百分比),并由 node 服务器托管打包产物。

**Architecture:** 浏览器 SPA 只 type-only 依赖 `@zuse/protocol`,绝不 value-import core/server/tui。WS 客户端把 `ServerMessage` 喂给一个**纯函数 reducer** 归约成 `AppState`,React 组件订阅渲染;上行发 `ClientMessage`。node 服务器新增静态托管 + SPA fallback(无打包产物时回退现有 dev 页)。

**Tech Stack:** Vite、React 19.2、TypeScript、react-markdown + remark-gfm + rehype-highlight、Vitest + React Testing Library(jsdom)。设计见 `docs/superpowers/specs/2026-06-25-F4-react-frontend-design.md`。**server 包名是 `@zouyj/zuse-server`**(不是 @zuse/server)。

---

## 文件结构

| 文件 | 职责 | 动作 |
|------|------|------|
| `packages/protocol/src/index.ts` | 给 `SessionSnapshot` + `context-update` 加 `contextWindow` | 改 |
| `packages/server/src/session/SessionManager.ts` | getState + 3 处 context-update 带上窗口 | 改 |
| `packages/server/src/session/SessionManager.test.ts` | 断言 contextWindow | 改 |
| `packages/server/src/http/devPage.ts` | fallback 页同步显示 ctx/窗口/百分比 | 改 |
| `vitest.config.ts`(根) | 排除 `packages/web`(web 用自己的 vitest) | 改 |
| `packages/web/package.json` / `tsconfig.json` / `vite.config.ts` / `index.html` | 新包骨架 + 构建 | 新建 |
| `packages/web/src/main.tsx` / `App.tsx` / `styles.css` | 入口 + 外壳 + 样式 | 新建 |
| `packages/web/src/test-setup.ts` | jest-dom 注册 | 新建 |
| `packages/web/src/state/types.ts` / `reducer.ts` / `reducer.test.ts` | 模型 + 纯函数归约 + 测试 | 新建 |
| `packages/web/src/ws/client.ts` / `client.test.ts` | WS 客户端 + 测试 | 新建 |
| `packages/web/src/state/store.tsx` / `theme.ts` | Context+useReducer+WS 接线 + 主题 | 新建 |
| `packages/web/src/components/*.tsx` | Shell/Sidebar/Header/MessageList/Message/Markdown/ToolCall/PermissionCard/TodosPanel/Composer/AuthGate | 新建 |
| `packages/server/src/http/server.ts` / `config.ts` / `startServer.ts` | 静态托管 + SPA fallback + webDir | 改 |
| `packages/server/src/http/static.test.ts` | 静态路由测试 | 新建 |

---

## Task 1: 协议加 contextWindow + SessionManager 接线 + dev 页同步

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/server/src/session/SessionManager.ts`
- Modify: `packages/server/src/session/SessionManager.test.ts`
- Modify: `packages/server/src/http/devPage.ts`

- [ ] **Step 1: protocol — 加字段**

在 `packages/protocol/src/index.ts` 把 `context-update` 成员改为:
```ts
  | { type: 'context-update'; contextTokens: number | undefined; contextWindow: number | undefined }
```
在 `SessionSnapshot` 接口的 `contextTokens: number | undefined` 下一行加:
```ts
  contextWindow: number | undefined
```

- [ ] **Step 2: SessionManager — 加 ctxWindow() 并在 4 处带上**

在 `packages/server/src/session/SessionManager.ts` 的 `getState()` 方法上方加一个私有方法:
```ts
  /** 当前模型的上下文窗口大小(token);供前端算 ctx 占用百分比。 */
  private ctxWindow(): number {
    return resolveContextWindow(this.settings, this.currentProviderId, this.client.getModel())
  }
```
`getState()` 的返回对象里,在 `contextTokens: this.contextTokens,` 之后加一行:
```ts
      contextWindow: this.ctxWindow(),
```
把三处 `this.emit({ type: 'context-update', contextTokens: ... })` 改为带 `contextWindow`:
- 约 line 319:`this.emit({ type: 'context-update', contextTokens: undefined })` → `this.emit({ type: 'context-update', contextTokens: undefined, contextWindow: this.ctxWindow() })`
- 约 line 481:`this.emit({ type: 'context-update', contextTokens: this.contextTokens })` → `this.emit({ type: 'context-update', contextTokens: this.contextTokens, contextWindow: this.ctxWindow() })`
- 约 line 600:`this.emit({ type: 'context-update', contextTokens: undefined })` → `this.emit({ type: 'context-update', contextTokens: undefined, contextWindow: this.ctxWindow() })`

(用 `git grep -n "type: 'context-update'" packages/server/src/session/SessionManager.ts` 找全这三处。)

- [ ] **Step 3: SessionManager.test.ts — 断言窗口出现在快照**

在 `packages/server/src/session/SessionManager.test.ts` 末尾(最后一个 `})` 之前)追加一个测试。先确认文件顶部已有 `makeManagerWith` 辅助(本任务用它):
```ts
describe('context window in snapshot', () => {
  it('getState includes a positive contextWindow', () => {
    const { mgr } = makeManagerWith([])
    const snap = mgr.getState()
    expect(typeof snap.contextWindow).toBe('number')
    expect((snap.contextWindow ?? 0)).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 4: 跑 server 测试**

Run: `pnpm vitest run packages/server`
Expected: PASS（既有 76 + 新增 1；现有的 `'context-update'` 序列断言只比对 `e.type`,不看字段,故不破）

- [ ] **Step 5: dev 页 fallback 同步显示窗口 + 百分比**

在 `packages/server/src/http/devPage.ts`:
(a) 把 `setCtx` 函数体替换为:
```js
  function setCtx() {
    var c = el('chip-ctx'); var parts = [];
    if (lastCtx !== null && lastCtx !== undefined) {
      var s = 'ctx ' + fmt(lastCtx);
      if (lastWindow) s += ' / ' + fmt(lastWindow) + ' · ' + Math.round((lastCtx / lastWindow) * 100) + '%';
      parts.push(s);
    }
    if (lastUsage) parts.push('tok ' + fmt((lastUsage.input_tokens || 0) + (lastUsage.output_tokens || 0)));
    if (parts.length) { c.hidden = false; c.textContent = parts.join(' · '); }
  }
```
(b) 在 `var lastCtx, lastUsage;` 那行改为 `var lastCtx, lastUsage, lastWindow;`
(c) snapshot 处理里 `lastCtx = s.contextTokens;` 之后加 `lastWindow = s.contextWindow;`
(d) `case 'context-update':` 改为 `case 'context-update': lastCtx = e.contextTokens; lastWindow = e.contextWindow; setCtx(); break;`

- [ ] **Step 6: dev 页测试 + 提交**

Run: `pnpm vitest run packages/server/src/http/devPage.test.ts`
Expected: PASS
```bash
git add packages/protocol/src/index.ts packages/server/src/session/SessionManager.ts packages/server/src/session/SessionManager.test.ts packages/server/src/http/devPage.ts
git commit -m "feat(protocol): add contextWindow to snapshot + context-update"
```
End commit body with trailer (own line):
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

---

## Task 2: 搭 `packages/web` 骨架(Vite + React + 构建跑通)

**Files:**
- Create: `packages/web/package.json`, `packages/web/tsconfig.json`, `packages/web/tsconfig.node.json`, `packages/web/vite.config.ts`, `packages/web/index.html`, `packages/web/src/main.tsx`, `packages/web/src/App.tsx`, `packages/web/src/styles.css`, `packages/web/src/test-setup.ts`, `packages/web/src/smoke.test.tsx`
- Modify: `vitest.config.ts`(根)

- [ ] **Step 1: package.json**
```json
{
  "name": "@zuse/web",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "react-markdown": "^9.0.1",
    "remark-gfm": "^4.0.0",
    "rehype-highlight": "^7.0.1"
  },
  "devDependencies": {
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^4.3.4",
    "@testing-library/react": "^16.1.0",
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/user-event": "^14.5.2",
    "jsdom": "^25.0.1",
    "vite": "^5.4.11",
    "vitest": "^2.1.8",
    "@zuse/protocol": "workspace:*"
  }
}
```

- [ ] **Step 2: tsconfig.json + tsconfig.node.json**

`packages/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vitest/globals", "@testing-library/jest-dom"],
    "noEmit": true
  },
  "include": ["src"]
}
```
`packages/web/tsconfig.node.json`(给 vite.config 用,避免 DOM 类型混入):
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"], "noEmit": true },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 3: vite.config.ts(proxy + vitest jsdom)**
```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:4180', ws: true },
      '/api': 'http://127.0.0.1:4180',
      '/healthz': 'http://127.0.0.1:4180',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
```

- [ ] **Step 4: index.html(含主题预设,防闪烁)**
```html
<!doctype html>
<html lang="en" data-theme="light">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>zuse</title>
    <script>
      (function () {
        try {
          var t = localStorage.getItem('zuse-theme');
          document.documentElement.setAttribute('data-theme', t === 'dark' ? 'dark' : 'light');
        } catch (e) {}
      })();
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: src/test-setup.ts**
```ts
import '@testing-library/jest-dom'
```

- [ ] **Step 6: src/styles.css(占位,Task 8 填全)**
```css
:root { --sans: -apple-system, "Segoe UI", system-ui, sans-serif; }
body { font-family: var(--sans); margin: 0; }
```

- [ ] **Step 7: src/App.tsx(占位)**
```tsx
export function App() {
  return <div className="app-placeholder">zuse web — scaffold</div>
}
```

- [ ] **Step 8: src/main.tsx**
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles.css'

const root = document.getElementById('root')
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>)
```

- [ ] **Step 9: src/smoke.test.tsx**
```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { App } from './App.js'

describe('App scaffold', () => {
  it('renders', () => {
    render(<App />)
    expect(screen.getByText(/zuse web/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 10: 根 vitest 排除 web**

把 `vitest.config.ts`(根)的 `test` 块改为(加 `exclude`):
```ts
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'packages/web/**'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts', '**/index.ts'],
    },
    env: { FORCE_COLOR: '1' },
  },
```

- [ ] **Step 11: 安装 + 构建 + 测试 + typecheck**

Run: `pnpm install`
Run: `pnpm -F @zuse/web test`
Expected: smoke 测试 PASS（jsdom 渲染 App）
Run: `pnpm -F @zuse/web build`
Expected: 产出 `packages/web/dist/index.html` + assets,构建成功
Run: `pnpm -F @zuse/web typecheck`
Expected: 干净

- [ ] **Step 12: Commit**
```bash
git add packages/web vitest.config.ts pnpm-lock.yaml
git commit -m "feat(web): scaffold Vite + React SPA package (@zuse/web)"
```
trailer 同上。

---

## Task 3: 状态模型 + 纯函数 reducer + 测试

**Files:**
- Create: `packages/web/src/state/types.ts`
- Create: `packages/web/src/state/reducer.ts`
- Test: `packages/web/src/state/reducer.test.ts`

- [ ] **Step 1: types.ts**
```ts
import type { TodoItemLite, PendingPermissionLite, Usage } from '@zuse/protocol'

export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'tool-use'; id: string; name: string; input: unknown }
  | { kind: 'tool-result'; id: string; output: string; isError: boolean }

export interface Message { id: string; role: 'user' | 'assistant'; parts: Part[] }
export interface Notice { id: string; text: string; kind: 'info' | 'warn' | 'error' }
export type Connection = 'connecting' | 'live' | 'down'

export interface AppState {
  messages: Message[]
  todos: TodoItemLite[]
  pendingPermissions: PendingPermissionLite[]
  model?: string
  contextTokens?: number
  contextWindow?: number
  totalUsage?: Usage
  thinking: boolean
  connection: Connection
  notices: Notice[]
}
```

- [ ] **Step 2(TDD): reducer.test.ts**
```ts
import { describe, it, expect } from 'vitest'
import type { ServerMessage } from '@zuse/protocol'
import { reduce, initialState } from './reducer.js'
import type { AppState } from './types.js'

const ev = (event: unknown): ServerMessage => ({ type: 'event', event } as ServerMessage)
function run(actions: Array<Parameters<typeof reduce>[1]>, start: AppState = initialState): AppState {
  return actions.reduce((s, a) => reduce(s, a), start)
}

describe('reduce', () => {
  it('user-send pushes a user message', () => {
    const s = reduce(initialState, { kind: 'user-send', id: 'u1', text: 'hi' })
    expect(s.messages).toEqual([{ id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'hi' }] }])
  })

  it('accumulates text-delta into one assistant message', () => {
    const s = run([
      { kind: 'server', msg: ev({ type: 'turn-start', isResend: false }) },
      { kind: 'server', msg: ev({ type: 'message-start', id: 'm1', model: 'x' }) },
      { kind: 'server', msg: ev({ type: 'text-delta', text: 'Hel' }) },
      { kind: 'server', msg: ev({ type: 'text-delta', text: 'lo' }) },
      { kind: 'server', msg: ev({ type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }) },
      { kind: 'server', msg: ev({ type: 'turn-end' }) },
    ])
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]).toEqual({ id: 'm1', role: 'assistant', parts: [{ kind: 'text', text: 'Hello' }] })
    expect(s.thinking).toBe(false)
  })

  it('adds tool-use and tool-result parts to the assistant message', () => {
    const s = run([
      { kind: 'server', msg: ev({ type: 'message-start', id: 'm1', model: 'x' }) },
      { kind: 'server', msg: ev({ type: 'tool-use', id: 't1', name: 'Bash', input: { command: 'ls' } }) },
      { kind: 'server', msg: ev({ type: 'tool-result', id: 't1', name: 'Bash', output: 'files', is_error: false }) },
    ])
    expect(s.messages[0]!.parts).toEqual([
      { kind: 'tool-use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { kind: 'tool-result', id: 't1', output: 'files', isError: false },
    ])
  })

  it('tracks ctx/window/usage and todos and permissions', () => {
    const s = run([
      { kind: 'server', msg: ev({ type: 'context-update', contextTokens: 4700, contextWindow: 200000 }) },
      { kind: 'server', msg: ev({ type: 'usage-update', totalUsage: { input_tokens: 100, output_tokens: 91 } }) },
      { kind: 'server', msg: ev({ type: 'todos-update', todos: [{ content: 'a', status: 'in_progress' }] }) },
      { kind: 'server', msg: ev({ type: 'permission-request', id: 'p1', req: { toolName: 'Bash', specifier: 'rm' } as never }) },
    ])
    expect(s.contextTokens).toBe(4700)
    expect(s.contextWindow).toBe(200000)
    expect(s.totalUsage).toEqual({ input_tokens: 100, output_tokens: 91 })
    expect(s.todos).toHaveLength(1)
    expect(s.pendingPermissions).toHaveLength(1)
    const s2 = reduce(s, { kind: 'server', msg: ev({ type: 'permission-resolved', id: 'p1', verdict: 'allow' }) })
    expect(s2.pendingPermissions).toHaveLength(0)
  })

  it('snapshot initialises stats and keeps messages', () => {
    const withMsg = reduce(initialState, { kind: 'user-send', id: 'u1', text: 'hi' })
    const s = reduce(withMsg, { kind: 'server', msg: { type: 'snapshot', snapshot: {
      sessionId: 'default', isThinking: false, model: 'claude', cwd: '/x',
      totalUsage: undefined, contextTokens: 10, contextWindow: 1000, todos: [], pendingPermissions: [], messageCount: 0,
    } } })
    expect(s.model).toBe('claude')
    expect(s.contextWindow).toBe(1000)
    expect(s.messages).toHaveLength(1)
  })

  it('routes failover/warning/error to notices', () => {
    const s = run([
      { kind: 'server', msg: ev({ type: 'warning', message: 'careful' }) },
      { kind: 'server', msg: { type: 'error', message: 'boom' } },
    ])
    expect(s.notices.map((n) => n.kind)).toEqual(['warn', 'error'])
  })

  it('connection action updates connection', () => {
    expect(reduce(initialState, { kind: 'connection', status: 'live' }).connection).toBe('live')
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm -F @zuse/web test src/state/reducer.test.ts`
Expected: FAIL（`reducer.js` 不存在）

- [ ] **Step 4: reducer.ts**
```ts
import type { ServerMessage, SessionEvent, SessionSnapshot } from '@zuse/protocol'
import type { AppState, Connection, Message, Notice, Part } from './types.js'

export const initialState: AppState = {
  messages: [], todos: [], pendingPermissions: [],
  thinking: false, connection: 'connecting', notices: [],
}

export type Action =
  | { kind: 'server'; msg: ServerMessage }
  | { kind: 'user-send'; id: string; text: string }
  | { kind: 'connection'; status: Connection }
  | { kind: 'reset' }

function withNotice(state: AppState, text: string, kind: Notice['kind']): AppState {
  return { ...state, notices: [...state.notices, { id: 'n' + state.notices.length, text, kind }] }
}

/** Append a part to the current (last) assistant message, creating one if needed. */
function appendPart(state: AppState, part: Part): AppState {
  const msgs = state.messages.slice()
  const last = msgs[msgs.length - 1]
  if (last && last.role === 'assistant') {
    msgs[msgs.length - 1] = { ...last, parts: [...last.parts, part] }
  } else {
    msgs.push({ id: 'a' + msgs.length, role: 'assistant', parts: [part] })
  }
  return { ...state, messages: msgs }
}

function appendText(state: AppState, text: string): AppState {
  const msgs = state.messages.slice()
  const last = msgs[msgs.length - 1]
  if (last && last.role === 'assistant') {
    const parts = last.parts.slice()
    const lp = parts[parts.length - 1]
    if (lp && lp.kind === 'text') parts[parts.length - 1] = { kind: 'text', text: lp.text + text }
    else parts.push({ kind: 'text', text })
    msgs[msgs.length - 1] = { ...last, parts }
    return { ...state, messages: msgs }
  }
  return appendPart(state, { kind: 'text', text })
}

function applySnapshot(state: AppState, s: SessionSnapshot): AppState {
  return {
    ...state,
    model: s.model,
    contextTokens: s.contextTokens,
    contextWindow: s.contextWindow,
    totalUsage: s.totalUsage,
    todos: s.todos,
    pendingPermissions: s.pendingPermissions,
    thinking: s.isThinking,
  }
}

function reduceEvent(state: AppState, e: SessionEvent): AppState {
  switch (e.type) {
    case 'message-start': return { ...state, messages: [...state.messages, { id: e.id, role: 'assistant', parts: [] }] }
    case 'text-delta': return appendText(state, e.text)
    case 'tool-use': return appendPart(state, { kind: 'tool-use', id: e.id, name: e.name, input: e.input })
    case 'tool-result': return appendPart(state, { kind: 'tool-result', id: e.id, output: e.output, isError: e.is_error })
    case 'message-stop': return state
    case 'turn-start': return { ...state, thinking: true }
    case 'turn-end': return { ...state, thinking: false }
    case 'usage-update': return { ...state, totalUsage: e.totalUsage }
    case 'context-update': return { ...state, contextTokens: e.contextTokens, contextWindow: e.contextWindow }
    case 'todos-update': return { ...state, todos: e.todos }
    case 'permission-request': return { ...state, pendingPermissions: [...state.pendingPermissions, { id: e.id, req: e.req }] }
    case 'permission-resolved': return { ...state, pendingPermissions: state.pendingPermissions.filter((p) => p.id !== e.id) }
    case 'failover': return withNotice({ ...state, model: e.toModel }, 'failover: ' + e.fromModel + ' → ' + e.toModel + ' (' + e.reason + ')', 'warn')
    case 'model-select-needed': return withNotice(state, 'model selection needed: ' + e.reason, 'warn')
    case 'compaction-start': return withNotice(state, 'compacting context…', 'info')
    case 'compaction-done': return withNotice(state, 'context compacted', 'info')
    case 'memory-notice': return withNotice(state, e.text, 'info')
    case 'cwd-change': return withNotice(state, 'cwd → ' + e.cwd, 'info')
    case 'warning': return withNotice(state, e.message, 'warn')
    case 'error': return withNotice(state, e.message, 'error')
    case 'aborted': return withNotice({ ...state, thinking: false }, 'stopped', 'warn')
    default: return state
  }
}

export function reduce(state: AppState, action: Action): AppState {
  switch (action.kind) {
    case 'user-send':
      return { ...state, messages: [...state.messages, { id: action.id, role: 'user', parts: [{ kind: 'text', text: action.text }] }] }
    case 'connection':
      return { ...state, connection: action.status }
    case 'reset':
      return { ...initialState, connection: state.connection }
    case 'server': {
      const m = action.msg
      if (m.type === 'snapshot') return applySnapshot(state, m.snapshot)
      if (m.type === 'error') return withNotice(state, m.message, 'error')
      if (m.type === 'event') return reduceEvent(state, m.event)
      return state
    }
    default:
      return state
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm -F @zuse/web test src/state/reducer.test.ts`
Expected: 7 用例 PASS

- [ ] **Step 6: Commit**
```bash
git add packages/web/src/state/types.ts packages/web/src/state/reducer.ts packages/web/src/state/reducer.test.ts
git commit -m "feat(web): state model + pure reducer over SessionEvents"
```
trailer 同上。

---

## Task 4: WS 客户端 + 测试

**Files:**
- Create: `packages/web/src/ws/client.ts`
- Test: `packages/web/src/ws/client.test.ts`

- [ ] **Step 1(TDD): client.test.ts**
```ts
import { describe, it, expect, vi } from 'vitest'
import type { ServerMessage } from '@zuse/protocol'
import { createWsClient } from './client.js'

// Minimal fake WebSocket capturing sends and exposing event triggers.
class FakeWS {
  static OPEN = 1
  readyState = 1
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) {}
  send(s: string) { this.sent.push(s) }
  close() { this.readyState = 3; this.onclose?.() }
}

describe('createWsClient', () => {
  it('parses incoming frames and forwards to onMessage', () => {
    const got: ServerMessage[] = []
    let ws!: FakeWS
    const client = createWsClient({
      url: 'ws://x/ws',
      onMessage: (m) => got.push(m),
      onStatus: () => {},
      makeSocket: (u) => { ws = new FakeWS(u); return ws as unknown as WebSocket },
    })
    client.connect()
    ws.onopen!()
    ws.onmessage!({ data: JSON.stringify({ type: 'snapshot', snapshot: { sessionId: 'd', isThinking: false, model: 'm', cwd: '/', totalUsage: undefined, contextTokens: 1, contextWindow: 2, todos: [], pendingPermissions: [], messageCount: 0 } }) })
    expect(got).toHaveLength(1)
    expect(got[0]!.type).toBe('snapshot')
  })

  it('ignores malformed frames without throwing', () => {
    let ws!: FakeWS
    const client = createWsClient({ url: 'ws://x/ws', onMessage: () => { throw new Error('should not be called') }, onStatus: () => {}, makeSocket: (u) => { ws = new FakeWS(u); return ws as unknown as WebSocket } })
    client.connect(); ws.onopen!()
    expect(() => ws.onmessage!({ data: 'not json' })).not.toThrow()
  })

  it('send() encodes a ClientMessage as JSON', () => {
    let ws!: FakeWS
    const client = createWsClient({ url: 'ws://x/ws', onMessage: () => {}, onStatus: () => {}, makeSocket: (u) => { ws = new FakeWS(u); return ws as unknown as WebSocket } })
    client.connect(); ws.onopen!()
    client.send({ type: 'send', text: 'hi' })
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: 'send', text: 'hi' })
  })

  it('reports status on open/close', () => {
    const statuses: string[] = []
    let ws!: FakeWS
    const client = createWsClient({ url: 'ws://x/ws', onMessage: () => {}, onStatus: (s) => statuses.push(s), makeSocket: (u) => { ws = new FakeWS(u); return ws as unknown as WebSocket }, reconnect: false })
    client.connect()
    expect(statuses).toContain('connecting')
    ws.onopen!(); expect(statuses).toContain('live')
    ws.close(); expect(statuses).toContain('down')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @zuse/web test src/ws/client.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: client.ts**
```ts
import type { ClientMessage, ServerMessage } from '@zuse/protocol'
import type { Connection } from '../state/types.js'

export interface WsClientOptions {
  url: string
  onMessage: (m: ServerMessage) => void
  onStatus: (s: Connection) => void
  /** Injectable for tests; defaults to the global WebSocket. */
  makeSocket?: (url: string) => WebSocket
  /** Auto-reconnect with backoff on close (default true). */
  reconnect?: boolean
}

export interface WsClient {
  connect(): void
  send(msg: ClientMessage): void
  close(): void
}

export function createWsClient(opts: WsClientOptions): WsClient {
  const make = opts.makeSocket ?? ((u: string) => new WebSocket(u))
  const reconnect = opts.reconnect !== false
  let ws: WebSocket | null = null
  let closed = false
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  function connect(): void {
    closed = false
    opts.onStatus('connecting')
    ws = make(opts.url)
    ws.onopen = () => { attempts = 0; opts.onStatus('live') }
    ws.onmessage = (e: MessageEvent) => {
      let msg: ServerMessage
      try { msg = JSON.parse(String((e as { data: unknown }).data)) as ServerMessage } catch { return }
      opts.onMessage(msg)
    }
    ws.onclose = () => {
      opts.onStatus('down')
      ws = null
      if (reconnect && !closed) {
        attempts++
        const delay = Math.min(1000 * attempts, 5000)
        timer = setTimeout(connect, delay)
      }
    }
    ws.onerror = () => { /* close will follow */ }
  }

  return {
    connect,
    send(msg: ClientMessage) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)) },
    close() { closed = true; if (timer) clearTimeout(timer); if (ws) ws.close() },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @zuse/web test src/ws/client.test.ts`
Expected: 4 用例 PASS

> 注:测试里的 FakeWS 用 `onopen`/`onmessage` 属性赋值,client.ts 也用属性赋值(`ws.onopen = …`),一致。`MessageEvent` 在 jsdom 下可用;测试传 `{ data }` 结构够用。

- [ ] **Step 5: Commit**
```bash
git add packages/web/src/ws/client.ts packages/web/src/ws/client.test.ts
git commit -m "feat(web): WS client with reconnect + frame parsing"
```
trailer 同上。

---

## Task 5: 主题 + store(Context + useReducer + WS 接线)

**Files:**
- Create: `packages/web/src/theme.ts`
- Create: `packages/web/src/state/store.tsx`
- Test: `packages/web/src/theme.test.ts`

- [ ] **Step 1(TDD): theme.test.ts**
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { getTheme, toggleTheme } from './theme.js'

beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute('data-theme') })

describe('theme', () => {
  it('defaults to light', () => { expect(getTheme()).toBe('light') })
  it('toggles and persists + sets attribute', () => {
    const next = toggleTheme()
    expect(next).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem('zuse-theme')).toBe('dark')
    expect(toggleTheme()).toBe('light')
  })
})
```

- [ ] **Step 2: 跑确认失败**

Run: `pnpm -F @zuse/web test src/theme.test.ts`
Expected: FAIL

- [ ] **Step 3: theme.ts**
```ts
export type Theme = 'light' | 'dark'

export function getTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

export function setTheme(t: Theme): void {
  document.documentElement.setAttribute('data-theme', t)
  try { localStorage.setItem('zuse-theme', t) } catch { /* ignore */ }
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'light' ? 'dark' : 'light'
  setTheme(next)
  return next
}
```

- [ ] **Step 4: 跑确认通过**

Run: `pnpm -F @zuse/web test src/theme.test.ts`
Expected: PASS

- [ ] **Step 5: store.tsx**
```tsx
import { createContext, useContext, useEffect, useReducer, useRef, type ReactNode } from 'react'
import type { ClientMessage } from '@zuse/protocol'
import { reduce, initialState, type Action } from './reducer.js'
import type { AppState } from './types.js'
import { createWsClient, type WsClient } from '../ws/client.js'

interface Store { state: AppState; send: (msg: ClientMessage) => void; dispatch: (a: Action) => void }
const StoreCtx = createContext<Store | null>(null)

let seq = 0
export function nextId(prefix: string): string { return prefix + '-' + (++seq) }

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initialState)
  const clientRef = useRef<WsClient | null>(null)

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const client = createWsClient({
      url: proto + '://' + location.host + '/ws',
      onMessage: (m) => dispatch({ kind: 'server', msg: m }),
      onStatus: (s) => dispatch({ kind: 'connection', status: s }),
    })
    clientRef.current = client
    client.connect()
    return () => client.close()
  }, [])

  const send = (msg: ClientMessage) => clientRef.current?.send(msg)
  return <StoreCtx.Provider value={{ state, send, dispatch }}>{children}</StoreCtx.Provider>
}

export function useStore(): Store {
  const s = useContext(StoreCtx)
  if (!s) throw new Error('useStore must be used within StoreProvider')
  return s
}
```

- [ ] **Step 6: typecheck + commit**

Run: `pnpm -F @zuse/web typecheck`
Expected: 干净
```bash
git add packages/web/src/theme.ts packages/web/src/theme.test.ts packages/web/src/state/store.tsx
git commit -m "feat(web): theme helpers + store (reducer + WS wiring)"
```
trailer 同上。

---

## Task 6: Markdown + Message/MessageList 渲染

**Files:**
- Create: `packages/web/src/components/Markdown.tsx`
- Create: `packages/web/src/components/ToolCall.tsx`
- Create: `packages/web/src/components/Message.tsx`
- Create: `packages/web/src/components/MessageList.tsx`
- Test: `packages/web/src/components/Message.test.tsx`

- [ ] **Step 1: Markdown.tsx**
```tsx
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

export function Markdown({ text }: { text: string }) {
  return (
    <div className="text">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
```

- [ ] **Step 2: ToolCall.tsx**
```tsx
import type { Part } from '../state/types.js'

export function ToolCall({ use, result }: { use: Extract<Part, { kind: 'tool-use' }>; result?: Extract<Part, { kind: 'tool-result' }> }) {
  return (
    <div className="tool">
      <div className="head">⚙ {use.name}</div>
      <div className="args">{trunc(safeJson(use.input), 200)}</div>
      {result ? <div className={'result' + (result.isError ? ' err' : '')}>{trunc(result.output, 800)}</div> : null}
    </div>
  )
}

function safeJson(o: unknown): string { try { return JSON.stringify(o) } catch { return String(o) } }
function trunc(s: string, n: number): string { return s.length > n ? s.slice(0, n) + ' … (+' + (s.length - n) + ' chars)' : s }
```

- [ ] **Step 3: Message.tsx**
```tsx
import type { Message as Msg, Part } from '../state/types.js'
import { Markdown } from './Markdown.js'
import { ToolCall } from './ToolCall.js'

export function Message({ msg }: { msg: Msg }) {
  if (msg.role === 'user') {
    const text = msg.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')
    return <div className="msg you"><div className="bubble">{text}</div></div>
  }
  return (
    <div className="msg agent">
      <div className="text-wrap">{renderParts(msg.parts)}</div>
    </div>
  )
}

function renderParts(parts: Part[]) {
  const out: React.ReactNode[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    if (p.kind === 'text') out.push(<Markdown key={i} text={p.text} />)
    else if (p.kind === 'tool-use') {
      const next = parts[i + 1]
      const result = next && next.kind === 'tool-result' && next.id === p.id ? next : undefined
      if (result) i++
      out.push(<ToolCall key={i} use={p} result={result} />)
    } else if (p.kind === 'tool-result') {
      out.push(<ToolCall key={i} use={{ kind: 'tool-use', id: p.id, name: 'tool', input: {} }} result={p} />)
    }
  }
  return out
}
```

- [ ] **Step 4: MessageList.tsx**
```tsx
import { useEffect, useRef } from 'react'
import type { Message as Msg, Notice } from '../state/types.js'
import { Message } from './Message.js'

export function MessageList({ messages, notices, thinking }: { messages: Msg[]; notices: Notice[]; thinking: boolean }) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [messages, thinking, notices])

  return (
    <div className="stream">
      {messages.length === 0 && notices.length === 0
        ? <div className="empty">Ask zuse anything to get started.</div>
        : null}
      {messages.map((m) => <Message key={m.id} msg={m} />)}
      {notices.map((n) => <div key={n.id} className={'note ' + (n.kind === 'error' ? 'bad' : n.kind === 'warn' ? 'warn' : 'live')}>{n.text}</div>)}
      {thinking ? <div className="thinking"><div className="dots"><i /><i /><i /></div></div> : null}
      <div ref={endRef} />
    </div>
  )
}
```

- [ ] **Step 5(test): Message.test.tsx**
```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Message } from './Message.js'

describe('Message', () => {
  it('renders a user bubble as plain text', () => {
    render(<Message msg={{ id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'hello there' }] }} />)
    expect(screen.getByText('hello there')).toBeInTheDocument()
  })

  it('renders assistant markdown (heading + bold)', () => {
    render(<Message msg={{ id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '## Title\n\nsome **bold** text' }] }} />)
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Title')
    expect(screen.getByText('bold').tagName.toLowerCase()).toBe('strong')
  })

  it('renders a tool call with its result', () => {
    render(<Message msg={{ id: 'a1', role: 'assistant', parts: [
      { kind: 'tool-use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { kind: 'tool-result', id: 't1', output: 'a b c', isError: false },
    ] }} />)
    expect(screen.getByText(/⚙ Bash/)).toBeInTheDocument()
    expect(screen.getByText('a b c')).toBeInTheDocument()
  })
})
```

- [ ] **Step 6: 跑测试**

Run: `pnpm -F @zuse/web test src/components/Message.test.tsx`
Expected: 3 用例 PASS（react-markdown 渲染 h2/strong；ToolCall 显示名与结果)

- [ ] **Step 7: typecheck + commit**

Run: `pnpm -F @zuse/web typecheck`
Expected: 干净
```bash
git add packages/web/src/components/Markdown.tsx packages/web/src/components/ToolCall.tsx packages/web/src/components/Message.tsx packages/web/src/components/MessageList.tsx packages/web/src/components/Message.test.tsx
git commit -m "feat(web): message rendering (markdown + tool calls)"
```
trailer 同上。

---

## Task 7: Composer + PermissionCard + TodosPanel

**Files:**
- Create: `packages/web/src/components/Composer.tsx`
- Create: `packages/web/src/components/PermissionCard.tsx`
- Create: `packages/web/src/components/TodosPanel.tsx`
- Test: `packages/web/src/components/Composer.test.tsx`, `packages/web/src/components/TodosPanel.test.tsx`

- [ ] **Step 1: Composer.tsx**
```tsx
import { useRef, useState } from 'react'

export function Composer({ disabled, onSend, onStop }: { disabled: boolean; onSend: (text: string) => void; onStop: () => void }) {
  const [value, setValue] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  function submit() {
    const v = value.trim()
    if (!v || disabled) return
    onSend(v); setValue('')
    if (taRef.current) taRef.current.style.height = 'auto'
  }
  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={taRef}
          rows={1}
          placeholder="Message zuse…"
          value={value}
          disabled={disabled}
          onChange={(e) => {
            setValue(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = Math.min(e.target.scrollHeight, 168) + 'px'
          }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
        />
        {disabled ? <button className="ghost" onClick={onStop}>Stop</button> : null}
        <button className="send-btn" aria-label="Send message" onClick={submit} disabled={disabled}>↑</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: PermissionCard.tsx**
```tsx
import type { PendingPermissionLite, PermissionVerdict } from '@zuse/protocol'

export function PermissionCard({ pending, onReply }: { pending: PendingPermissionLite; onReply: (id: string, verdict: PermissionVerdict) => void }) {
  const req = pending.req as { toolName?: string; specifier?: string }
  const spec = (req.toolName ?? 'tool') + (req.specifier ? ' · ' + req.specifier : '')
  return (
    <div className="perm">
      <div className="q">Allow this action?</div>
      <div className="spec">{spec}</div>
      <div className="actions">
        <button onClick={() => onReply(pending.id, 'allow')}>Allow</button>
        <button className="ghost" onClick={() => onReply(pending.id, 'allow_session')}>Always</button>
        <button className="ghost" onClick={() => onReply(pending.id, 'deny')}>Deny</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: TodosPanel.tsx**
```tsx
import type { TodoItemLite } from '@zuse/protocol'

export function TodosPanel({ todos }: { todos: TodoItemLite[] }) {
  if (!todos.length) return null
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div className="todos">
      <div className="th"><span>Tasks</span><span>{done} / {todos.length}</span></div>
      {todos.map((t, i) => {
        const cls = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'doing' : 'todo'
        const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '○'
        return <div key={i} className={'ti ' + cls}><span className="ic">{icon}</span><span>{t.content}</span></div>
      })}
    </div>
  )
}
```

- [ ] **Step 4(test): Composer.test.tsx**
```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Composer } from './Composer.js'

describe('Composer', () => {
  it('sends on Enter and clears', () => {
    const onSend = vi.fn()
    render(<Composer disabled={false} onSend={onSend} onStop={() => {}} />)
    const ta = screen.getByPlaceholderText('Message zuse…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'hello' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hello')
    expect(ta.value).toBe('')
  })

  it('shows Stop and fires onStop when disabled (thinking)', () => {
    const onStop = vi.fn()
    render(<Composer disabled={true} onSend={() => {}} onStop={onStop} />)
    fireEvent.click(screen.getByText('Stop'))
    expect(onStop).toHaveBeenCalled()
  })
})
```

- [ ] **Step 5(test): TodosPanel.test.tsx**
```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TodosPanel } from './TodosPanel.js'

describe('TodosPanel', () => {
  it('renders three states with a done count', () => {
    render(<TodosPanel todos={[
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ]} />)
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
    expect(screen.getByText('a')).toBeInTheDocument()
    expect(screen.getByText('b')).toBeInTheDocument()
  })
  it('renders nothing when empty', () => {
    const { container } = render(<TodosPanel todos={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
```

- [ ] **Step 6: 跑测试 + typecheck**

Run: `pnpm -F @zuse/web test src/components/Composer.test.tsx src/components/TodosPanel.test.tsx`
Expected: 4 用例 PASS
Run: `pnpm -F @zuse/web typecheck`
Expected: 干净

- [ ] **Step 7: Commit**
```bash
git add packages/web/src/components/Composer.tsx packages/web/src/components/PermissionCard.tsx packages/web/src/components/TodosPanel.tsx packages/web/src/components/Composer.test.tsx packages/web/src/components/TodosPanel.test.tsx
git commit -m "feat(web): composer, permission card, todos panel"
```
trailer 同上。

---

## Task 8: Header + Sidebar + Shell + AuthGate + App 接线 + 完整样式

**Files:**
- Create: `packages/web/src/components/Header.tsx`, `Sidebar.tsx`, `Shell.tsx`, `AuthGate.tsx`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/styles.css`(填全)
- Test: `packages/web/src/components/Header.test.tsx`

- [ ] **Step 1: Header.tsx**
```tsx
import type { AppState } from '../state/types.js'
import { getTheme, toggleTheme } from '../theme.js'
import { useState } from 'react'

function fmt(n: number | undefined): string {
  if (n === null || n === undefined) return '—'
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
}

export function Header({ state, onMenu }: { state: AppState; onMenu: () => void }) {
  const [, force] = useState(0)
  const ctx = state.contextTokens
  const win = state.contextWindow
  let ctxText = ''
  if (ctx !== undefined) {
    ctxText = 'ctx ' + fmt(ctx)
    if (win) ctxText += ' / ' + fmt(win) + ' · ' + Math.round((ctx / win) * 100) + '%'
  }
  const tok = state.totalUsage ? 'tok ' + fmt((state.totalUsage.input_tokens || 0) + (state.totalUsage.output_tokens || 0)) : ''
  const conn = state.connection
  return (
    <div className="main-header">
      <div className="mh-left">
        <button className="icon-btn menu-btn" aria-label="Open sidebar" onClick={onMenu}>☰</button>
        <div className="brand mh-brand"><span className="mark">Z</span> zuse</div>
        {state.model ? <span className="chip">model {state.model}</span> : null}
        {ctxText ? <span className="chip">{ctxText}{tok ? ' · ' + tok : ''}</span> : null}
        <span className={'chip ' + (conn === 'live' ? 'live' : conn === 'connecting' ? 'warn' : 'down')}>
          <span className="dot" />{conn === 'live' ? 'connected' : conn === 'connecting' ? 'connecting' : 'offline'}
        </span>
      </div>
      <button className="icon-btn" aria-label="Toggle theme" onClick={() => { toggleTheme(); force((n) => n + 1) }}>
        {getTheme() === 'light' ? '☾' : '☀'}
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Sidebar.tsx**
```tsx
export function Sidebar({ onNewChat }: { onNewChat: () => void }) {
  return (
    <aside className="sidebar">
      <div className="brand"><span className="mark">Z</span> zuse</div>
      <button className="side-btn" onClick={onNewChat}>＋&nbsp; New chat</button>
      <div className="side-note">One in-memory dev session. History isn’t persisted here yet — “New chat” just clears the view.</div>
      <div className="side-foot"><span className="eyebrow">DEV</span></div>
    </aside>
  )
}
```

- [ ] **Step 3: Shell.tsx(组装聊天主界面)**
```tsx
import { useState } from 'react'
import type { PermissionVerdict } from '@zuse/protocol'
import { useStore, nextId } from '../state/store.js'
import { Header } from './Header.js'
import { Sidebar } from './Sidebar.js'
import { MessageList } from './MessageList.js'
import { TodosPanel } from './TodosPanel.js'
import { PermissionCard } from './PermissionCard.js'
import { Composer } from './Composer.js'

export function Shell() {
  const { state, send, dispatch } = useStore()
  const [menuOpen, setMenuOpen] = useState(false)

  const onSend = (text: string) => { dispatch({ kind: 'user-send', id: nextId('u'), text }); send({ type: 'send', text }) }
  const onReply = (id: string, verdict: PermissionVerdict) => send({ type: 'permission-reply', id, verdict })

  return (
    <div className={'shell' + (menuOpen ? ' menu-open' : '')}>
      <div className="backdrop" onClick={() => setMenuOpen(false)} />
      <Sidebar onNewChat={() => { dispatch({ kind: 'reset' }); setMenuOpen(false) }} />
      <div className="main">
        <Header state={state} onMenu={() => setMenuOpen((o) => !o)} />
        <main className="chat">
          <MessageList messages={state.messages} notices={state.notices} thinking={state.thinking} />
          {state.pendingPermissions.length > 0 ? (
            <div className="perm-wrap">
              {state.pendingPermissions.map((p) => <PermissionCard key={p.id} pending={p} onReply={onReply} />)}
            </div>
          ) : null}
          <TodosPanel todos={state.todos} />
          <Composer disabled={state.thinking} onSend={onSend} onStop={() => send({ type: 'interrupt' })} />
        </main>
      </div>
    </div>
  )
}
```

> 注:`reset` action 只清前端视图(messages/notices),不动后端会话——与 dev 页「New chat」语义一致。

- [ ] **Step 4: AuthGate.tsx**
```tsx
import { useEffect, useState } from 'react'

type Phase = 'checking' | 'setup' | 'login' | 'ready' | 'error'

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>('checking')
  const [msg, setMsg] = useState('')
  const [pw, setPw] = useState('')

  useEffect(() => {
    fetch('/api/auth/status').then((r) => r.json()).then((d) => {
      setPhase(!d.configured ? 'setup' : !d.authenticated ? 'login' : 'ready')
    }).catch((e) => { setPhase('error'); setMsg(String(e?.message ?? e)) })
  }, [])

  if (phase === 'ready') return <>{children}</>
  if (phase === 'checking') return <div className="auth-card"><p>checking…</p></div>

  async function submit(path: string) {
    setMsg('')
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }) })
    if (r.ok) {
      if (path.endsWith('/setup')) { setMsg('Password set — reloading…'); setTimeout(() => location.reload(), 600) }
      else setPhase('ready')
    } else setMsg(r.status === 401 ? 'Incorrect password' : 'error ' + r.status)
  }

  const isSetup = phase === 'setup'
  return (
    <div className="auth-card">
      <h2>{phase === 'error' ? 'Server unreachable' : isSetup ? 'Protect this server' : 'Welcome back'}</h2>
      <p>{phase === 'error' ? msg : isSetup ? 'No password is set yet. Create one to lock the web console — it is hashed and stored locally.' : 'Enter your password to open the console.'}</p>
      {phase !== 'error' ? (
        <>
          <div className="field">
            <input type="password" placeholder={isSetup ? 'New password' : 'Password'} value={pw}
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(isSetup ? '/api/auth/setup' : '/api/auth/login') }} />
          </div>
          <button style={{ marginTop: 14, width: '100%' }} onClick={() => void submit(isSetup ? '/api/auth/setup' : '/api/auth/login')}>
            {isSetup ? 'Set password' : 'Log in'}
          </button>
          <div className="msg-error">{msg}</div>
        </>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 5: App.tsx(组装)**
```tsx
import { AuthGate } from './components/AuthGate.js'
import { StoreProvider } from './state/store.js'
import { Shell } from './components/Shell.js'

export function App() {
  return (
    <AuthGate>
      <StoreProvider>
        <Shell />
      </StoreProvider>
    </AuthGate>
  )
}
```

> 注:smoke.test.tsx(Task 2)断言文本 `zuse web`,现 App 变了——本步把 smoke.test.tsx 删除(`git rm packages/web/src/smoke.test.tsx`),其职责由 Header/Shell 等组件测试替代。

- [ ] **Step 6: styles.css(填全;移植 dev 页的暖色 token 与组件样式)**

把 `packages/web/src/styles.css` 整个替换为:
```css
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --sans: -apple-system, "Segoe UI", system-ui, Roboto, Helvetica, Arial, sans-serif;
  --mono: "Cascadia Code", "Cascadia Mono", ui-monospace, Consolas, "SF Mono", Menlo, monospace;
}
:root[data-theme="light"] {
  --ground: #E8E3D8; --surface: #FFFFFF; --surface-2: #F3F1EA; --user-bubble: #EEEBE3;
  --line: #E0DBD0; --text: #2A2824; --muted: #6E6A61; --faint: #A29D90;
  --accent: #6B57E0; --accent-2: #8B7BF0;
  --accent-soft: rgba(107,87,224,0.10); --accent-border: rgba(107,87,224,0.28); --accent-glow: rgba(107,87,224,0.28);
  --on-accent: #FFFFFF; --shadow: rgba(40,38,34,0.10); --header-bg: rgba(255,255,255,0.82);
  --good: #1F9D63; --warn: #B0791C; --bad: #D8453B;
}
:root[data-theme="dark"] {
  --ground: #161513; --surface: #232220; --surface-2: #2D2B27; --user-bubble: #343230;
  --line: #393631; --text: #ECEAE4; --muted: #A39E94; --faint: #6E6A61;
  --accent: #9A8CFF; --accent-2: #B7A0FF;
  --accent-soft: rgba(154,140,255,0.14); --accent-border: rgba(154,140,255,0.34); --accent-glow: rgba(154,140,255,0.38);
  --on-accent: #1A1726; --shadow: rgba(0,0,0,0.40); --header-bg: rgba(35,34,32,0.82);
  --good: #5BD0A0; --warn: #E5B567; --bad: #F0827A;
}
html, body, #root { height: 100%; }
body { font-family: var(--sans); color: var(--text); background: var(--ground); -webkit-font-smoothing: antialiased; }

.shell { height: 100vh; display: flex; background: var(--surface); overflow: hidden; }
.sidebar { width: 256px; flex: none; display: flex; flex-direction: column; gap: 14px; padding: 18px 14px; border-right: 1px solid var(--line); background: var(--ground); }
.brand { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 650; }
.mark { width: 24px; height: 24px; border-radius: 7px; flex: none; background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #fff; display: inline-flex; align-items: center; justify-content: center; font-weight: 800; font-style: italic; font-size: 14px; box-shadow: 0 0 14px var(--accent-glow); }
.eyebrow { font: 600 9px/1 var(--mono); letter-spacing: 0.22em; color: var(--faint); text-transform: uppercase; padding: 4px 7px; border: 1px solid var(--line); border-radius: 6px; }
.side-btn { display: flex; align-items: center; gap: 9px; width: 100%; justify-content: flex-start; background: transparent; border: 1px solid var(--line); color: var(--text); font-weight: 600; font-size: 13.5px; padding: 10px 13px; border-radius: 12px; cursor: pointer; }
.side-btn:hover { background: var(--surface-2); }
.side-note { font-size: 12px; color: var(--faint); line-height: 1.55; padding: 0 2px; }
.side-foot { margin-top: auto; display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }

.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.main-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 18px; border-bottom: 1px solid var(--line); background: var(--header-bg); backdrop-filter: blur(8px); }
.mh-left { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; min-width: 0; }
.mh-brand { display: none; }
.chip { display: inline-flex; align-items: center; font: 500 11px/1 var(--mono); color: var(--muted); background: var(--surface); border: 1px solid var(--line); border-radius: 999px; padding: 5px 9px; white-space: nowrap; }
.chip .dot { width: 6px; height: 6px; border-radius: 50%; margin-right: 6px; background: var(--faint); }
.chip.live .dot { background: var(--good); box-shadow: 0 0 7px var(--good); }
.chip.warn .dot { background: var(--warn); }
.chip.down .dot { background: var(--bad); }
.icon-btn { background: transparent; border: 1px solid var(--line); color: var(--muted); border-radius: 999px; width: 30px; height: 30px; padding: 0; font-size: 14px; line-height: 1; cursor: pointer; display: grid; place-items: center; }
.icon-btn:hover { background: var(--surface-2); color: var(--text); }
.menu-btn { display: none; }
.backdrop { display: none; }

.auth-card { max-width: 372px; width: 100%; margin: 14vh auto 0; background: var(--surface); border: 1px solid var(--line); border-radius: 18px; padding: 28px; box-shadow: 0 12px 40px var(--shadow); }
.auth-card h2 { font-size: 18px; margin-bottom: 7px; }
.auth-card p { color: var(--muted); font-size: 13.5px; line-height: 1.55; margin-bottom: 18px; }
.field { display: flex; gap: 8px; }
input[type=password], input[type=text], textarea { width: 100%; background: var(--surface); border: 1px solid var(--line); color: var(--text); font-family: var(--sans); font-size: 14px; padding: 11px 13px; border-radius: 11px; outline: none; }
input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
button { font-family: var(--sans); font-size: 14px; font-weight: 600; cursor: pointer; border: 1px solid transparent; border-radius: 11px; padding: 11px 17px; background: var(--accent); color: var(--on-accent); }
button:hover { filter: brightness(1.06); }
button.ghost { background: transparent; border-color: var(--line); color: var(--muted); font-weight: 500; }
button.ghost:hover { background: var(--surface-2); color: var(--text); }
button:disabled { opacity: 0.45; cursor: not-allowed; }
.msg-error { color: var(--bad); font-size: 12.5px; margin-top: 12px; min-height: 1em; }

.chat { flex: 1; display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.stream { flex: 1; min-width: 0; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; gap: 26px; width: 100%; padding: 30px 7% 26px; }
.empty { margin: auto; color: var(--faint); font-size: 14.5px; }
.msg.agent { align-self: stretch; max-width: 100%; }
.msg.you { align-self: flex-end; max-width: 80%; }
.msg.you .bubble { background: var(--user-bubble); border-radius: 20px; padding: 10px 16px; font-size: 15px; line-height: 1.6; color: var(--text); white-space: pre-wrap; word-break: break-word; }
.text { font-size: 15px; line-height: 1.72; word-break: break-word; color: var(--text); }
.text h1, .text h2, .text h3, .text h4 { line-height: 1.3; margin: 16px 0 8px; font-weight: 650; }
.text h1 { font-size: 1.4em; } .text h2 { font-size: 1.22em; } .text h3 { font-size: 1.08em; }
.text p { margin: 9px 0; }
.text ul, .text ol { margin: 9px 0; padding-left: 1.5em; }
.text li { margin: 3px 0; }
.text li.task-list-item { list-style: none; }
.text code { font-family: var(--mono); font-size: 0.88em; background: var(--surface-2); border: 1px solid var(--line); padding: 1px 5px; border-radius: 5px; }
.text pre { background: var(--surface-2); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; overflow-x: auto; margin: 10px 0; }
.text pre code { background: none; border: none; padding: 0; font-size: 12.5px; line-height: 1.55; }
.text table { border-collapse: collapse; margin: 10px 0; font-size: 13.5px; display: block; overflow-x: auto; }
.text th, .text td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; }
.text th { background: var(--surface-2); font-weight: 650; }
.text blockquote { border-left: 3px solid var(--accent-border); padding-left: 12px; color: var(--muted); margin: 9px 0; }
.text a { color: var(--accent); text-decoration: underline; }
.text hr { border: none; border-top: 1px solid var(--line); margin: 16px 0; }
.text > :first-child { margin-top: 0; } .text > :last-child { margin-bottom: 0; }
.hljs-keyword, .hljs-built_in, .hljs-tag { color: var(--accent); }
.hljs-string, .hljs-attr { color: var(--good); }
.hljs-number, .hljs-literal { color: var(--warn); }
.hljs-comment { color: var(--faint); font-style: italic; }

.tool { align-self: stretch; max-width: 100%; background: var(--surface-2); border: 1px solid var(--line); border-radius: 12px; padding: 11px 13px; font-family: var(--mono); font-size: 12.5px; margin: 14px 0; }
.tool .head { color: var(--accent); font-weight: 600; }
.tool .args { color: var(--muted); margin-top: 4px; white-space: pre-wrap; word-break: break-word; }
.tool .result { margin-top: 9px; padding-top: 9px; border-top: 1px solid var(--line); color: var(--text); white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto; }
.tool .result.err { color: var(--bad); }
.note { align-self: center; font: 500 12px/1.45 var(--mono); color: var(--faint); text-align: center; }
.note.warn { color: var(--warn); } .note.bad { color: var(--bad); } .note.live { color: var(--accent); }
.thinking { align-self: flex-start; }
.thinking .dots { display: flex; gap: 5px; align-items: center; height: 28px; }
.thinking .dots i { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); animation: bob 1.3s infinite ease-in-out; }
.thinking .dots i:nth-child(2) { animation-delay: 0.16s; } .thinking .dots i:nth-child(3) { animation-delay: 0.32s; }
@keyframes bob { 0%, 80%, 100% { transform: translateY(0); opacity: 0.45; } 40% { transform: translateY(-4px); opacity: 1; } }

.perm-wrap { padding: 0 7%; }
.perm { background: var(--surface); border: 1px solid var(--accent-border); border-radius: 14px; padding: 14px; box-shadow: 0 0 0 3px var(--accent-soft); margin-bottom: 14px; }
.perm .q { font-size: 14px; font-weight: 650; margin-bottom: 5px; }
.perm .spec { font-family: var(--mono); font-size: 12px; color: var(--muted); word-break: break-word; margin-bottom: 13px; }
.perm .actions { display: flex; gap: 8px; flex-wrap: wrap; }
.perm .actions button { padding: 8px 16px; font-size: 13px; }

.todos { margin: 0 7% 10px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 12px; padding: 11px 14px; max-height: 36vh; overflow-y: auto; }
.todos .th { font: 600 10px/1 var(--mono); letter-spacing: 0.16em; text-transform: uppercase; color: var(--faint); margin-bottom: 9px; display: flex; justify-content: space-between; }
.todos .ti { display: flex; gap: 9px; align-items: flex-start; font-size: 14px; line-height: 1.5; margin: 5px 0; color: var(--text); }
.todos .ti .ic { flex: none; width: 15px; text-align: center; }
.todos .ti.todo { color: var(--muted); } .todos .ti.todo .ic { color: var(--faint); }
.todos .ti.doing { font-weight: 650; } .todos .ti.doing .ic { color: var(--accent); }
.todos .ti.done { color: var(--muted); text-decoration: line-through; } .todos .ti.done .ic { color: var(--good); }

.composer-wrap { width: 100%; padding: 0 7% 18px; }
.composer { display: flex; align-items: flex-end; gap: 8px; background: var(--surface); border: 1px solid var(--line); border-radius: 24px; padding: 7px 7px 7px 17px; box-shadow: 0 2px 14px var(--shadow); }
.composer:focus-within { border-color: var(--accent-border); box-shadow: 0 2px 14px var(--shadow), 0 0 0 3px var(--accent-soft); }
.composer textarea { flex: 1; resize: none; border: none; background: transparent; padding: 9px 0; min-height: 24px; max-height: 168px; line-height: 1.5; font-size: 15px; }
.composer textarea:focus { box-shadow: none; }
.send-btn { width: 36px; height: 36px; border-radius: 50%; padding: 0; font-size: 17px; display: flex; align-items: center; justify-content: center; flex: none; }
.composer .ghost { align-self: center; padding: 8px 13px; border-radius: 16px; }

.stream::-webkit-scrollbar, .tool .result::-webkit-scrollbar, .todos::-webkit-scrollbar { width: 10px; }
.stream::-webkit-scrollbar-thumb, .tool .result::-webkit-scrollbar-thumb, .todos::-webkit-scrollbar-thumb { background: var(--line); border-radius: 8px; border: 3px solid transparent; background-clip: content-box; }

@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
@media (max-width: 820px) {
  .menu-btn { display: grid; } .mh-brand { display: flex; }
  .sidebar { position: fixed; top: 0; left: 0; bottom: 0; width: 264px; z-index: 30; transform: translateX(-100%); transition: transform 0.22s ease; box-shadow: 0 0 50px var(--shadow); }
  .shell.menu-open .sidebar { transform: translateX(0); }
  .backdrop { display: block; position: fixed; inset: 0; background: rgba(0,0,0,0.42); z-index: 20; opacity: 0; pointer-events: none; transition: opacity 0.2s; }
  .shell.menu-open .backdrop { opacity: 1; pointer-events: auto; }
}
@media (max-width: 560px) { .msg.you { max-width: 90%; } }
```

- [ ] **Step 7(test): Header.test.tsx**
```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Header } from './Header.js'
import { initialState } from '../state/reducer.js'

describe('Header', () => {
  it('shows ctx used / window / percent', () => {
    render(<Header state={{ ...initialState, connection: 'live', model: 'claude', contextTokens: 4700, contextWindow: 200000 }} onMenu={() => {}} />)
    expect(screen.getByText(/ctx 4.7k \/ 200.0k · 2%/)).toBeInTheDocument()
    expect(screen.getByText('connected')).toBeInTheDocument()
  })
})
```

- [ ] **Step 8: 删 smoke 测试,跑全 web 测试 + typecheck + build**

```bash
git rm packages/web/src/smoke.test.tsx
```
Run: `pnpm -F @zuse/web test`
Expected: 全部 PASS（reducer / client / theme / Message / Composer / TodosPanel / Header）
Run: `pnpm -F @zuse/web typecheck`
Expected: 干净
Run: `pnpm -F @zuse/web build`
Expected: 构建成功,产出 dist

- [ ] **Step 9: Commit**
```bash
git add packages/web/src
git commit -m "feat(web): shell, header, sidebar, auth gate + full styles"
```
trailer 同上。

---

## Task 9: 服务器静态托管 + SPA fallback

**Files:**
- Modify: `packages/server/src/config.ts`(加 `webDir`)
- Modify: `packages/server/src/startServer.ts`(传 `webDir`)
- Modify: `packages/server/src/http/server.ts`(静态 + fallback)
- Test: `packages/server/src/http/static.test.ts`

- [ ] **Step 1(TDD): static.test.ts**
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeRequestHandler } from './server.js'
import type { AuthProvider } from '../auth/authProvider.js'

const fakeAuth = { verifyToken: () => true, isConfigured: async () => true } as unknown as AuthProvider
let dir: string, server: Server, base: string

async function start(webDir?: string): Promise<void> {
  server = createServer(makeRequestHandler({ auth: fakeAuth, devPage: true, tokenTtlSec: 3600, webDir }))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const a = server.address()
  base = 'http://127.0.0.1:' + (typeof a === 'object' && a ? a.port : 0)
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'zuse-web-')) })
afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); rmSync(dir, { recursive: true, force: true }) })

describe('static SPA serving', () => {
  it('serves index.html at / when webDir has one', async () => {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>SPA</title>')
    await start(dir)
    const r = await fetch(base + '/')
    expect(await r.text()).toContain('SPA')
  })

  it('serves a real asset with a content-type', async () => {
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)')
    await start(dir)
    const r = await fetch(base + '/assets/app.js')
    expect(r.headers.get('content-type')).toContain('javascript')
    expect(await r.text()).toContain('console.log')
  })

  it('SPA fallback: unknown GET path returns index.html', async () => {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>SPA</title>')
    await start(dir)
    const r = await fetch(base + '/some/route')
    expect(await r.text()).toContain('SPA')
  })

  it('falls back to the dev page when no webDir', async () => {
    await start(undefined)
    const r = await fetch(base + '/')
    expect(await r.text()).toContain('DEV TEST PAGE')
  })

  it('blocks path traversal', async () => {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>SPA</title>')
    await start(dir)
    const r = await fetch(base + '/../../etc/passwd')
    expect([403, 404, 200].includes(r.status)).toBe(true)
    expect(await r.text()).not.toContain('root:')
  })

  it('does not break /healthz or /api', async () => {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>SPA</title>')
    await start(dir)
    expect((await (await fetch(base + '/healthz')).json()).status).toBe('ok')
  })
})
```

- [ ] **Step 2: 跑确认失败**

Run: `pnpm vitest run packages/server/src/http/static.test.ts`
Expected: FAIL（webDir 选项 / 静态逻辑还没有）

- [ ] **Step 3: 改 server.ts**

(a) 顶部 import 加:
```ts
import { readFile, stat } from 'node:fs/promises'
import { join, normalize, extname } from 'node:path'
```
(b) `RequestHandlerDeps` 加字段:
```ts
  webDir?: string
```
(c) 加内容类型表 + 静态服务函数(放在 `makeRequestHandler` 外、文件作用域):
```ts
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8',
}

async function tryServeFile(res: ServerResponse, abs: string): Promise<boolean> {
  try {
    const s = await stat(abs)
    if (!s.isFile()) return false
    const buf = await readFile(abs)
    res.writeHead(200, { 'content-type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream' })
    res.end(buf)
    return true
  } catch { return false }
}
```
(d) 把现有的 `// GET / — inline dev test page` 整块(从 `if (method === 'GET' && path === '/')` 到其闭合 `}`)替换为:
```ts
    // Static SPA (F4): serve packages/web/dist + SPA fallback. Falls back to the dev page.
    if (method === 'GET') {
      if (deps.webDir) {
        // Resolve within webDir; reject traversal.
        const rel = normalize(path).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '')
        const abs = join(deps.webDir, rel)
        if (abs.startsWith(deps.webDir)) {
          if (path !== '/' && (await tryServeFile(res, abs))) return
          // SPA fallback → index.html
          if (await tryServeFile(res, join(deps.webDir, 'index.html'))) return
        }
      }
      if (deps.devPage) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return void res.end(DEV_PAGE_HTML)
      }
      return sendJson(res, 404, { error: { code: 'not_found', message: 'Not found' } })
    }
```
(保留其后的 `// Fallback` 404 不变。)

- [ ] **Step 4: 改 config.ts**

`ServerConfig` 接口加:
```ts
  /** 打包后的前端目录(packages/web/dist);未配置则回退 dev 页。 */
  webDir?: string
```
`defaultConfig()` 不强加(保持 undefined → dev 页 fallback;真正路径在 bin/startServer 解析)。

- [ ] **Step 5: 改 startServer.ts**

把 `makeRequestHandler({ auth, devPage: true, tokenTtlSec: cfg.tokenTtlSec })` 改为带 webDir:
```ts
  const httpServer = createServer(makeRequestHandler({ auth, devPage: true, tokenTtlSec: cfg.tokenTtlSec, webDir: cfg.webDir }))
```

- [ ] **Step 6: 跑测试**

Run: `pnpm vitest run packages/server/src/http/static.test.ts`
Expected: 6 用例 PASS
Run: `pnpm vitest run packages/server`
Expected: 全 PASS（无回归）
Run: `pnpm -F @zouyj/zuse-server typecheck`
Expected: 干净

- [ ] **Step 7: Commit**
```bash
git add packages/server/src/http/server.ts packages/server/src/http/static.test.ts packages/server/src/config.ts packages/server/src/startServer.ts
git commit -m "feat(server): serve built web SPA (static + fallback), dev page as fallback"
```
trailer 同上。

---

## Task 10: 全量验证 + 端到端 + 解耦守护 + 记忆

**Files:** 无代码改动(验证 + 记忆)

- [ ] **Step 1: web 全测 + typecheck + build**

Run: `pnpm -F @zuse/web test && pnpm -F @zuse/web typecheck && pnpm -F @zuse/web build`
Expected: 全 PASS,产出 `packages/web/dist`

- [ ] **Step 2: 全 workspace 测试(根)**

Run: `pnpm vitest run`
Expected: server/core/tools/protocol PASS;`packages/web` 已被根 vitest 排除(用上一步单独跑)。已知旁支:`packages/tools/src/bash.test.ts` 与 `packages/core/src/anthropic-client.test.ts` 的环境性失败与 F4 无关(文件未改动)。

- [ ] **Step 3: 解耦守护**

Run: `git grep -nE "from '@zuse/(core|server|tui)'|from \\"@zuse/(core|server|tui)\\"" packages/web/src || echo "OK: web only imports protocol"`
Expected: 仅可能命中 `import type ... from '@zuse/protocol'`(允许);无 core/server/tui 的 import → 打印 OK 或仅 protocol 行。

- [ ] **Step 4: 端到端手动验收(需真 API key)**

开发态:
```bash
# 终端 A:后端
npx tsx packages/server/src/bin.ts
# 终端 B:前端
pnpm -F @zuse/web dev
```
浏览器开 `http://127.0.0.1:5173`,登录后:发消息看**流式 Markdown**、切换**主题**、窄屏开**侧栏抽屉**、触发**权限按钮**、**任务面板**三态、顶栏 `ctx 已用 / 窗口 · 百分比`。

生产态(node 直接托管打包 SPA):需要 bin 传 `webDir`。临时验证:
```bash
node -e "require('@zouyj/zuse-server')" 2>/dev/null # 占位;实际用下方 tsx 片段
ZUSE_WEBDIR="$(pwd)/packages/web/dist" npx tsx -e "import('./packages/server/src/startServer.ts').then(m=>m.startServer({host:'127.0.0.1',port:4180,authDir:require('os').homedir()+'/.zuse',tokenTtlSec:3600,cwd:process.cwd(),webDir:process.env.ZUSE_WEBDIR}).then(s=>console.log('serving SPA at',s.url)))"
```
浏览器开 `http://127.0.0.1:4180`,确认直接加载打包 SPA(非 dev 页)。
> 注:让 `zuse-server` bin 默认带 `webDir`(解析到 web/dist)是 follow-up(见 spec §11),F4 验收用上面的显式 webDir 即可。

- [ ] **Step 5: 更新进度记忆**

更新 `C:\Users\nhn\.claude\projects\E--ai-study-zuse\memory\web_ui_program_progress.md`:标记 **F4 已实现**(packages/web:Vite+React SPA,WS 客户端 + 纯 reducer + parts 模型 + react-markdown + 主题/侧栏/权限/任务面板 + ctx 窗口百分比;server 静态托管 + SPA fallback,dev 页保留为 fallback;协议加 contextWindow)。续作改为按需功能 spec(I2 图片上传 / S1 多会话+持久化 / M 管理面板 / mermaid·diff 渲染器 / npm 发布把 web/dist 打进 server)。同步更新 `MEMORY.md` 那行 hook。

- [ ] **Step 6: 收尾**

按 superpowers:finishing-a-development-branch 决定 merge/PR(合回 master,与 F1/F2/F3 一致)。

---

## Self-Review

**Spec 覆盖(逐条对 spec)**：
- §3 包与构建(Vite/React/依赖/dev proxy/build) → Task 2 ✓
- §4 协议 contextWindow + SessionManager + dev 页同步 → Task 1 ✓
- §5.1 目录结构 → Task 2–8 文件 ✓
- §5.2 parts 消息模型 + 纯 reducer → Task 3 ✓
- §5.3 富媒体管线(part 分发 + markdown 高亮) → Task 6(Message 按 part 分发 / Markdown + rehype-highlight) ✓
- §6 server 静态 + SPA fallback + webDir + 防穿越 → Task 9 ✓
- §7 鉴权 AuthGate → Task 8 ✓
- §8 错误处理(断线重连/notice/鉴权) → Task 4(重连)+ Task 3(notice)+ Task 8(AuthGate) ✓
- §9 测试(reducer/ws/组件/server 静态/解耦) → Task 3/4/6/7/8/9/10 ✓
- §10 验收 → Task 10 ✓

**占位符扫描**：无 TBD/TODO;每个改码步骤给了完整代码或精确替换。

**类型/命名一致性**：
- `reduce(state, action)` 签名与 `Action` 联合 → Task 3 定义,store(Task 5)、reducer.test(Task 3)、Header.test(Task 8 用 initialState)一致 ✓
- `createWsClient(opts)` + `WsClient` → Task 4 定义,store(Task 5)一致(onMessage/onStatus/url)✓
- `useStore()`/`nextId()`/`StoreProvider` → Task 5 定义,Shell/App(Task 8)一致 ✓
- `Part`/`Message`/`AppState` → Task 3 定义,Message/MessageList/ToolCall(Task 6)、TodosPanel/PermissionCard(Task 7)、Header(Task 8)一致 ✓
- `ServerMessage`/`ClientMessage`/`SessionSnapshot`/`PermissionVerdict`/`TodoItemLite`/`PendingPermissionLite`/`Usage` 全来自 `@zuse/protocol`(type-only)✓
- `contextWindow` 字段 → protocol(Task 1)定义,reducer(Task 3)、Header(Task 8)、dev 页(Task 1)一致 ✓
- server `RequestHandlerDeps.webDir` → Task 9 定义,static.test/startServer 一致 ✓
- CSS 类名(.shell/.sidebar/.main-header/.chip/.stream/.msg/.text/.tool/.note/.thinking/.perm/.todos/.composer/.menu-btn/.backdrop)与组件 className 一致 ✓
