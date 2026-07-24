# C1/C2 定时任务（cron 调度 + 管理面板）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 zuse 加定时任务——用户配 cron 规则+执行内容(prompt)，daemon 到点开全新会话跑一轮 agent、留档，前端面板管理任务+回看历次执行。

**Architecture:** 后端 `CronScheduler`(croner 引擎，与 WS 平级的驱动源，只调 SessionManager API) 到点 `fire()` → 经 `SessionService` 建一个 `kind:'cron'`、`interactive:false` 的全新会话 → `submit(prompt)` → 记 `CronRun`(jsonl) → `release()` 释放不泄漏。任务/运行持久化在 `~/.zuse/cron/`。REST `/api/cron` 经 `CronService` 暴露；前端主区新增 `mainView:'cron'` 视图。

**Tech Stack:** TypeScript(纯)、`croner`(新依赖，零依赖 cron 引擎)、Node fs、React 19、vitest、现有 protocol/core/server/web 分层。

**关键约束**：传输无关(CronScheduler 不 import HTTP/WS)；不引 `@zuse/core` 值进 web(只 `import type` protocol)；server 无 test 脚本→根 vitest(`pnpm exec vitest run packages/server`)；web 测试包内跑(`cd packages/web && pnpm exec vitest run`)；权限**纯复用** `interactive:false`+`defaultMode`，零新权限机器；全局 deny 表恒拦作硬底线(core `decide()` 顺序 禁用→deny→bypass→allow→ask)。

**分支**：从 master 切 `cron-scheduler`。

---

## 共享类型（贯穿全程，务必一致）

**protocol**（`packages/protocol/src/index.ts` 新增）：
```ts
export type CronPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions'
export type CronRunStatus = 'running' | 'success' | 'failed'

export interface CronTask {
  id: string
  name: string
  cron: string            // 标准 5 段 cron 表达式
  prompt: string
  cwd: string
  permissionMode: CronPermissionMode
  enabled: boolean
  createdAt: string
  updatedAt: string
}

/** 列表项：任务 + 计算出的下次执行时间（croner nextRun，非持久化）。 */
export interface CronTaskWithNext extends CronTask {
  nextRun: string | null
}

/** 建/改任务的请求体（id/时间戳由服务端填）。 */
export interface CronTaskInput {
  name: string
  cron: string
  prompt: string
  cwd?: string
  permissionMode?: CronPermissionMode
  enabled?: boolean
}

export interface CronRun {
  id: string
  taskId: string
  startedAt: string
  finishedAt?: string
  status: CronRunStatus
  sessionId: string
  summary?: string
  error?: string
}

/** 某次执行详情：run 记录 + 那次会话的消息投影（复用现有 SnapshotMessage 渲染）。 */
export interface CronRunDetail {
  run: CronRun
  messages: SnapshotMessage[]   // SnapshotMessage 已在本文件定义
}
```

**core `PermissionMode`**（`packages/core/src/types.ts:98`，已存在，不改）：`'default' | 'acceptEdits' | 'bypassPermissions'`。`CronPermissionMode` 与之同值（protocol type-only 复述，不 value-import core）。

---

## 文件结构

**新增**
| 文件 | 职责 |
|---|---|
| `packages/server/src/cron/cronStore.ts` | 纯持久化：tasks.json 原子读写 + runs/<taskId>.jsonl append/读(按 id 去重、last-wins) + 删任务 runs |
| `packages/server/src/cron/cronStore.test.ts` | cronStore 单测 |
| `packages/server/src/cron/CronScheduler.ts` | croner 引擎：start/schedule/reschedule/unschedule/fire/close + nextRun 查询 |
| `packages/server/src/cron/CronScheduler.test.ts` | 调度器单测(直接调 fire，不等真实时钟) |
| `packages/server/src/cron/CronService.ts` | REST 面向：任务 CRUD + listRuns + runNow + getRunDetail |
| `packages/server/src/cron/CronService.test.ts` | CronService 单测 |
| `packages/web/src/state/cronApi.ts` | 前端 API 客户端(复用 session.ts 的 request) |
| `packages/web/src/components/CronPanel.tsx` | 面板容器 + 子视图(任务列表/表单/执行列表/运行详情) |
| `packages/web/src/components/CronPanel.test.tsx` | 面板单测 |

**修改**
| 文件 | 改动 |
|---|---|
| `packages/protocol/src/index.ts` | 新增上述 DTO |
| `packages/core/src/types.ts` | 无（PermissionMode 已存在） |
| `packages/server/src/session/SessionManager.ts` | SessionManagerOpts + `kind?`；字段 + `getKind()` |
| `packages/server/src/session/createSession.ts` | opts + `permissionMode?`/`kind?`；据此算 permissionPolicy；透传 kind |
| `packages/server/src/session/sessionStore.ts` | SessionRecord + `kind?:'cron'`；listSessions build 过滤 cron |
| `packages/server/src/session/SessionService.ts` | create opts + `permissionMode?`/`kind?`；getOrLoad 透传 rec.kind；persist 写 kind；新增 `release(id)` |
| `packages/server/src/http/server.ts` | RequestHandlerDeps + `cron: CronService`；挂 `/api/cron` 路由 |
| `packages/server/src/startServer.ts` | 实例化 CronScheduler+CronService、start、传入 handler、close 时停 |
| `packages/server/package.json` | deps + `croner` |
| `packages/web/src/state/store.tsx` | `mainView:'chat'\|'cron'` state + setter |
| `packages/web/src/components/Sidebar.tsx` | "新会话"下方加"⏰ 定时任务"入口 |
| `packages/web/src/components/Shell.tsx` | mainView==='cron' 时主区渲染 CronPanel |

---

## Phase 1：协议 DTO + cronStore

### Task 1：protocol 新增 cron DTO

**Files:**
- Modify: `packages/protocol/src/index.ts`（在文件末尾、SnapshotMessage 定义之后新增）

- [ ] **Step 1: 加类型**（把上文「共享类型 · protocol」整块粘到 `index.ts` 末尾；`SnapshotMessage` 已在本文件，`CronRunDetail.messages` 直接引用它）。

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @zuse/protocol exec tsc --noEmit`
Expected: EXIT 0（protocol 是 type-only 包，无运行时）

- [ ] **Step 3: Commit**

```bash
git add packages/protocol/src/index.ts
git commit -m "feat(protocol): cron DTOs (CronTask/CronRun/CronTaskInput/CronRunDetail)"
```

### Task 2：cronStore（tasks.json 原子读写）

**Files:**
- Create: `packages/server/src/cron/cronStore.ts`
- Test: `packages/server/src/cron/cronStore.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTasks, saveTasks, appendRun, loadRuns, deleteTaskRuns } from './cronStore.js'
import type { CronTask, CronRun } from '@zuse/protocol'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cron-')) })

const task = (over: Partial<CronTask> = {}): CronTask => ({
  id: 't1', name: 'n', cron: '0 9 * * *', prompt: 'p', cwd: '/tmp',
  permissionMode: 'bypassPermissions', enabled: true,
  createdAt: '2026-07-24T00:00:00.000Z', updatedAt: '2026-07-24T00:00:00.000Z', ...over,
})

describe('cronStore tasks', () => {
  it('round-trips tasks; missing file → []', async () => {
    expect(await loadTasks(dir)).toEqual([])
    await saveTasks(dir, [task(), task({ id: 't2', name: 'm' })])
    const got = await loadTasks(dir)
    expect(got.map((t) => t.id)).toEqual(['t1', 't2'])
  })
})

describe('cronStore runs', () => {
  const run = (over: Partial<CronRun> = {}): CronRun => ({
    id: 'r1', taskId: 't1', startedAt: '2026-07-24T09:00:00.000Z', status: 'running', sessionId: 's1', ...over,
  })
  it('append + dedupe by id (last wins), newest startedAt first', async () => {
    await appendRun(dir, run())
    await appendRun(dir, run({ status: 'success', finishedAt: 'x', summary: 'done' })) // same id r1 → replaces
    await appendRun(dir, run({ id: 'r2', startedAt: '2026-07-24T10:00:00.000Z', status: 'failed', error: 'e' }))
    const runs = await loadRuns(dir, 't1')
    expect(runs.map((r) => r.id)).toEqual(['r2', 'r1'])        // newest first
    expect(runs.find((r) => r.id === 'r1')!.status).toBe('success') // last write won
  })
  it('skips a corrupt jsonl line', async () => {
    await appendRun(dir, run())
    const { appendFileSync } = await import('node:fs')
    appendFileSync(join(dir, 'runs', 't1.jsonl'), 'NOT JSON\n')
    await appendRun(dir, run({ id: 'r2' }))
    expect((await loadRuns(dir, 't1')).map((r) => r.id).sort()).toEqual(['r1', 'r2'])
  })
  it('deleteTaskRuns removes the jsonl', async () => {
    await appendRun(dir, run())
    await deleteTaskRuns(dir, 't1')
    expect(await loadRuns(dir, 't1')).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/server/src/cron/cronStore.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 cronStore**

```ts
import { mkdir, writeFile, rename, readFile, readdir, unlink } from 'node:fs/promises'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CronTask, CronRun } from '@zuse/protocol'

/** cron 数据根目录（tasks.json + runs/<taskId>.jsonl）。 */
export function cronDir(authDir: string): string { return join(authDir, 'cron') }

function tasksPath(dir: string): string { return join(dir, 'tasks.json') }
function runsDir(dir: string): string { return join(dir, 'runs') }
function safeId(id: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error(`Invalid cron id: "${id}"`)
  return id
}
function runsPath(dir: string, taskId: string): string { return join(runsDir(dir), `${safeId(taskId)}.jsonl`) }

/** 读所有任务；文件缺失/损坏 → []。 */
export async function loadTasks(dir: string): Promise<CronTask[]> {
  try {
    const arr = JSON.parse(await readFile(tasksPath(dir), 'utf8'))
    return Array.isArray(arr) ? (arr as CronTask[]) : []
  } catch { return [] }
}

/** 原子写全部任务（tmp→rename）。 */
export async function saveTasks(dir: string, tasks: CronTask[]): Promise<void> {
  await mkdir(dir, { recursive: true })
  const final = tasksPath(dir)
  const tmp = `${final}.tmp`
  await writeFile(tmp, JSON.stringify(tasks, null, 2), 'utf8')
  await rename(tmp, final)
}

/** 追加一条执行记录（同 id 视为更新——loadRuns 去重 last-wins）。 */
export async function appendRun(dir: string, run: CronRun): Promise<void> {
  await mkdir(runsDir(dir), { recursive: true })
  await appendFile(runsPath(dir, run.taskId), JSON.stringify(run) + '\n', 'utf8')
}

/** 读某任务全部执行记录：按 id 去重(后写覆盖先写)，按 startedAt 倒序。坏行跳过。 */
export async function loadRuns(dir: string, taskId: string): Promise<CronRun[]> {
  let raw: string
  try { raw = await readFile(runsPath(dir, taskId), 'utf8') } catch { return [] }
  const byId = new Map<string, CronRun>()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { const r = JSON.parse(line) as CronRun; byId.set(r.id, r) } catch { /* skip corrupt line */ }
  }
  return [...byId.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
}

/** 删某任务的执行记录文件（幂等）。 */
export async function deleteTaskRuns(dir: string, taskId: string): Promise<void> {
  try { await unlink(runsPath(dir, taskId)) } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}
```

> `readdir` 已 import 但本文件暂未用——删掉未用 import（只留 mkdir/writeFile/rename/readFile/unlink/appendFile）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run packages/server/src/cron/cronStore.test.ts`
Expected: PASS（3+ 用例）

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cron/cronStore.ts packages/server/src/cron/cronStore.test.ts
git commit -m "feat(server): cronStore — tasks.json atomic write + runs jsonl (dedupe last-wins)"
```

---

## Phase 2：会话接缝（kind + 非交互权限）

### Task 3：SessionManager 携带 kind

**Files:**
- Modify: `packages/server/src/session/SessionManager.ts`（`SessionManagerOpts` ~line 74-90 区间；构造函数 ~line 241；加 getter）

- [ ] **Step 1: SessionManagerOpts 加字段**（在 `permissionPolicy: PermissionPolicy` 附近）

```ts
  /** 会话类别标记：'cron' = 定时任务跑出的会话（从普通列表过滤）。缺省 = 普通会话。 */
  kind?: 'cron'
```

- [ ] **Step 2: 构造函数存字段 + getter**（在 `this.policy = opts.permissionPolicy` 附近加 `this.kind = opts.kind`；类中加私有字段 `private readonly kind?: 'cron'` 和方法）

```ts
  /** 会话类别（'cron' 或 undefined）。SessionService.persist 据此写入 SessionRecord.kind。 */
  getKind(): 'cron' | undefined { return this.kind }
```

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @zouyj/zuse-server exec tsc --noEmit`
Expected: EXIT 0

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/session/SessionManager.ts
git commit -m "feat(server): SessionManager carries optional kind ('cron') + getKind()"
```

### Task 4：createSession 支持 permissionMode + kind

**Files:**
- Modify: `packages/server/src/session/createSession.ts`（`CreateSessionOpts` ~line 30-62；构造 SessionManager ~line 142-164）

- [ ] **Step 1: opts 加字段**（`CreateSessionOpts` 内）

```ts
  /**
   * 非交互权限档位（cron 等无人看管会话）。给了即以 { interactive:false, config:{...settings.permissions,
   * defaultMode: permissionMode } } 建会话：ask→立即 deny(不卡死)，deny 表恒拦(硬底线)，defaultMode
   * 决定放行面。缺省(undefined) → 交互式 { interactive:true, config: settings.permissions }。
   */
  permissionMode?: import('@zuse/core').PermissionMode
  /** 会话类别标记（透传给 SessionManager；'cron' 会从普通会话列表过滤）。 */
  kind?: 'cron'
```

- [ ] **Step 2: 据 permissionMode 算 permissionPolicy 并传 kind**（替换 `new SessionManager({...})` 里的 `permissionPolicy: { interactive: true, config: settings.permissions },` 一行，并加 `kind`）

```ts
    permissionPolicy: opts.permissionMode
      ? { interactive: false, config: { ...settings.permissions, defaultMode: opts.permissionMode } }
      : { interactive: true, config: settings.permissions },
    kind: opts.kind,
```

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @zouyj/zuse-server exec tsc --noEmit`
Expected: EXIT 0

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/session/createSession.ts
git commit -m "feat(server): createSession accepts permissionMode (non-interactive) + kind"
```

### Task 5：sessionStore 记 kind + list 过滤 cron

**Files:**
- Modify: `packages/server/src/session/sessionStore.ts`（`SessionRecord` ~line 28-47；`listSessions` build ~line 186-198）
- Test: `packages/server/src/session/sessionStore.test.ts`（若存在则加用例；否则新建）

- [ ] **Step 1: 写失败测试**（加到 sessionStore 测试文件；若无则建 `sessionStore.test.ts`）

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveSession, listSessions, type SessionRecord } from './sessionStore.js'
import { emptyUsage } from '@zuse/core'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sess-')) })
const rec = (over: Partial<SessionRecord>): SessionRecord => ({
  version: 1, id: 'a', title: 't', cwd: '/tmp', createdAt: 'c', updatedAt: 'u',
  messages: [{ role: 'user', id: 'm1', content: [{ type: 'text', text: 'hi' }] }],
  totalUsage: emptyUsage(), checkpoints: [], ...over,
})

it("listSessions hides kind:'cron' sessions", async () => {
  await saveSession(dir, rec({ id: 'normal' }))
  await saveSession(dir, rec({ id: 'cronrun', kind: 'cron' }))
  const ids = (await listSessions(dir)).map((m) => m.id)
  expect(ids).toContain('normal')
  expect(ids).not.toContain('cronrun')
})
```

- [ ] **Step 2: 跑确认失败**

Run: `pnpm exec vitest run packages/server/src/session/sessionStore.test.ts`
Expected: FAIL（`kind` 不是 SessionRecord 字段 / cron 未过滤）

- [ ] **Step 3: 加 kind 字段**（`SessionRecord` 内，`compaction?` 附近）

```ts
  /** 'cron' = 定时任务跑出的会话；listSessions 会过滤掉，不进普通侧边栏。 */
  kind?: 'cron'
```

- [ ] **Step 4: listSessions 过滤 cron**（`listSessions` 的 build 回调里，通过字段校验后、`return {...}` 之前加一行）

```ts
    if (r.kind === 'cron') return null // cron-run sessions never show in the normal list
```

- [ ] **Step 5: 跑确认通过**

Run: `pnpm exec vitest run packages/server/src/session/sessionStore.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/session/sessionStore.ts packages/server/src/session/sessionStore.test.ts
git commit -m "feat(server): SessionRecord.kind; listSessions filters out kind:'cron'"
```

### Task 6：SessionService — create 透传 kind/permissionMode、persist 写 kind、release()

**Files:**
- Modify: `packages/server/src/session/SessionService.ts`（create ~130-156；getOrLoad ~93-113；persist rec ~276-291；末尾加 release）
- Test: `packages/server/src/session/SessionService.test.ts`（加用例）

- [ ] **Step 1: 写失败测试**（用现有测试里的离线 fake-client createSession 注入方式；参照该文件已有 helper 构造 SessionService）

```ts
it("create({kind:'cron'}) persists kind and release() drops the live manager but keeps the file", async () => {
  // 依该测试文件既有的 SessionService 构造 helper（fake createSession）建 svc；此处示意断言：
  const { id } = await svc.create({ cwd: '/tmp', permissionMode: 'bypassPermissions', kind: 'cron' })
  const mgr = await svc.getOrLoad(id)
  expect(mgr!.getKind()).toBe('cron')
  svc.release(id)
  // release 后 registry 无它，但 getOrLoad 仍能从盘重建（若已持久化）——此处只断言 release 不抛、不删文件
  expect(typeof svc.release).toBe('function')
})
```

> 注：本用例主要锁 `create` 接受 `kind`/`permissionMode`、`getKind()` 透传、`release` 存在且不抛。持久化断言依赖真实 turn，留给 Playwright/CronScheduler 测试覆盖。

- [ ] **Step 2: 跑确认失败**

Run: `pnpm exec vitest run packages/server/src/session/SessionService.test.ts`
Expected: FAIL（create 不接受 permissionMode/kind、无 release）

- [ ] **Step 3: create 加 opts 并透传**（改 `create` 签名与内部 `this.createSession({...})`）

```ts
  async create(opts?: { cwd?: string; title?: string; permissionMode?: import('@zuse/core').PermissionMode; kind?: 'cron' }): Promise<{ id: string }> {
    const id = newSessionId()
    const cwd = opts?.cwd ?? this.cwd
    const mgr = this.createSession({
      sessionId: id,
      cwd,
      permissionMode: opts?.permissionMode,
      kind: opts?.kind,
      registerExtraTools: this.registerExtraTools,
      imageClient: this.imageClient,
      imageModel: this.imageModel,
      readImageBase64: this.readImageBase64,
      expandAttachments: this.expandAttachments,
    })
    this.tombstones.delete(id)
    this.registry.set(id, mgr)
    this.wireAutosave(id, mgr)
    if (opts?.title) this.generatedTitles.set(id, opts.title)
    return { id }
  }
```

- [ ] **Step 4: getOrLoad 透传 rec.kind**（在 getOrLoad 的 `this.createSession({...})` 调用里加一行 `kind: rec.kind,`，紧挨 `createdAt: rec.createdAt,`）

- [ ] **Step 5: persist 写 kind**（在 persist 构造 `rec: SessionRecord` 对象里，`compaction:` 之后加）

```ts
        kind: mgr.getKind(),
```

- [ ] **Step 6: 加 release 方法**（类内，delete 附近）

```ts
  /**
   * 释放一个 live 会话：停 autosave + 从 registry 移除，但**保留**磁盘文件（区别于 delete）。
   * cron 每次 fire 跑完调用它，避免每次触发都往 registry 永久堆一个 SessionManager。
   * 之后 getOrLoad(id) 仍能从盘重建（drill-down 回看）。
   */
  release(id: string): void {
    this.unsubs.get(id)?.()
    this.unsubs.delete(id)
    this.registry.remove(id)
  }
```

- [ ] **Step 7: 跑确认通过**

Run: `pnpm exec vitest run packages/server/src/session/SessionService.test.ts`
Expected: PASS（新用例 + 原有用例；若并行 flaky 见 CLAUDE.md，隔离重跑取证）

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/session/SessionService.ts packages/server/src/session/SessionService.test.ts
git commit -m "feat(server): SessionService create(kind/permissionMode) + persist kind + release()"
```

---

## Phase 3：CronScheduler（croner 引擎）

### Task 7：加 croner 依赖

**Files:**
- Modify: `packages/server/package.json`（dependencies 加 `"croner"`）

- [ ] **Step 1: 装依赖**

Run: `pnpm --filter @zouyj/zuse-server add croner`
Expected: `croner` 出现在 `packages/server/package.json` 的 dependencies，pnpm-lock 更新。

- [ ] **Step 2: 冒烟验证可 import**

Run: `node --input-type=module -e "import {Cron} from 'croner'; const c=new Cron('0 9 * * *',{paused:true}); console.log(!!c.nextRun()); c.stop()"`
Expected: 打印 `true`

- [ ] **Step 3: Commit**

```bash
git add packages/server/package.json pnpm-lock.yaml
git commit -m "chore(server): add croner (zero-dep cron engine) dependency"
```

### Task 8：CronScheduler

**Files:**
- Create: `packages/server/src/cron/CronScheduler.ts`
- Test: `packages/server/src/cron/CronScheduler.test.ts`

- [ ] **Step 1: 写失败测试**（fire 直接调，不等真实时钟；用 fake sessions）

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CronScheduler, isValidCron } from './CronScheduler.js'
import { loadRuns } from './cronStore.js'
import type { CronTask } from '@zuse/protocol'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cronsch-')) })

const task = (over: Partial<CronTask> = {}): CronTask => ({
  id: 't1', name: 'n', cron: '0 9 * * *', prompt: 'do it', cwd: '/tmp',
  permissionMode: 'bypassPermissions', enabled: true, createdAt: 'c', updatedAt: 'u', ...over,
})

// fake SessionService: create→id, getOrLoad→manager with submit + getState
function fakeSessions(behavior: 'ok' | 'throw' = 'ok') {
  const submit = vi.fn(async () => { if (behavior === 'throw') throw new Error('boom') })
  const mgr = {
    submit,
    getState: () => ({ messages: [{ id: 'm2', role: 'assistant', parts: [{ kind: 'text', text: 'the result' }] }] }),
  }
  const create = vi.fn(async () => ({ id: 'sess-1' }))
  const getOrLoad = vi.fn(async () => mgr)
  const release = vi.fn()
  return { create, getOrLoad, release, submit, mgr } as any
}

describe('isValidCron', () => {
  it('accepts a 5-field expr, rejects garbage', () => {
    expect(isValidCron('0 9 * * *')).toBe(true)
    expect(isValidCron('not a cron')).toBe(false)
  })
})

describe('CronScheduler.fire', () => {
  it('success: creates cron session, submits prompt, records success + summary', async () => {
    const sessions = fakeSessions('ok')
    const sch = new CronScheduler({ dir, sessions })
    await sch.fire(task())
    expect(sessions.create).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/tmp', permissionMode: 'bypassPermissions', kind: 'cron' }))
    expect(sessions.submit).toHaveBeenCalledWith('do it')
    expect(sessions.release).toHaveBeenCalledWith('sess-1')
    const runs = await loadRuns(dir, 't1')
    expect(runs).toHaveLength(1)
    expect(runs[0].status).toBe('success')
    expect(runs[0].summary).toContain('the result')
    expect(runs[0].sessionId).toBe('sess-1')
  })
  it('failure: submit throws → records failed + error, still releases', async () => {
    const sessions = fakeSessions('throw')
    const sch = new CronScheduler({ dir, sessions })
    await sch.fire(task())
    const runs = await loadRuns(dir, 't1')
    expect(runs[0].status).toBe('failed')
    expect(runs[0].error).toContain('boom')
    expect(sessions.release).toHaveBeenCalledWith('sess-1')
  })
})

describe('CronScheduler schedule lifecycle', () => {
  it('start() schedules only enabled tasks; nextRunOf reflects it', async () => {
    const sessions = fakeSessions('ok')
    const sch = new CronScheduler({ dir, sessions })
    sch.setTasks([task({ id: 'on', enabled: true }), task({ id: 'off', enabled: false })])
    expect(sch.nextRunOf('on')).not.toBeNull()
    expect(sch.nextRunOf('off')).toBeNull()
    sch.close()
  })
})
```

- [ ] **Step 2: 跑确认失败**

Run: `pnpm exec vitest run packages/server/src/cron/CronScheduler.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 CronScheduler**

```ts
import { Cron } from 'croner'
import type { CronTask, CronRun } from '@zuse/protocol'
import { newSessionId } from '../session/sessionStore.js'
import { appendRun } from './cronStore.js'

/** CronScheduler 只依赖会话创建/驱动的最小接口（驱动源中立，不 import HTTP/WS）。 */
export interface CronSessions {
  create(opts: { cwd: string; permissionMode: CronTask['permissionMode']; kind: 'cron' }): Promise<{ id: string }>
  getOrLoad(id: string): Promise<{ submit(text: string): Promise<void>; getState(): { messages: Array<{ role: string; parts: Array<{ kind: string; text?: string }> }> } } | null>
  release(id: string): void
}

export interface CronSchedulerDeps {
  dir: string                 // cronDir(authDir)
  sessions: CronSessions      // 通常是 SessionService
}

/** cron 表达式是否合法（croner 构造非法表达式会抛）。 */
export function isValidCron(expr: string): boolean {
  try { new Cron(expr, { paused: true }).stop(); return true } catch { return false }
}

/** 取某会话末条 assistant 文本，截断到 ~200 字，作执行结果摘要。 */
function summarize(state: { messages: Array<{ role: string; parts: Array<{ kind: string; text?: string }> }> }): string {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i]
    if (m.role !== 'assistant') continue
    const text = m.parts.filter((p) => p.kind === 'text').map((p) => p.text ?? '').join('').trim()
    if (text) return text.slice(0, 200)
  }
  return ''
}

export class CronScheduler {
  private readonly dir: string
  private readonly sessions: CronSessions
  private readonly jobs = new Map<string, Cron>()

  constructor(deps: CronSchedulerDeps) {
    this.dir = deps.dir
    this.sessions = deps.sessions
  }

  /** 用给定任务集重建调度（停旧、按 enabled 建新）。start() / CRUD 后都走它。 */
  setTasks(tasks: CronTask[]): void {
    for (const job of this.jobs.values()) job.stop()
    this.jobs.clear()
    for (const t of tasks) if (t.enabled) this.schedule(t)
  }

  private schedule(task: CronTask): void {
    if (!isValidCron(task.cron)) return // 非法表达式：跳过调度（CronService 建时已 400 挡住，这是兜底）
    // 不传 timezone → 本机时区；protect:true → 同任务上次未跑完则跳过本次（不堆叠并发）。
    const job = new Cron(task.cron, { protect: true }, () => { void this.fire(task) })
    this.jobs.set(task.id, job)
  }

  /** 某任务下次执行时间（未调度 → null）。 */
  nextRunOf(taskId: string): string | null {
    const d = this.jobs.get(taskId)?.nextRun() ?? null
    return d ? d.toISOString() : null
  }

  /** 到点（或手动"立即执行"）：开全新 cron 会话跑一轮、记 run。绝不抛（吞错记 failed）。 */
  async fire(task: CronTask): Promise<void> {
    const runId = newSessionId()
    const startedAt = new Date().toISOString()
    const { id: sessionId } = await this.sessions.create({ cwd: task.cwd, permissionMode: task.permissionMode, kind: 'cron' })
    const base: CronRun = { id: runId, taskId: task.id, startedAt, status: 'running', sessionId }
    await appendRun(this.dir, base)
    try {
      const mgr = await this.sessions.getOrLoad(sessionId)
      if (!mgr) throw new Error('cron session vanished after create')
      await mgr.submit(task.prompt)
      await appendRun(this.dir, { ...base, status: 'success', finishedAt: new Date().toISOString(), summary: summarize(mgr.getState()) })
    } catch (err) {
      await appendRun(this.dir, { ...base, status: 'failed', finishedAt: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) })
    } finally {
      this.sessions.release(sessionId)
    }
  }

  /** daemon 关停：停掉所有 croner 定时器。 */
  close(): void {
    for (const job of this.jobs.values()) job.stop()
    this.jobs.clear()
  }
}
```

- [ ] **Step 4: 跑确认通过**

Run: `pnpm exec vitest run packages/server/src/cron/CronScheduler.test.ts`
Expected: PASS（5 用例）

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cron/CronScheduler.ts packages/server/src/cron/CronScheduler.test.ts
git commit -m "feat(server): CronScheduler — croner engine, fire→fresh cron session→submit→record run"
```

---

## Phase 4：CronService + REST

### Task 9：CronService

**Files:**
- Create: `packages/server/src/cron/CronService.ts`
- Test: `packages/server/src/cron/CronService.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CronService } from './CronService.js'
import { loadTasks } from './cronStore.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cronsvc-')) })

function fakeScheduler() {
  return { setTasks: vi.fn(), nextRunOf: vi.fn(() => '2026-07-25T09:00:00.000Z'), fire: vi.fn(async () => {}), close: vi.fn() } as any
}

describe('CronService CRUD', () => {
  it('create: fills id/timestamps/defaults, persists, reschedules, returns with nextRun', async () => {
    const scheduler = fakeScheduler()
    const svc = new CronService({ dir, scheduler, defaultCwd: '/tmp' })
    const t = await svc.create({ name: 'n', cron: '0 9 * * *', prompt: 'p' })
    expect(t.id).toBeTruthy()
    expect(t.enabled).toBe(true)
    expect(t.permissionMode).toBe('bypassPermissions')  // 默认全自主
    expect(t.cwd).toBe('/tmp')
    expect(t.nextRun).toBe('2026-07-25T09:00:00.000Z')
    expect((await loadTasks(dir)).map((x) => x.id)).toEqual([t.id])
    expect(scheduler.setTasks).toHaveBeenCalled()
  })
  it('create: invalid cron throws (route maps to 400)', async () => {
    const svc = new CronService({ dir, scheduler: fakeScheduler(), defaultCwd: '/tmp' })
    await expect(svc.create({ name: 'n', cron: 'garbage', prompt: 'p' })).rejects.toThrow(/cron/i)
  })
  it('update + delete', async () => {
    const scheduler = fakeScheduler()
    const svc = new CronService({ dir, scheduler, defaultCwd: '/tmp' })
    const t = await svc.create({ name: 'n', cron: '0 9 * * *', prompt: 'p' })
    const u = await svc.update(t.id, { enabled: false })
    expect(u!.enabled).toBe(false)
    await svc.delete(t.id)
    expect(await loadTasks(dir)).toEqual([])
  })
  it('runNow calls scheduler.fire with the task', async () => {
    const scheduler = fakeScheduler()
    const svc = new CronService({ dir, scheduler, defaultCwd: '/tmp' })
    const t = await svc.create({ name: 'n', cron: '0 9 * * *', prompt: 'p' })
    await svc.runNow(t.id)
    expect(scheduler.fire).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }))
  })
})
```

- [ ] **Step 2: 跑确认失败**

Run: `pnpm exec vitest run packages/server/src/cron/CronService.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 CronService**

```ts
import type { CronTask, CronTaskInput, CronTaskWithNext, CronRun, CronRunDetail } from '@zuse/protocol'
import { newSessionId } from '../session/sessionStore.js'
import { loadTasks, saveTasks, loadRuns, deleteTaskRuns } from './cronStore.js'
import { CronScheduler, isValidCron } from './CronScheduler.js'

export interface CronServiceSessions {
  getOrLoad(id: string): Promise<{ getState(): { messages: unknown[] } } | null>
  release(id: string): void
}

export interface CronServiceDeps {
  dir: string
  scheduler: CronScheduler
  defaultCwd: string
  /** 供 getRunDetail 取会话消息投影（drill-down）。可选：缺省则 detail.messages=[]（测试无需）。 */
  sessions?: CronServiceSessions
}

export class CronService {
  constructor(private readonly deps: CronServiceDeps) {}

  private withNext(t: CronTask): CronTaskWithNext { return { ...t, nextRun: this.deps.scheduler.nextRunOf(t.id) } }

  async list(): Promise<CronTaskWithNext[]> {
    return (await loadTasks(this.deps.dir)).map((t) => this.withNext(t))
  }

  async create(input: CronTaskInput): Promise<CronTaskWithNext> {
    if (!input.name?.trim()) throw new Error('name is required')
    if (!input.prompt?.trim()) throw new Error('prompt is required')
    if (!isValidCron(input.cron)) throw new Error(`invalid cron expression: "${input.cron}"`)
    const now = new Date().toISOString()
    const task: CronTask = {
      id: newSessionId(), name: input.name, cron: input.cron, prompt: input.prompt,
      cwd: input.cwd ?? this.deps.defaultCwd,
      permissionMode: input.permissionMode ?? 'bypassPermissions',
      enabled: input.enabled ?? true, createdAt: now, updatedAt: now,
    }
    const tasks = await loadTasks(this.deps.dir)
    tasks.push(task)
    await saveTasks(this.deps.dir, tasks)
    this.deps.scheduler.setTasks(tasks)
    return this.withNext(task)
  }

  async update(id: string, patch: Partial<CronTaskInput>): Promise<CronTaskWithNext | null> {
    if (patch.cron !== undefined && !isValidCron(patch.cron)) throw new Error(`invalid cron expression: "${patch.cron}"`)
    const tasks = await loadTasks(this.deps.dir)
    const i = tasks.findIndex((t) => t.id === id)
    if (i < 0) return null
    tasks[i] = {
      ...tasks[i],
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.cron !== undefined ? { cron: patch.cron } : {}),
      ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
      ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
      ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedAt: new Date().toISOString(),
    }
    await saveTasks(this.deps.dir, tasks)
    this.deps.scheduler.setTasks(tasks)
    return this.withNext(tasks[i])
  }

  async delete(id: string): Promise<void> {
    const tasks = (await loadTasks(this.deps.dir)).filter((t) => t.id !== id)
    await saveTasks(this.deps.dir, tasks)
    await deleteTaskRuns(this.deps.dir, id)
    this.deps.scheduler.setTasks(tasks)
  }

  async listRuns(taskId: string): Promise<CronRun[]> { return loadRuns(this.deps.dir, taskId) }

  async runNow(id: string): Promise<void> {
    const task = (await loadTasks(this.deps.dir)).find((t) => t.id === id)
    if (!task) throw new Error(`no such cron task: ${id}`)
    await this.deps.scheduler.fire(task)
  }

  /** 某次执行详情：run + 那次会话的消息投影（复用现有 SnapshotMessage 渲染）。 */
  async getRunDetail(taskId: string, runId: string): Promise<CronRunDetail | null> {
    const run = (await loadRuns(this.deps.dir, taskId)).find((r) => r.id === runId)
    if (!run) return null
    let messages: CronRunDetail['messages'] = []
    if (this.deps.sessions) {
      const mgr = await this.deps.sessions.getOrLoad(run.sessionId)
      if (mgr) { messages = mgr.getState().messages as CronRunDetail['messages']; this.deps.sessions.release(run.sessionId) }
    }
    return { run, messages }
  }
}
```

- [ ] **Step 4: 跑确认通过**

Run: `pnpm exec vitest run packages/server/src/cron/CronService.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cron/CronService.ts packages/server/src/cron/CronService.test.ts
git commit -m "feat(server): CronService — task CRUD + runs + runNow + run detail"
```

### Task 10：REST /api/cron

**Files:**
- Modify: `packages/server/src/http/server.ts`（`RequestHandlerDeps` ~line 24-41 加 `cron`；在 `/api/mcp` 路由块附近、其他 `/api/*` 之间插入 cron 路由）
- Test: `packages/server/src/http/server.test.ts`（若存在，加 cron 路由用例，仿 mcp/sessions 用例）

- [ ] **Step 1: deps 加 cron**（`RequestHandlerDeps` 内，`mcp: McpService` 之后）

```ts
  cron: import('../cron/CronService.js').CronService
```

- [ ] **Step 2: 挂路由**（在 `handle()` 里，其它 `/api/*` 路由之间插入；每条先 `if (!isAuthed(req)) return sendJson(res, 401, {...})`，仿 line 237/245 的 /api/sessions；`decodeURIComponent` 取 id 仿 /api/sessions/<id>）

```ts
    // GET /api/cron — list tasks (+nextRun)
    if (method === 'GET' && path === '/api/cron') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      return sendJson(res, 200, await deps.cron.list())
    }
    // POST /api/cron — create
    if (method === 'POST' && path === '/api/cron') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      let body: import('@zuse/protocol').CronTaskInput
      try { body = (await readJsonBody(req)) as typeof body } catch { return sendJson(res, 400, { error: { code: 'bad_request', message: 'invalid body' } }) }
      try { return sendJson(res, 200, await deps.cron.create(body)) }
      catch (e) { return sendJson(res, 400, { error: { code: 'bad_request', message: e instanceof Error ? e.message : String(e) } }) }
    }
    // POST /api/cron/<id>/run — fire now (before the PATCH/DELETE prefix routes)
    if (method === 'POST' && path.startsWith('/api/cron/') && path.endsWith('/run')) {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      const id = decodeURIComponent(path.slice('/api/cron/'.length, -'/run'.length))
      try { await deps.cron.runNow(id); return sendJson(res, 200, { ok: true }) }
      catch (e) { return sendJson(res, 400, { error: { code: 'bad_request', message: e instanceof Error ? e.message : String(e) } }) }
    }
    // GET /api/cron/<taskId>/runs — execution history
    if (method === 'GET' && path.startsWith('/api/cron/') && path.endsWith('/runs')) {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      const id = decodeURIComponent(path.slice('/api/cron/'.length, -'/runs'.length))
      try { return sendJson(res, 200, await deps.cron.listRuns(id)) }
      catch { return sendJson(res, 400, { error: { code: 'bad_request', message: 'invalid id' } }) }
    }
    // GET /api/cron/<taskId>/runs/<runId> — run detail (session snapshot)
    if (method === 'GET' && path.startsWith('/api/cron/') && path.includes('/runs/')) {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      const rest = path.slice('/api/cron/'.length)                  // "<taskId>/runs/<runId>"
      const [taskId, , runId] = rest.split('/')
      try {
        const detail = await deps.cron.getRunDetail(decodeURIComponent(taskId), decodeURIComponent(runId ?? ''))
        return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: { code: 'not_found', message: 'run not found' } })
      } catch { return sendJson(res, 400, { error: { code: 'bad_request', message: 'invalid id' } }) }
    }
    // PATCH /api/cron/<id> — update
    if (method === 'PATCH' && path.startsWith('/api/cron/')) {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      const id = decodeURIComponent(path.slice('/api/cron/'.length))
      let body: Partial<import('@zuse/protocol').CronTaskInput>
      try { body = (await readJsonBody(req)) as typeof body } catch { return sendJson(res, 400, { error: { code: 'bad_request', message: 'invalid body' } }) }
      try { const t = await deps.cron.update(id, body); return t ? sendJson(res, 200, t) : sendJson(res, 404, { error: { code: 'not_found', message: 'task not found' } }) }
      catch (e) { return sendJson(res, 400, { error: { code: 'bad_request', message: e instanceof Error ? e.message : String(e) } }) }
    }
    // DELETE /api/cron/<id> — delete
    if (method === 'DELETE' && path.startsWith('/api/cron/')) {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      const id = decodeURIComponent(path.slice('/api/cron/'.length))
      try { await deps.cron.delete(id); return sendJson(res, 200, { ok: true }) }
      catch { return sendJson(res, 400, { error: { code: 'bad_request', message: 'invalid id' } }) }
    }
```

> **路由顺序要点**：`/run`、`/runs`、`/runs/<runId>` 三条更具体的必须排在 `PATCH/DELETE /api/cron/<id>` 前缀路由**之前**，否则会被前缀吞掉。GET `/runs/<runId>` 用 `.includes('/runs/')` 且排在 GET `/runs`(endsWith) 之后——`endsWith('/runs')` 对 `.../runs/<id>` 为 false，故不冲突。

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @zouyj/zuse-server exec tsc --noEmit`
Expected: EXIT 0

- [ ] **Step 4: （若 server.test.ts 存在）加路由用例并跑**

仿其中 `/api/mcp`、`/api/sessions` 的用例：注入一个 fake `cron`（实现 list/create/update/delete/listRuns/runNow/getRunDetail），断言鉴权(未登录→401)、create 非法 cron→400、CRUD 往返、`/run` 触发。

Run: `pnpm exec vitest run packages/server/src/http/server.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/http/server.ts packages/server/src/http/server.test.ts
git commit -m "feat(server): /api/cron REST (list/create/update/delete/runs/run/detail)"
```

### Task 11：daemon 接线（startServer）

**Files:**
- Modify: `packages/server/src/startServer.ts`（实例化处 ~line 172-190；makeRequestHandler deps ~line 190；close ~line 200-206）

- [ ] **Step 1: 实例化 CronScheduler + CronService**（在 `const mcpService = ...` 附近加）

```ts
  // Cron 定时任务 (C1/C2)：调度器与 WS 平级驱动 SessionService；数据在 ~/.zuse/cron/。
  const { CronScheduler } = await import('./cron/CronScheduler.js')
  const { CronService } = await import('./cron/CronService.js')
  const { cronDir, loadTasks } = await import('./cron/cronStore.js')
  const cronDataDir = cronDir(cfg.authDir)
  const cronScheduler = new CronScheduler({ dir: cronDataDir, sessions: service })
  try { cronScheduler.setTasks(await loadTasks(cronDataDir)) } // 启动即调度已启用任务；漏触发不补(croner 从现在排)
  catch (err) { console.warn(`[zuse-server] cron 调度启动失败:${err instanceof Error ? err.message : String(err)}`) }
  const cronService = new CronService({ dir: cronDataDir, scheduler: cronScheduler, defaultCwd: cfg.cwd, sessions: service })
```

> 用静态 `import { CronScheduler } from './cron/CronScheduler.js'` 也可；此处示意为顶部普通 import 即可（放文件顶部 import 区更佳，与其它 service 一致——实现时按现有风格提到顶部）。

- [ ] **Step 2: 传入 handler**（`makeRequestHandler({ ... })` 的对象里加 `cron: cronService,`）

- [ ] **Step 3: close 时停调度**（返回对象的 `close` 里，`void lsp.dispose()...` 附近加）

```ts
      cronScheduler.close()
```

- [ ] **Step 4: typecheck + server 全量单测**

Run: `pnpm --filter @zouyj/zuse-server exec tsc --noEmit`
Expected: EXIT 0
Run: `pnpm exec vitest run packages/server`
Expected: PASS（`SessionService.test` 并行 flaky 则隔离重跑取证，见 CLAUDE.md）

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/startServer.ts
git commit -m "feat(server): wire CronScheduler + CronService into the daemon"
```

---

## Phase 5：前端面板（C2）

### Task 12：cronApi 客户端

**Files:**
- Create: `packages/web/src/state/cronApi.ts`

- [ ] **Step 1: 实现**（复用 `session.ts` 的 `request`；仿 `manageApi.ts` 的函数样式与 `JSON_HEADERS`）

```ts
import type { CronTaskWithNext, CronTaskInput, CronRun, CronRunDetail } from '@zuse/protocol'
import { request } from './session.js'

const JSON_HEADERS = { 'content-type': 'application/json' }
const enc = encodeURIComponent

export async function listCronTasks(): Promise<CronTaskWithNext[]> {
  return (await (await request('/api/cron', {}, 'list cron')).json()) as CronTaskWithNext[]
}
export async function createCronTask(body: CronTaskInput): Promise<CronTaskWithNext> {
  return (await (await request('/api/cron', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }, 'create cron')).json()) as CronTaskWithNext
}
export async function updateCronTask(id: string, body: Partial<CronTaskInput>): Promise<CronTaskWithNext> {
  return (await (await request(`/api/cron/${enc(id)}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) }, 'update cron')).json()) as CronTaskWithNext
}
export async function deleteCronTask(id: string): Promise<void> {
  await request(`/api/cron/${enc(id)}`, { method: 'DELETE' }, 'delete cron')
}
export async function listCronRuns(taskId: string): Promise<CronRun[]> {
  return (await (await request(`/api/cron/${enc(taskId)}/runs`, {}, 'list cron runs')).json()) as CronRun[]
}
export async function runCronNow(id: string): Promise<void> {
  await request(`/api/cron/${enc(id)}/run`, { method: 'POST' }, 'run cron now')
}
export async function getCronRunDetail(taskId: string, runId: string): Promise<CronRunDetail> {
  return (await (await request(`/api/cron/${enc(taskId)}/runs/${enc(runId)}`, {}, 'cron run detail')).json()) as CronRunDetail
}
```

> 核对 `request` 的确切签名/返回（`session.ts:33` `request(path, init, label): Promise<Response>`）与 `manageApi.ts` 是否已导出 `JSON_HEADERS`（若已导出则复用，别重复定义）。

- [ ] **Step 2: web typecheck**

Run: `pnpm --filter @zuse/web exec tsc --noEmit`
Expected: EXIT 0

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/state/cronApi.ts
git commit -m "feat(web): cronApi client (tasks CRUD + runs + runNow + detail)"
```

### Task 13：store 加 mainView 切换

**Files:**
- Modify: `packages/web/src/state/store.tsx`（`Store` 接口 + `StoreProvider` 内 useState + Provider value）

- [ ] **Step 1: Store 接口加**（仿 `pendingScrollTo` 那组）

```ts
  /** 主区视图：'chat'（默认聊天）或 'cron'（定时任务面板）。 */
  mainView: 'chat' | 'cron'
  /** 切主区视图。切到 chat 由点会话/新会话触发；切到 cron 由侧边栏入口触发。 */
  setMainView: (v: 'chat' | 'cron') => void
```

- [ ] **Step 2: Provider 内 state + 接入 value**

```ts
  const [mainView, setMainView] = useState<'chat' | 'cron'>('chat')
```
并在 `attachTo(id)`（切/建会话）里 `setMainView('chat')`（切回聊天），在 Provider value 里加 `mainView, setMainView`。

- [ ] **Step 3: web typecheck**

Run: `pnpm --filter @zuse/web exec tsc --noEmit`
Expected: EXIT 0

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/state/store.tsx
git commit -m "feat(web): store mainView ('chat'|'cron') for main-area view switch"
```

### Task 14：CronPanel 组件

**Files:**
- Create: `packages/web/src/components/CronPanel.tsx`
- Test: `packages/web/src/components/CronPanel.test.tsx`

**结构**（单文件内四个视图，仿 `McpPanel.tsx` 的自包含面板 + 内联确认 + `useState` 局部导航；参照它的样式与交互约定）：

- `CronPanel`：顶层，`useState<view>`：`{ kind:'list' } | { kind:'runs', task } | { kind:'detail', task, runId }`。
- `CronTasksView(props: { onOpen(task) })`：`useEffect` 拉 `listCronTasks()`；渲染每任务行：名称、人读调度(`describeCron(cron)`)、`nextRun` 相对时间、`enabled` 开关(调 `updateCronTask(id,{enabled})`)、编辑(展开 `CronTaskForm`)、删除(内联确认→`deleteCronTask`)、**立即执行**(`runCronNow`)、点行进 runs；顶部 `+ 新建`(展开 `CronTaskForm`)。
- `CronTaskForm(props: { initial?, onSaved, onCancel })`：字段 name / prompt(textarea) / 调度(预设下拉→编译 cron，或"自定义"直填) / cwd(可复用 `DirPicker`，缺省 daemon cwd) / permissionMode(下拉，默认 `bypassPermissions`，带警示副本) / enabled；提交调 `createCronTask`/`updateCronTask`，400 错误显示服务端 message。
- `CronRunsView(props: { task, onOpen(runId) })`：拉 `listCronRuns(task.id)`；每行 label = 执行内容摘要(task.prompt 截断) + 结果摘要(run.summary)；状态图标：`running`→转圈、`success`→✓(绿)、`failed`→✕(红)；点行进 detail。
- `CronRunDetail(props: { task, runId })`：拉 `getCronRunDetail(task.id, runId)`；用现有消息渲染组件（`MessageList` 或 `Message`，与聊天流同款）渲染 `detail.messages`（`SnapshotMessage[]` → 现有 part 渲染）。

**调度预设编译**（面板内纯函数，务必与后端 5 段语义一致）：
```ts
// 预设 → cron。HH:MM 拆成 M H。
export function presetToCron(p: { kind: 'hourly' } | { kind: 'daily'; h: number; m: number }
  | { kind: 'weekly'; dow: number; h: number; m: number } | { kind: 'monthly'; dom: number; h: number; m: number }
  | { kind: 'custom'; expr: string }): string {
  switch (p.kind) {
    case 'hourly': return '0 * * * *'
    case 'daily': return `${p.m} ${p.h} * * *`
    case 'weekly': return `${p.m} ${p.h} * * ${p.dow}`
    case 'monthly': return `${p.m} ${p.h} ${p.dom} * *`   // day-of-month（用户点名要）
    case 'custom': return p.expr
  }
}
```

**人读描述** `describeCron(expr)`：对上述五种形状反显（如 `0 9 * * *`→"每天 09:00"、`30 8 1 * *`→"每月 1 号 08:30"），无法匹配则原样返回表达式。

- [ ] **Step 1: 写失败测试**（web 包内，仿 `TodosPanel.test.tsx`/`McpPanel` 的 render 测试；mock `cronApi`）

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { CronPanel } from './CronPanel.js'
import { presetToCron, describeCron } from './CronPanel.js'

vi.mock('../state/cronApi.js', () => ({
  listCronTasks: vi.fn(async () => [{ id: 't1', name: '每日汇总', cron: '0 9 * * *', prompt: 'p', cwd: '/tmp', permissionMode: 'bypassPermissions', enabled: true, createdAt: 'c', updatedAt: 'u', nextRun: '2026-07-25T09:00:00.000Z' }]),
  listCronRuns: vi.fn(async () => []), runCronNow: vi.fn(), createCronTask: vi.fn(), updateCronTask: vi.fn(), deleteCronTask: vi.fn(), getCronRunDetail: vi.fn(),
}))

describe('presetToCron / describeCron', () => {
  it('monthly compiles to day-of-month and round-trips readably', () => {
    expect(presetToCron({ kind: 'monthly', dom: 1, h: 8, m: 30 })).toBe('30 8 1 * *')
    expect(describeCron('0 9 * * *')).toMatch(/每天.*09:00/)
  })
})

describe('CronTasksView', () => {
  it('lists tasks with human-readable schedule', async () => {
    render(<CronPanel />)
    await waitFor(() => expect(screen.getByText('每日汇总')).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: 跑确认失败**

Run: `cd packages/web && pnpm exec vitest run src/components/CronPanel.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现 CronPanel.tsx**（按上述结构；导出 `CronPanel`、`presetToCron`、`describeCron`；样式与交互仿 `McpPanel.tsx`；消息渲染复用聊天流同款组件——实现时读 `Shell.tsx`/`MessageList` 确认可复用的组件名与 props）。

- [ ] **Step 4: 跑确认通过**

Run: `cd packages/web && pnpm exec vitest run src/components/CronPanel.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/CronPanel.tsx packages/web/src/components/CronPanel.test.tsx
git commit -m "feat(web): CronPanel — tasks list / form / runs / run detail"
```

### Task 15：侧边栏入口 + Shell 主区切换

**Files:**
- Modify: `packages/web/src/components/Sidebar.tsx`（"新会话"按钮下方加入口）
- Modify: `packages/web/src/components/Shell.tsx`（`mainView==='cron'` 时主区渲染 `CronPanel`）

- [ ] **Step 1: Sidebar 入口**（在新建会话按钮之后加一个按钮；点击调 `setMainView('cron')`——通过 props 或 `useStore()`，按 Sidebar 现有取数据方式）

```tsx
{/* 定时任务入口：切主区为 cron 视图 */}
<button className="cron-entry" onClick={() => setMainView('cron')} title="定时任务">⏰ 定时任务</button>
```

- [ ] **Step 2: Shell 主区分支**（Shell 里当前渲染聊天流的地方，按 `mainView` 分支）

```tsx
{mainView === 'cron' ? <CronPanel /> : (/* 现有聊天流：MessageList + Composer 等原样 */)}
```
`mainView` 与 `setMainView` 从 `useStore()` 取。

- [ ] **Step 3: web typecheck + 包内全量单测**

Run: `pnpm --filter @zuse/web exec tsc --noEmit`
Expected: EXIT 0
Run: `cd packages/web && pnpm exec vitest run`
Expected: PASS（全部 web 用例）

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/Sidebar.tsx packages/web/src/components/Shell.tsx
git commit -m "feat(web): sidebar cron entry + Shell renders CronPanel when mainView==='cron'"
```

---

## Phase 6：/ship

### Task 16：全绿收口 + 合并

- [ ] **Step 1: 调用 ship 技能**

Invoke the `ship` skill (Skill 工具)，参数：
`分支 cron-scheduler → 本地 master。C1/C2 定时任务，横切 protocol/server/web(不改 core)。重点核对:①CronScheduler 传输无关、fire 成败都 release 不泄漏 ②路由具体路径(/run,/runs,/runs/<id>)排在 PATCH/DELETE 前缀之前不被吞 ③cron 会话 kind:'cron' 确从普通侧边栏过滤 ④权限 interactive:false + defaultMode(默认 bypassPermissions)、全局 deny 恒拦 ⑤croner 新依赖 bundle 进 dist。web 有改动→Playwright(密码 zuonaok):侧边栏点定时任务→建任务(默认档)→立即执行→执行列表出现一条→转 success→点进去看到完整对话;cron 会话不出现在普通会话侧边栏。SessionService.test 并行 flaky 隔离重跑取证。`

- [ ] **Step 2: ship 通过后**，确认本地 master 已含 cron，工作区干净。（push 需用户明示——不自动 push。）

---

## Self-Review（写完计划回看 spec）

**1. Spec 覆盖**：
- §2 会话模型(全新会话+kind+过滤) → Task 3-6, 8。 ✓
- §2 执行留档(CronRun jsonl + 钻取) → Task 2, 8, 9(getRunDetail), 14(CronRunDetail)。 ✓
- §2 调度格式(5 段 cron + 预设含 day-of-month) → Task 8(isValidCron/croner), 14(presetToCron monthly)。 ✓
- §2 引擎 croner / 防重叠 protect / 漏触发不补 → Task 7, 8(protect:true / setTasks 从现在排)。 ✓
- §5 权限(每任务 permissionMode / interactive:false / 默认 bypass / deny 硬底线) → Task 4, 6, 9(默认 bypassPermissions)。 ✓
- §6 调度生命周期(start/CRUD 重排/close) → Task 8(setTasks/close), 9(CRUD→setTasks), 11(启动 setTasks/close)。 ✓
- §6.4 B2 接缝(通用 fire 原语) → Task 8 的 fire 已是通用原语；B2 分支不实现。 ✓(非目标)
- §8 REST 全端点 + 鉴权 + 400 → Task 10。 ✓
- §9 面板(mainView 切换/侧边栏入口/四视图/预设/状态图标/立即执行) → Task 13, 14, 15。 ✓
- §11 测试策略 → 各 Task 的 TDD + Task 16 Playwright。 ✓

**2. 占位符扫描**：无 TBD/TODO；每个 code step 有完整代码；web 面板组件给了结构+关键纯函数(presetToCron/describeCron)完整代码 + 精确 props/视图规格 + 测试，并指向 McpPanel/MessageList 作结构范本(大型现存代码库按既有模式实现)。

**3. 类型一致性**：`CronTask`/`CronRun`/`CronTaskInput`/`CronTaskWithNext`/`CronRunDetail` 在 protocol 定义(Task 1)，server/web 全程引用同名；`permissionMode` 默认 `'bypassPermissions'` 在 Task 9 CronService.create 落地、与 spec §5 一致；`kind:'cron'` 在 SessionManager(Task 3)/createSession(Task 4)/sessionStore(Task 5)/SessionService(Task 6) 一致；`isValidCron` 在 CronScheduler 定义、CronService 复用(Task 8/9)。
