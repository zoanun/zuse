# F3：WS 协议 + 接线（含会话工厂）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 定义 WS 消息协议（独立 `packages/protocol` 类型包）+ 一个把 `@zuse/core`/`@zuse/tools` 真件接成可工作 `SessionManager` 的会话工厂，并把它焊进 F1 的 `/ws`，替换 echo，让浏览器能端到端真聊（单会话、内存态）。

**Architecture:** `packages/protocol` 是纯 type-only 的线缆契约（web 永不 value-import core，只 `import type`）。`createSession(cwd, deps?)` 镜像 TUI 的构造序列但不碰 React/不 import tui。`startServer` 饱和构建一次 session 注册进 `SessionRegistry`（失败不崩 daemon），`attachWsServer` 连上发快照、转发 `SessionEvent`、上行帧经 `applyClientMessage` 分派到 SessionManager 方法。

**Tech Stack:** TypeScript（ESM, Node≥22）、`ws`、vitest、tsup、pnpm workspace。设计见 `docs/superpowers/specs/2026-06-24-F3-ws-protocol-wiring-design.md`。

---

## 文件结构

| 文件 | 职责 | 动作 |
|------|------|------|
| `packages/protocol/package.json` | 新包清单（type-only，exports→src） | 新建 |
| `packages/protocol/tsconfig.json` | 继承 base | 新建 |
| `packages/protocol/src/index.ts` | 线缆契约：re-export core 类型 + 迁入 DTO + `ClientMessage`/`ServerMessage` | 新建 |
| `packages/server/package.json` | 加 `@zuse/protocol` devDep | 改 |
| `packages/server/src/session/events.ts` | 删本地 DTO 定义，改为从 protocol 转手；保留 `SnapshotStore`/`SessionCheckpoint` | 改 |
| `packages/server/src/session/createSession.ts` | 会话工厂 | 新建 |
| `packages/server/src/session/createSession.test.ts` | 工厂单测（fake client） | 新建 |
| `packages/server/src/config.ts` | 加 `cwd` 到 `ServerConfig`、`DEFAULT_SESSION_ID` | 改 |
| `packages/server/src/startServer.ts` | 构建/注入 session、`sessionErr`、传 registry | 改 |
| `packages/server/src/bin.ts` | 传 `cwd`（INIT_CWD） | 改 |
| `packages/server/src/ws/wsServer.ts` | 替换 echo：snapshot + 转发 + 上行分派 | 改 |
| `packages/server/src/ws/wsServer.test.ts` | 重写：snapshot/转发/sessionErr/分派 集成测试 | 改 |
| `packages/server/src/ws/clientMessage.ts` | 上行帧解析分派（纯、可单测） | 新建 |
| `packages/server/src/ws/clientMessage.test.ts` | 分派单测（spy mgr） | 新建 |
| `packages/server/src/http/devPage.ts` | dev 页 WS 控制台改说新协议（throwaway，F4 替） | 改 |

---

## Task 1: 新建 `packages/protocol`（线缆契约 type-only 包）

**Files:**
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/protocol/src/index.ts`

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "@zuse/protocol",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "files": ["dist", "package.json"],
  "dependencies": {
    "@zuse/core": "workspace:*"
  }
}
```

> 沿用内部包约定：`exports` 直指 `src/index.ts`（dev 时消费源码；server 的 tsup `noExternal: [/^@zuse\//]` 会在打包时把它内联进 dist，type-only 几乎不增体积）。`@zuse/core` 仅用于 `export type` 转导，放普通 deps 即可。

- [ ] **Step 2: 写 tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: 写 src/index.ts（全部线缆类型）**

```ts
/**
 * @zuse/protocol — web ↔ server 的唯一线缆契约（type-only，零运行时）。
 *
 * 注意：这里从 @zuse/core 只做 `export type` 转导。core 是 Node 引擎（node:fs /
 * better-sqlite3 等），不能进浏览器 bundle；但 `export type` 在编译期被擦除，web
 * 侧 `import type` 这些类型不会把任何 core 运行时拖进 bundle。详见 F3 设计 §2。
 */
import type { PermissionRequest, PermissionVerdict, Usage } from '@zuse/core'

export type { PermissionRequest, PermissionVerdict, Usage } from '@zuse/core'

/** 轻量 todo —— 与 server 内部状态镜像。 */
export interface TodoItemLite {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** 已推给前端但尚未解决的权限请求。 */
export interface PendingPermissionLite {
  id: string
  req: PermissionRequest
}

/**
 * SessionManager 可发射给订阅者的全部事件。成员全部 JSON 可序列化（无函数/类实例），
 * 字段名镜像 @zuse/core 的 StreamEvent，便于零变换转发。
 */
export type SessionEvent =
  | { type: 'message-start'; id: string; model: string }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-use'; id: string; name: string; input: unknown; invalid_args?: string }
  | { type: 'tool-result'; id: string; name: string; output: string; is_error: boolean }
  | { type: 'message-stop'; stop_reason: string; usage: Usage }
  | { type: 'turn-start'; isResend: boolean }
  | { type: 'turn-end' }
  | { type: 'usage-update'; totalUsage: Usage | undefined }
  | { type: 'context-update'; contextTokens: number | undefined }
  | { type: 'permission-request'; id: string; req: PermissionRequest }
  | { type: 'permission-resolved'; id: string; verdict: PermissionVerdict }
  | { type: 'compaction-start' }
  | { type: 'compaction-done'; summaryText: string }
  | { type: 'failover'; fromModel: string; toModel: string; reason: string }
  | { type: 'checkpoint-recorded'; id: string; messageIndex: number; label: string }
  | { type: 'memory-notice'; text: string }
  | { type: 'todos-update'; todos: TodoItemLite[] }
  | { type: 'cwd-change'; cwd: string }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string; category?: string }
  | { type: 'aborted' }
  | { type: 'model-select-needed'; reason: string }

/** 连上时发给晚加入订阅者的全量状态快照。 */
export interface SessionSnapshot {
  sessionId: string
  isThinking: boolean
  model: string
  cwd: string
  totalUsage: Usage | undefined
  contextTokens: number | undefined
  todos: TodoItemLite[]
  pendingPermissions: PendingPermissionLite[]
  messageCount: number
}

/** 上行 client → server。 */
export type ClientMessage =
  | { type: 'send'; text: string }
  | { type: 'interrupt' }
  | { type: 'steer'; text: string }
  | { type: 'permission-reply'; id: string; verdict: PermissionVerdict }
  | { type: 'switch-model'; providerId: string; model: string }

/** 下行 server → client。 */
export type ServerMessage =
  | { type: 'snapshot'; snapshot: SessionSnapshot }
  | { type: 'event'; event: SessionEvent }
  | { type: 'error'; message: string }
```

- [ ] **Step 4: 安装并 typecheck**

Run: `pnpm install && pnpm -F @zuse/protocol typecheck`
Expected: PASS（无类型错误；workspace 链接成功）

- [ ] **Step 5: Commit**

```bash
git add packages/protocol pnpm-lock.yaml
git commit -m "feat(protocol): type-only WS wire-contract package (@zuse/protocol)"
```

---

## Task 2: server 改用 protocol，删除 events.ts 中重复的 DTO

**Files:**
- Modify: `packages/server/package.json`（devDependencies 加 `@zuse/protocol`）
- Modify: `packages/server/src/session/events.ts`

- [ ] **Step 1: package.json 加 protocol devDep**

把 `packages/server/package.json` 的 `devDependencies` 改成（与 `@zuse/core`/`@zuse/tools` 并列）：

```json
  "devDependencies": {
    "@types/ws": "^8.5.12",
    "@zuse/core": "workspace:*",
    "@zuse/protocol": "workspace:*",
    "@zuse/tools": "workspace:*"
  }
```

> 放 devDependencies 与 core/tools 一致：tsup `noExternal` 在 build 时内联 `@zuse/*`，运行时不需要它作为发布依赖。

- [ ] **Step 2: 重写 events.ts —— 线缆 DTO 从 protocol 转手，仅保留 server 内部契约**

把 `packages/server/src/session/events.ts` 整个替换为：

```ts
/**
 * 线缆 DTO（SessionEvent / SessionSnapshot / TodoItemLite / PendingPermissionLite）
 * 已迁到 @zuse/protocol 作为 web↔server 的唯一契约；这里转手 re-export，保持
 * 既有 import 路径（SessionManager / index.ts 仍从 './events.js' 取）不变。
 *
 * SnapshotStore / SessionCheckpoint 是 SessionManager 的内部契约（非线缆类型），
 * 留在 server 本地。
 */
export type {
  SessionEvent,
  SessionSnapshot,
  TodoItemLite,
  PendingPermissionLite,
} from '@zuse/protocol'

/**
 * Shadow-git snapshot backend used for checkpoint/revert (Phase 12). Narrow seam:
 * the SessionManager only needs to track() a checkpoint and restore() to one.
 */
export interface SnapshotStore {
  /** Snapshot the workspace before a turn; resolves to a commit-hash anchor, or null on no-op/failure. */
  track(): Promise<string | null>
  /** Restore the workspace to a previously-tracked hash. Rejects on failure. */
  restore(hash: string): Promise<void>
}

/**
 * A session checkpoint (Phase 12): a shadow-git snapshot anchor captured before a
 * user turn. /revert = restore(hash) + truncate the ledger to messageIndex.
 */
export interface SessionCheckpoint {
  /** Index of this turn's user message in the ledger (revert truncates to here). */
  messageIndex: number
  /** Shadow-git commit hash; the checkpoint-recorded event uses this as `id`. */
  hash: string
  /** ISO timestamp when the snapshot was taken. */
  at: string
  /** First ~80 chars of the user's message, for display. */
  label: string
}
```

> 删掉了原文件顶部 `import type { PermissionRequest, PermissionVerdict, Usage } from '@zuse/core'` —— 这些类型现在被 protocol 内部用，events.ts 自身不再需要它们（`SnapshotStore`/`SessionCheckpoint` 不引 core 类型）。

- [ ] **Step 3: 安装并全量验证**

Run: `pnpm install && pnpm -F @zuse/server typecheck`
Expected: PASS（`SessionManager.ts` 与 `index.ts` 从 `./events.js` 取到的类型经 protocol 转手，仍解析成功）

- [ ] **Step 4: 跑既有 server 测试，确认零回归**

Run: `pnpm vitest run packages/server`
Expected: PASS（F1/F2 既有测试不破）

- [ ] **Step 5: 守护「零 server→tui import」**

Run: `git grep -n "@zuse/tui" packages/server/src || echo "OK: no tui import"`
Expected: 打印 `OK: no tui import`

- [ ] **Step 6: Commit**

```bash
git add packages/server/package.json packages/server/src/session/events.ts pnpm-lock.yaml
git commit -m "refactor(server): source WS DTOs from @zuse/protocol"
```

---

## Task 3: 会话工厂 `createSession`

**Files:**
- Modify: `packages/server/src/config.ts`（仅加 `DEFAULT_SESSION_ID`，本任务先用到）
- Create: `packages/server/src/session/createSession.ts`
- Test: `packages/server/src/session/createSession.test.ts`

- [ ] **Step 1: config.ts 加 `DEFAULT_SESSION_ID`**

在 `packages/server/src/config.ts` 顶部 `SESSION_COOKIE` 旁加一行：

```ts
export const SESSION_COOKIE = 'zuse_session'
/** F3 单会话的固定 id；多会话 id 生成留 S1。 */
export const DEFAULT_SESSION_ID = 'default'
```

- [ ] **Step 2: 写失败测试 createSession.test.ts**

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamEvent } from '@zuse/core'
import { createSession } from './createSession.js'
import { fakeClient, fakeSnapshotStore } from './testFakes.js'
import type { SessionEvent } from './events.js'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'zuse-sess-'))
}

describe('createSession', () => {
  it('wires a working session: a plain submit streams events end-to-end', async () => {
    const dir = tmp()
    const script: StreamEvent[] = [
      { type: 'message-start', id: 'm1', model: 'fake-model' },
      { type: 'text-delta', text: 'hi there' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    const { client } = fakeClient([script])
    const mgr = createSession(dir, { client, snapshotStore: fakeSnapshotStore() })
    const events: SessionEvent[] = []
    mgr.subscribe((e) => events.push(e))

    await mgr.submit('hello')

    const types = events.map((e) => e.type)
    expect(types).toContain('turn-start')
    expect(types).toContain('text-delta')
    expect(types).toContain('turn-end')
    expect(mgr.getState().isThinking).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('registers TodoWrite wired to setTodos (todos-update emitted)', async () => {
    const dir = tmp()
    // Turn 0: model calls TodoWrite (stop_reason tool_use makes core run it).
    // Turn 1: clean stop so the agent loop terminates.
    const scripts: StreamEvent[][] = [
      [
        { type: 'message-start', id: 'm1', model: 'fake-model' },
        { type: 'tool-use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'do x', status: 'pending' }] } },
        { type: 'message-stop', stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } },
      ],
      [
        { type: 'message-start', id: 'm2', model: 'fake-model' },
        { type: 'text-delta', text: 'done' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
      ],
    ]
    const { client } = fakeClient(scripts)
    const mgr = createSession(dir, { client, snapshotStore: fakeSnapshotStore() })
    const todoEvents: Extract<SessionEvent, { type: 'todos-update' }>[] = []
    mgr.subscribe((e) => {
      // TodoWrite is NOT readOnly → under defaultMode 'default' it is classified 'ask',
      // so the interactive policy parks it; auto-allow to let the turn proceed.
      if (e.type === 'permission-request') mgr.resolvePermission(e.id, 'allow')
      if (e.type === 'todos-update') todoEvents.push(e)
    })

    await mgr.submit('make a plan')

    expect(todoEvents).toHaveLength(1)
    expect(todoEvents[0]!.todos[0]!.content).toBe('do x')
    expect(todoEvents[0]!.todos[0]!.status).toBe('pending')
    rmSync(dir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run packages/server/src/session/createSession.test.ts`
Expected: FAIL（`Cannot find module './createSession.js'`）

- [ ] **Step 4: 写 createSession.ts**

```ts
import { homedir, release } from 'node:os'
import {
  loadSettings,
  installProxy,
  resolveModelSelection,
  getProviderConfig,
  getWebSearchConfig,
  createModelClient,
  buildSystemPrompt,
  loadPromptSections,
  type ModelClient,
} from '@zuse/core'
import {
  createDefaultRegistry,
  createTodoWriteTool,
  getShellLabel,
  scanSkills,
  createSnapshotStore,
  cwdSlug,
} from '@zuse/tools'
import { SessionManager } from './SessionManager.js'
import type { SnapshotStore } from './events.js'
import { DEFAULT_SESSION_ID } from '../config.js'

export interface CreateSessionDeps {
  /** 注入用：协议/工厂单测传 fake client，离线不烧 token。缺省走 createModelClient。 */
  client?: ModelClient
  /** 注入用：测试可传假快照存储。缺省 createSnapshotStore(cwd)。 */
  snapshotStore?: SnapshotStore
}

/**
 * 把 @zuse/core / @zuse/tools 的真件接成一个可工作的 SessionManager。
 * 镜像 TUI（index.tsx / useConversation.ts）的构造序列，但不碰 React、不 import tui。
 * client/snapshotStore 可注入以保持单测离线、无网络、无 git。
 */
export function createSession(cwd: string, deps: CreateSessionDeps = {}): SessionManager {
  const settings = loadSettings()
  try {
    installProxy(settings)
  } catch (err) {
    // 与 TUI 一致：代理地址非法时降级直连并告警，不阻断会话构建。
    console.warn(`[zuse-server] 代理配置无效，已降级直连：${err instanceof Error ? err.message : String(err)}`)
  }

  const sel = resolveModelSelection(settings)
  const client = deps.client ?? createModelClient(getProviderConfig(settings, sel.providerId), sel.model)

  const home = homedir()
  const registry = createDefaultRegistry({
    webSearch: getWebSearchConfig(settings),
    memoryProject: cwdSlug(cwd),
    skills: scanSkills(home, cwd),
  })

  // late-bind：TodoWrite.onUpdate 要回调到下面才构造的 manager（镜像 TUI 的 ref 套路）。
  let mgr!: SessionManager
  registry.register(createTodoWriteTool({ onUpdate: (todos) => mgr.setTodos(todos) }))
  // 注：Agent / ScheduleWakeup 工具 F3 不接 —— 二者需反向访问 manager 的 live client
  // （failover 会热替换），且非聊天必需，显式留作 follow-up。

  const systemPrompt = buildSystemPrompt(
    {
      platform: process.platform,
      osVersion: release(),
      shell: getShellLabel(),
      cwd,
      date: new Date().toISOString().slice(0, 10),
    },
    loadPromptSections(home, cwd),
    sel.model,
  )

  const snapshotStore = deps.snapshotStore ?? createSnapshotStore(cwd)

  mgr = new SessionManager({
    sessionId: DEFAULT_SESSION_ID,
    cwd,
    client,
    registry,
    settings,
    systemPrompt,
    permissionPolicy: { interactive: true, config: settings.permissions },
    snapshotStore,
    providerId: sel.providerId,
  })
  return mgr
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run packages/server/src/session/createSession.test.ts`
Expected: PASS（两个用例都绿）

- [ ] **Step 6: typecheck**

Run: `pnpm -F @zuse/server typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/config.ts packages/server/src/session/createSession.ts packages/server/src/session/createSession.test.ts
git commit -m "feat(server): createSession factory wiring real core/tools pieces"
```

---

## Task 4: 接线 part 1 —— config.cwd + startServer 构建/注入 session + attachWsServer 发快照/转发事件

**Files:**
- Modify: `packages/server/src/config.ts`（加 `cwd`）
- Modify: `packages/server/src/startServer.ts`
- Modify: `packages/server/src/bin.ts`
- Modify: `packages/server/src/ws/wsServer.ts`
- Modify: `packages/server/src/ws/wsServer.test.ts`（重写）

- [ ] **Step 1: config.ts 加 `cwd`**

把 `ServerConfig` 与 `defaultConfig` 改为（保留已有 `DEFAULT_SESSION_ID`）：

```ts
import { homedir } from 'node:os'
import { join } from 'node:path'

export const SESSION_COOKIE = 'zuse_session'
/** F3 单会话的固定 id；多会话 id 生成留 S1。 */
export const DEFAULT_SESSION_ID = 'default'

export interface ServerConfig {
  host: string
  port: number
  authDir: string
  tokenTtlSec: number
  /** 会话工作目录（会话起始 cwd）。bin 传 INIT_CWD；缺省 process.cwd()。 */
  cwd: string
}

export function defaultConfig(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 4180,
    authDir: join(homedir(), '.zuse'),
    tokenTtlSec: 60 * 60 * 24 * 30,
    cwd: process.cwd(),
  }
}
```

- [ ] **Step 2: 重写 wsServer.test.ts（snapshot/转发/sessionErr/unauth）**

> 重构：不再用共享预建 server（旧 echo 测试删除）。每个 ws 测试用 `makeServer(scripts)` 注入一个 fake-client session（离线、无网络、无 git），并把所建 server 收集进 `servers` 数组在 afterEach 统一关闭。

把 `packages/server/src/ws/wsServer.test.ts` 整个替换为：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { StreamEvent } from '@zuse/core'
import type { ServerMessage } from '@zuse/protocol'
import { startServer } from '../startServer.js'
import { attachWsServer } from './wsServer.js'
import { createSession } from '../session/createSession.js'
import { SessionRegistry } from '../session/SessionRegistry.js'
import { fakeClient, fakeSnapshotStore } from '../session/testFakes.js'
import type { AuthProvider } from '../auth/authProvider.js'

let dir: string
const servers: { close(): Promise<void> }[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zuse-ws-'))
})
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Boot a real server with an injected fake-client session + complete auth handshake. */
async function makeServer(scripts: StreamEvent[][] = []) {
  const { client } = fakeClient(scripts)
  const session = createSession(dir, { client, snapshotStore: fakeSnapshotStore() })
  const server = await startServer(
    { host: '127.0.0.1', port: 0, authDir: dir, tokenTtlSec: 3600, cwd: dir },
    { session },
  )
  servers.push(server)
  const json = (b: unknown) => ({ method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } })
  await fetch(`${server.url}/api/auth/setup`, json({ password: 'pw' }))
  const login = await fetch(`${server.url}/api/auth/login`, json({ password: 'pw' }))
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  return { server, cookie, session }
}

function wsUrl(u: string) { return u.replace('http', 'ws') + '/ws' }

/** Resolve with the first parsed ServerMessage the socket receives. */
function firstMessage(ws: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    ws.on('message', (d) => resolve(JSON.parse(d.toString()) as ServerMessage))
    ws.on('error', reject)
  })
}

describe('ws wiring', () => {
  it('sends a snapshot frame on connect', async () => {
    const { server, cookie } = await makeServer()
    const ws = new WebSocket(wsUrl(server.url), { headers: { cookie } })
    await new Promise((r) => ws.on('open', r))
    const msg = await firstMessage(ws)
    expect(msg.type).toBe('snapshot')
    if (msg.type === 'snapshot') {
      expect(msg.snapshot.sessionId).toBe('default')
      expect(msg.snapshot.isThinking).toBe(false)
    }
    ws.close()
  })

  it('forwards SessionEvents as event frames', async () => {
    const script: StreamEvent[] = [
      { type: 'message-start', id: 'm1', model: 'fake-model' },
      { type: 'text-delta', text: 'streamed' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    const { server, cookie, session } = await makeServer([script])
    const ws = new WebSocket(wsUrl(server.url), { headers: { cookie } })
    const frames: ServerMessage[] = []
    await new Promise((r) => ws.on('open', r))
    ws.on('message', (d) => frames.push(JSON.parse(d.toString()) as ServerMessage))

    // Drive a turn DIRECTLY (uplink dispatch is wired in Task 5).
    await session.submit('hi')
    // Give the event loop a tick to flush WS frames.
    await new Promise((r) => setTimeout(r, 50))

    const textDelta = frames.find(
      (f): f is Extract<ServerMessage, { type: 'event' }> =>
        f.type === 'event' && f.event.type === 'text-delta',
    )
    expect(textDelta).toBeDefined()
    if (textDelta && textDelta.event.type === 'text-delta') {
      expect(textDelta.event.text).toBe('streamed')
    }
    ws.close()
  })

  it('sends an error frame when the session is unavailable', async () => {
    // Isolated attachWsServer with an empty registry + sessionErr; fake auth allows the token.
    const httpServer = createServer()
    const fakeAuth = { verifyToken: () => true } as unknown as AuthProvider
    attachWsServer(httpServer, { auth: fakeAuth, registry: new SessionRegistry(), sessionErr: 'boom' })
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r))
    const addr = httpServer.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    servers.push({ close: () => new Promise<void>((r) => { httpServer.closeAllConnections(); httpServer.close(() => r()) }) })

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: 'x' } })
    const msg = await firstMessage(ws)
    expect(msg.type).toBe('error')
    if (msg.type === 'error') expect(msg.message).toContain('boom')
    ws.close()
  })

  it('rejects an unauthenticated client', async () => {
    const { server } = await makeServer()
    const ws = new WebSocket(wsUrl(server.url))
    const rejected = await new Promise<boolean>((resolve) => {
      ws.on('open', () => { ws.close(); resolve(false) })
      ws.on('close', () => resolve(true))
      ws.on('error', () => resolve(true))
      ws.on('unexpected-response', () => resolve(true))
    })
    expect(rejected).toBe(true)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run packages/server/src/ws/wsServer.test.ts`
Expected: FAIL（`startServer` 还不接受第二参 deps / `attachWsServer` 还不接受 `registry`/`sessionErr`；类型与运行均报错）

- [ ] **Step 4: 重写 wsServer.ts（快照 + 转发 + 忽略二进制 + sessionErr；上行先留空，Task 5 填）**

把 `packages/server/src/ws/wsServer.ts` 整个替换为：

```ts
import type * as http from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AuthProvider } from '../auth/authProvider.js'
import type { SessionRegistry } from '../session/SessionRegistry.js'
import type { ServerMessage } from '@zuse/protocol'
import { parseCookies } from '../http/cookies.js'
import { SESSION_COOKIE, DEFAULT_SESSION_ID } from '../config.js'

export interface WsServerDeps {
  auth: AuthProvider
  registry: SessionRegistry
  /** Set when session construction failed at startup; connections get an error frame. */
  sessionErr?: string
}

function sendJson(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

export function attachWsServer(httpServer: http.Server, deps: WsServerDeps): { closeAll(): void } {
  const wss = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost')
    // Only handle /ws; leave other paths for any other upgrade handlers.
    if (pathname !== '/ws') return

    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    if (!deps.auth.verifyToken(token ?? '')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)

      const mgr = deps.registry.get(DEFAULT_SESSION_ID)
      if (deps.sessionErr || !mgr) {
        sendJson(ws, { type: 'error', message: `session unavailable: ${deps.sessionErr ?? 'no session'}` })
        return
      }

      // Live events → event frames. Snapshot first so a late joiner has current state.
      const unsub = mgr.subscribe((e) => sendJson(ws, { type: 'event', event: e }))
      sendJson(ws, { type: 'snapshot', snapshot: mgr.getState() })

      ws.on('message', (_data, _isBinary) => {
        // Uplink dispatch wired in Task 5. Binary frames are reserved for V1 (audio).
      })
      ws.on('close', unsub)
    })
  })

  return {
    closeAll() {
      for (const client of wss.clients) client.terminate()
    },
  }
}
```

- [ ] **Step 5: 改 startServer.ts —— 构建/注入 session + sessionErr + 传 registry**

把 `packages/server/src/startServer.ts` 整个替换为：

```ts
import { createServer } from 'node:http'
import { PasswordStore } from './auth/passwordStore.js'
import { LocalPasswordAuth } from './auth/authProvider.js'
import { makeRequestHandler } from './http/server.js'
import { attachWsServer } from './ws/wsServer.js'
import { SessionRegistry } from './session/SessionRegistry.js'
import { createSession } from './session/createSession.js'
import { DEFAULT_SESSION_ID, type ServerConfig } from './config.js'
import type { SessionManager } from './session/SessionManager.js'

export interface StartServerDeps {
  /** 注入用：测试传一个 fake-client session，跳过真件构建。 */
  session?: SessionManager
}

export async function startServer(
  cfg: ServerConfig,
  deps: StartServerDeps = {},
): Promise<{ url: string; close(): Promise<void> }> {
  const auth = new LocalPasswordAuth(new PasswordStore(cfg.authDir), cfg.tokenTtlSec)

  // 饱和构建一次单会话（内存态）。构建失败不崩 daemon：记日志、置 sessionErr，
  // /ws 连上回 error 帧，health/setup/login 仍可用。
  const registry = new SessionRegistry()
  let sessionErr: string | undefined
  try {
    registry.set(DEFAULT_SESSION_ID, deps.session ?? createSession(cfg.cwd))
  } catch (err) {
    sessionErr = err instanceof Error ? err.message : String(err)
    console.warn(`[zuse-server] session 构建失败：${sessionErr}（/ws 将回 error，health/login 仍可用）`)
  }

  const httpServer = createServer(makeRequestHandler({ auth, devPage: true, tokenTtlSec: cfg.tokenTtlSec }))
  const ws = attachWsServer(httpServer, { auth, registry, sessionErr })
  await new Promise<void>((resolve) => httpServer.listen(cfg.port, cfg.host, () => resolve()))
  const addr = httpServer.address()
  const port = typeof addr === 'object' && addr ? addr.port : cfg.port
  if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost') {
    console.warn(`[zuse-server] bound to ${cfg.host}:${port} — plaintext HTTP on a network interface. Use a TLS tunnel (A2) for remote access.`)
  }
  return {
    url: `http://${cfg.host}:${port}`,
    close: () => new Promise<void>((resolve) => {
      httpServer.close(() => resolve())
      ws.closeAll()
      httpServer.closeAllConnections()
    }),
  }
}
```

- [ ] **Step 6: 改 bin.ts 传 cwd**

把 `packages/server/src/bin.ts` 中构造 `cfg` 的块改为带上 `cwd`（pnpm -F 会把 process.cwd 切到包目录，INIT_CWD 才是用户真正敲命令的目录，与 TUI 一致）：

```ts
  const args = parseArgs(process.argv.slice(2))
  const cfg = {
    ...defaultConfig(),
    cwd: process.env.INIT_CWD ?? process.cwd(),
    ...(args.port !== undefined ? { port: args.port } : {}),
    ...(args.host !== undefined ? { host: args.host } : {}),
  }
```

- [ ] **Step 7: 跑 ws 测试确认通过**

Run: `pnpm vitest run packages/server/src/ws/wsServer.test.ts`
Expected: PASS（snapshot / forward / sessionErr / unauth 四个用例绿）

- [ ] **Step 8: typecheck + 全量 server 测试**

Run: `pnpm -F @zuse/server typecheck && pnpm vitest run packages/server`
Expected: PASS（含 server.test.ts / smoke.test.ts —— 它们 `startServer(cfg)` 不传 deps，会饱和构建真 session；createSnapshotStore 懒初始化、createModelClient 不联网，故无副作用、无回归）

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/config.ts packages/server/src/startServer.ts packages/server/src/bin.ts packages/server/src/ws/wsServer.ts packages/server/src/ws/wsServer.test.ts
git commit -m "feat(server): wire SessionManager into /ws (snapshot + event forwarding), replace echo"
```

---

## Task 5: 接线 part 2 —— 上行帧分派 `applyClientMessage`

**Files:**
- Create: `packages/server/src/ws/clientMessage.ts`
- Test: `packages/server/src/ws/clientMessage.test.ts`
- Modify: `packages/server/src/ws/wsServer.ts`（message handler 接上 dispatch）
- Modify: `packages/server/src/ws/wsServer.test.ts`（加 send→event 集成用例）

- [ ] **Step 1: 写失败测试 clientMessage.test.ts**

```ts
import { describe, it, expect, vi } from 'vitest'
import { applyClientMessage, type SessionManagerLike } from './clientMessage.js'

function fakeMgr(): SessionManagerLike & {
  submit: ReturnType<typeof vi.fn>
  interrupt: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
  resolvePermission: ReturnType<typeof vi.fn>
  switchModel: ReturnType<typeof vi.fn>
} {
  return {
    submit: vi.fn(async () => {}),
    interrupt: vi.fn(() => true),
    steer: vi.fn(),
    resolvePermission: vi.fn(),
    switchModel: vi.fn(),
  }
}

describe('applyClientMessage', () => {
  it('dispatches send to submit', () => {
    const mgr = fakeMgr()
    const err = vi.fn()
    applyClientMessage(mgr, JSON.stringify({ type: 'send', text: 'hi' }), err)
    expect(mgr.submit).toHaveBeenCalledWith('hi')
    expect(err).not.toHaveBeenCalled()
  })

  it('dispatches interrupt / steer / permission-reply / switch-model', () => {
    const mgr = fakeMgr()
    const err = vi.fn()
    applyClientMessage(mgr, JSON.stringify({ type: 'interrupt' }), err)
    applyClientMessage(mgr, JSON.stringify({ type: 'steer', text: 'go' }), err)
    applyClientMessage(mgr, JSON.stringify({ type: 'permission-reply', id: 'p1', verdict: 'allow' }), err)
    applyClientMessage(mgr, JSON.stringify({ type: 'switch-model', providerId: 'anthropic', model: 'x' }), err)
    expect(mgr.interrupt).toHaveBeenCalled()
    expect(mgr.steer).toHaveBeenCalledWith('go')
    expect(mgr.resolvePermission).toHaveBeenCalledWith('p1', 'allow')
    expect(mgr.switchModel).toHaveBeenCalledWith('anthropic', 'x')
    expect(err).not.toHaveBeenCalled()
  })

  it('errors on invalid JSON', () => {
    const err = vi.fn()
    applyClientMessage(fakeMgr(), 'not json', err)
    expect(err).toHaveBeenCalledWith(expect.stringContaining('invalid JSON'))
  })

  it('errors on a non-object / missing type', () => {
    const err = vi.fn()
    applyClientMessage(fakeMgr(), JSON.stringify(42), err)
    expect(err).toHaveBeenCalledWith(expect.stringContaining('expected an object'))
  })

  it('errors on unknown type', () => {
    const err = vi.fn()
    applyClientMessage(fakeMgr(), JSON.stringify({ type: 'frobnicate' }), err)
    expect(err).toHaveBeenCalledWith(expect.stringContaining('unknown message type'))
  })

  it('reports a rejected submit (turn already in progress)', async () => {
    const mgr = fakeMgr()
    mgr.submit = vi.fn(async () => { throw new Error('A turn is already in progress') })
    const err = vi.fn()
    applyClientMessage(mgr, JSON.stringify({ type: 'send', text: 'x' }), err)
    await Promise.resolve()
    await Promise.resolve()
    expect(err).toHaveBeenCalledWith('A turn is already in progress')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/server/src/ws/clientMessage.test.ts`
Expected: FAIL（`Cannot find module './clientMessage.js'`）

- [ ] **Step 3: 写 clientMessage.ts**

```ts
import type { SessionManager } from '../session/SessionManager.js'
import type { ClientMessage } from '@zuse/protocol'

/** 上行分派器驱动的 SessionManager 子集（便于单测注入 spy）。 */
export type SessionManagerLike = Pick<
  SessionManager,
  'submit' | 'interrupt' | 'steer' | 'resolvePermission' | 'switchModel'
>

/**
 * 解析一条上行 WS 文本帧并分派到 SessionManager。
 * 对不可解析/非法/未知帧、以及被拒绝的 submit（如回合进行中），调用 sendError(message)。
 * 绝不抛错（消息泵不能被一条坏帧打断）。
 */
export function applyClientMessage(
  mgr: SessionManagerLike,
  raw: string,
  sendError: (message: string) => void,
): void {
  let msg: ClientMessage
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { type?: unknown }).type !== 'string') {
      sendError('malformed message: expected an object with a string "type"')
      return
    }
    msg = parsed as ClientMessage
  } catch {
    sendError('malformed message: invalid JSON')
    return
  }

  switch (msg.type) {
    case 'send':
      if (typeof msg.text !== 'string') { sendError('send: "text" must be a string'); return }
      mgr.submit(msg.text).catch((err) => sendError(err instanceof Error ? err.message : String(err)))
      return
    case 'interrupt':
      mgr.interrupt()
      return
    case 'steer':
      if (typeof msg.text !== 'string') { sendError('steer: "text" must be a string'); return }
      mgr.steer(msg.text)
      return
    case 'permission-reply':
      if (typeof msg.id !== 'string') { sendError('permission-reply: "id" must be a string'); return }
      mgr.resolvePermission(msg.id, msg.verdict)
      return
    case 'switch-model':
      if (typeof msg.providerId !== 'string' || typeof msg.model !== 'string') {
        sendError('switch-model: "providerId" and "model" must be strings')
        return
      }
      mgr.switchModel(msg.providerId, msg.model)
      return
    default:
      sendError(`unknown message type: ${(msg as { type: string }).type}`)
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/server/src/ws/clientMessage.test.ts`
Expected: PASS（六个用例绿）

- [ ] **Step 5: wsServer.ts 接上 dispatch**

在 `packages/server/src/ws/wsServer.ts` 顶部 import 区加：

```ts
import { applyClientMessage } from './clientMessage.js'
```

把 Task 4 留空的 message handler：

```ts
      ws.on('message', (_data, _isBinary) => {
        // Uplink dispatch wired in Task 5. Binary frames are reserved for V1 (audio).
      })
```

替换为：

```ts
      ws.on('message', (data, isBinary) => {
        if (isBinary) return // binary frames reserved for V1 (audio)
        applyClientMessage(mgr, data.toString(), (message) => sendJson(ws, { type: 'error', message }))
      })
```

- [ ] **Step 6: 给 wsServer.test.ts 加 send→event 集成用例**

在 `packages/server/src/ws/wsServer.test.ts` 的 `describe('ws wiring', …)` 内追加：

```ts
  it('a send frame drives a turn and streams event frames', async () => {
    const script: StreamEvent[] = [
      { type: 'message-start', id: 'm1', model: 'fake-model' },
      { type: 'text-delta', text: 'pong' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    const { server, cookie } = await makeServer([script])
    const ws = new WebSocket(wsUrl(server.url), { headers: { cookie } })
    const frames: ServerMessage[] = []
    await new Promise((r) => ws.on('open', r))
    ws.on('message', (d) => frames.push(JSON.parse(d.toString()) as ServerMessage))

    ws.send(JSON.stringify({ type: 'send', text: 'ping' }))
    await new Promise((r) => setTimeout(r, 50))

    const hasTextDelta = frames.some(
      (f) => f.type === 'event' && f.event.type === 'text-delta' && f.event.text === 'pong',
    )
    expect(hasTextDelta).toBe(true)
    ws.close()
  })

  it('a malformed uplink frame yields an error frame', async () => {
    const { server, cookie } = await makeServer()
    const ws = new WebSocket(wsUrl(server.url), { headers: { cookie } })
    const frames: ServerMessage[] = []
    await new Promise((r) => ws.on('open', r))
    ws.on('message', (d) => frames.push(JSON.parse(d.toString()) as ServerMessage))

    ws.send('not json')
    await new Promise((r) => setTimeout(r, 50))

    expect(frames.some((f) => f.type === 'error' && f.message.includes('invalid JSON'))).toBe(true)
    ws.close()
  })
```

- [ ] **Step 7: 跑 ws 全量测试确认通过**

Run: `pnpm vitest run packages/server/src/ws`
Expected: PASS（wsServer 6 用例 + clientMessage 6 用例全绿）

- [ ] **Step 8: typecheck**

Run: `pnpm -F @zuse/server typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/ws/clientMessage.ts packages/server/src/ws/clientMessage.test.ts packages/server/src/ws/wsServer.ts packages/server/src/ws/wsServer.test.ts
git commit -m "feat(server): uplink WS dispatch (send/interrupt/steer/permission-reply/switch-model)"
```

---

## Task 6: dev 页改说新协议（throwaway，F4 替换）

**Files:**
- Modify: `packages/server/src/http/devPage.ts`

> 目的：让浏览器手动验收能真聊。只改 WS 控制台那段 JS/HTML，最小可用即可（F4 用真 SPA 替换整页）。

- [ ] **Step 1: 改 WS 区标题与发送/接收逻辑**

在 `packages/server/src/http/devPage.ts` 中：

(a) 把 `<h2>WebSocket echo console</h2>`（约第 54 行）改为：

```html
  <h2>WebSocket chat console</h2>
```

(b) 把 `ws.send(val)` 那段（约第 125–132 行的 `el('ws-send')` click 处理）改为发送协议帧：

```js
  el('ws-send').addEventListener('click', function () {
    var inp = el('ws-input');
    var val = inp.value.trim();
    if (!val || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'send', text: val }));
    appendMsg('sent', '→ ' + val);
    inp.value = '';
  });
```

(c) 把接收处理（约第 112–114 行的 `ws.addEventListener('message', …)`）改为解析 ServerMessage：

```js
    ws.addEventListener('message', function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { appendMsg('recv', '← ' + ev.data); return; }
      if (msg.type === 'snapshot') {
        appendMsg('sys', '[snapshot] model=' + msg.snapshot.model + ' msgs=' + msg.snapshot.messageCount);
      } else if (msg.type === 'error') {
        appendMsg('sys', '[error] ' + msg.message);
      } else if (msg.type === 'event') {
        var e = msg.event;
        if (e.type === 'text-delta') appendMsg('recv', e.text);
        else if (e.type === 'tool-use') appendMsg('sys', '[tool-use] ' + e.name);
        else if (e.type === 'tool-result') appendMsg('sys', '[tool-result] ' + e.name + (e.is_error ? ' (error)' : ''));
        else if (e.type === 'permission-request') appendMsg('sys', '[permission-request] ' + e.id + ' — reply via {"type":"permission-reply","id":"' + e.id + '","verdict":"allow"}');
        else appendMsg('sys', '[' + e.type + ']');
      }
    });
```

- [ ] **Step 2: 跑 devPage 测试确认不破**

Run: `pnpm vitest run packages/server/src/http/devPage.test.ts`
Expected: PASS（仍含 `<!doctype html>` / `/api/auth/login` / `/ws` / `DEV TEST PAGE`，无外部资源引用）

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/http/devPage.ts
git commit -m "feat(server): dev page speaks the F3 WS protocol (throwaway)"
```

---

## Task 7: 全量验证 + 手动浏览器验收 + 记忆更新

**Files:**
- 无代码改动（验证 + 文档/记忆）

- [ ] **Step 1: 全 workspace 测试**

Run: `pnpm vitest run`
Expected: PASS（protocol 无运行时测试；server 既有 + 新增全绿；tui/core/tools 不回归）

> 旁支已知技术债：`packages/core/src/workflow.test.ts` 有 4 个 *typecheck* 错误（vitest 仍通过），非本 spec 引入、不阻断。见 spec §11 / 记忆 [[web-ui-program-progress]]。

- [ ] **Step 2: 构建验证（protocol 内联进 server dist）**

Run: `pnpm -F @zuse/server build`
Expected: PASS（tsup 把 `@zuse/protocol` 经 `noExternal` 内联进 dist，无残留 `@zuse/*` import）

- [ ] **Step 3: 守护解耦边界**

Run: `git grep -n "@zuse/tui" packages/server/src packages/protocol/src || echo "OK: no tui import"`
Expected: 打印 `OK: no tui import`

- [ ] **Step 4: 手动浏览器验收（真聊）**

```bash
# 需本机已配好模型 API key（settings.json 或 ZUSE_API_KEY_<ID>）
npx tsx packages/server/src/bin.ts
```
浏览器开 `http://127.0.0.1:4180/` → 设/输口令登录 → WS chat console：
- 连上即见 `[snapshot] model=… msgs=0`；
- 输入一句话回车 → 看到模型**真流式回复**（`text-delta` 逐字追加），而非 `echo:`；
- 若工具触发权限，控制台提示 `[permission-request] …`，可手敲 `permission-reply` 帧放行（按钮式 UI 是 I1/F4）。

Expected: 端到端真聊成功（echo 已被替换）。若缺 key，连上应见 `[error] session unavailable: …` 而服务不崩。

- [ ] **Step 5: 更新进度记忆**

把 `C:\Users\nhn\.claude\projects\E--ai-study-zuse\memory\web_ui_program_progress.md` 中的进度段更新：标记 **F3 已完成并合并**（packages/protocol 线缆契约 + createSession 工厂 + /ws 接线替换 echo，单会话内存态，浏览器可真聊），续作改为 **F4（React 前端骨架 + 聊天流）**。同步更新 `MEMORY.md` 对应行的 hook。

- [ ] **Step 6: 收尾**

按 superpowers:finishing-a-development-branch 决定 merge/PR（合回 master，与 F1/F2 一致）。

---

## Self-Review

**Spec coverage（逐条对 spec）：**
- §4.1 core 类型转导 → Task 1 Step 3 ✓
- §4.2 迁入 DTO（SessionEvent/SessionSnapshot/TodoItemLite/PendingPermissionLite），SnapshotStore/SessionCheckpoint 留 server → Task 1 Step 3 + Task 2 Step 2 ✓
- §4.3 ClientMessage/ServerMessage + 二进制忽略 + discriminant `type` → Task 1 Step 3 + Task 4 Step 4（忽略二进制）+ Task 5 ✓
- §5 会话工厂 createSession（含 late-bind TodoWrite、不接 Agent/ScheduleWakeup、client/snapshotStore 注入）→ Task 3 ✓
- §6.1 startServer 饱和构建 + sessionErr 不崩 + cfg.cwd + bin INIT_CWD → Task 4 ✓
- §6.2 attachWsServer：subscribe→snapshot→forward→ignore binary→dispatch；多连接共享 → Task 4 + Task 5 ✓
- §7 数据流（send 端到端、权限）→ Task 5 + Task 7 Step 4 ✓
- §8 错误处理（工厂失败/坏帧/回合进行中/二进制/断开 unsub）→ Task 3/4/5 测试覆盖 ✓
- §9 测试策略（protocol 类型、createSession、wsServer、clientMessage、解耦守护）→ Task 1–5 + Task 7 ✓
- §10 验收（bin 起服务真聊、全量绿、build、pack）→ Task 7 ✓
- §11 follow-ups → 记录在 spec，Task 3 注释标注 Agent/ScheduleWakeup 不接 ✓

**Placeholder scan：** 无 TBD/TODO；每个改码步骤都给了完整代码或精确替换片段。

**Type consistency：**
- `attachWsServer(httpServer, WsServerDeps{auth, registry, sessionErr})` —— Task 4 定义、startServer（Task 4）与测试（Task 4/5）一致调用 ✓
- `startServer(cfg, StartServerDeps{session?})` —— Task 4 定义、makeServer/测试一致 ✓
- `createSession(cwd, CreateSessionDeps{client?, snapshotStore?})` —— Task 3 定义、Task 4 makeServer 一致 ✓
- `applyClientMessage(mgr, raw, sendError)` + `SessionManagerLike` —— Task 5 定义、wsServer handler 与测试一致 ✓
- `ServerMessage`/`ClientMessage`/`SessionEvent`/`SessionSnapshot` —— 单一定义于 protocol（Task 1），server/test 全从 protocol 或经 events.ts 转手取，命名一致 ✓
- `DEFAULT_SESSION_ID = 'default'` —— config 定义（Task 3），createSession/attachWsServer/测试一致 ✓
- `sendJson(ws, ServerMessage)` —— wsServer 内部，类型一致 ✓
- StreamEvent 脚本字段名（message-start{id,model}/text-delta{text}/tool-use{id,name,input}/message-stop{stop_reason,usage}）与 F2 既有 SessionManager.test.ts 一致 ✓
