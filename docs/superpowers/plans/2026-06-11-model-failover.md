# 模型额度耗尽自动降级(failover)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 模型调用因额度耗尽/不可用/认证失败而出错时,按 `failoverMode` 设置弹出 `/model` 选择器(坏的标注出来)或自动切到同 provider 下一个可用模型并重发。

**Architecture:** 错误在 client 内部重试耗尽后,带 `category` 透出到 `StreamEvent` 的 `error` 事件;`useConversation` 在「未吐文本」前提下按分类与 `failoverMode` 决定降级动作;降级决策抽成纯函数 `failoverCore` 单测;坏模型记内存 `Map`(刷新即清),`/model` picker 灰显标注。降级动作在流循环结束后触发,绝不在 `for await` 内重入。

**Tech Stack:** TypeScript(strict)、pnpm workspace、Vitest、ink(TUI)、Vercel 无关。`packages/core` + `packages/tui`。

设计依据:[docs/superpowers/specs/2026-06-11-model-failover-design.md](../specs/2026-06-11-model-failover-design.md)

**通用命令:**
- 单文件测试:`pnpm exec vitest run <文件路径>`
- 全量测试:`pnpm test`
- 类型检查:`pnpm -F @zuse/core typecheck` / `pnpm -F @zuse/tui typecheck`
- 构建:`pnpm build`

---

## Task 1: 错误分类类型与 classifyError(core)

**Files:**
- Modify: `packages/core/src/types.ts`(`StreamEvent` 的 error 变体 + 新增 `ErrorCategory`)
- Modify: `packages/core/src/retry.ts`(新增 `classifyError`)
- Test: `packages/core/src/retry.test.ts`(追加 describe)

- [ ] **Step 1: 在 types.ts 增类型与字段**

修改 `packages/core/src/types.ts`。在 `StreamEvent` 定义上方加 `ErrorCategory`,并把 error 变体替换为带 `status`/`category` 的形状(`category` 设可选,旧代码构造 `{type:'error',message}` 仍合法):

```ts
/** 模型调用错误的归类:供编排层决定是否降级。 */
export type ErrorCategory = 'quota' | 'auth' | 'unavailable' | 'other'
```

把这一行:
```ts
  | { type: 'error'; message: string }
```
替换为:
```ts
  | { type: 'error'; message: string; status?: number; category?: ErrorCategory }
```

- [ ] **Step 2: 写失败测试(classifyError)**

在 `packages/core/src/retry.test.ts` 顶部 import 里加入 `classifyError`(与现有 import 合并),并在文件末尾追加:

```ts
import { classifyError } from './retry.js'

describe('classifyError', () => {
  it('401 → auth', () => {
    expect(classifyError({ status: 401 })).toEqual({ status: 401, category: 'auth' })
  })
  it('402 / 403 / 429 → quota', () => {
    for (const s of [402, 403, 429]) expect(classifyError({ status: s }).category).toBe('quota')
  })
  it('404 / 503 → unavailable', () => {
    for (const s of [404, 503]) expect(classifyError({ status: s }).category).toBe('unavailable')
  })
  it('400 / 422 / 无状态码 → other', () => {
    expect(classifyError({ status: 400 }).category).toBe('other')
    expect(classifyError({ status: 422 }).category).toBe('other')
    expect(classifyError(new Error('network')).category).toBe('other')
  })
  it('也识别 statusCode 字段', () => {
    expect(classifyError({ statusCode: 401 }).category).toBe('auth')
  })
})
```

- [ ] **Step 3: 运行测试,确认失败**

Run: `pnpm exec vitest run packages/core/src/retry.test.ts`
Expected: FAIL —— `classifyError is not a function` / 找不到导出。

- [ ] **Step 4: 实现 classifyError**

在 `packages/core/src/retry.ts` 顶部加类型 import(文件当前无 import,新增一行):

```ts
import type { ErrorCategory } from './types.js'
```

在 `isRetryableError` 函数定义之后追加(复用文件内已有的私有 `readStatus`):

```ts
/**
 * 把「已耗尽重试 / 不可重试」的错误归类,供编排层(useConversation)决定是否降级。
 * 与 isRetryableError 互补:那个判「要不要在 client 内重试」,这个判「最终透出后该怎么处置」。
 */
export function classifyError(err: unknown): { status?: number; category: ErrorCategory } {
  const status = readStatus(err)
  if (status === 401) return { status, category: 'auth' }
  if (status === 402 || status === 403 || status === 429) return { status, category: 'quota' }
  if (status === 404 || status === 503) return { status, category: 'unavailable' }
  return { status, category: 'other' }
}
```

- [ ] **Step 5: 运行测试,确认通过**

Run: `pnpm exec vitest run packages/core/src/retry.test.ts`
Expected: PASS(含原有 retry 测试)。

- [ ] **Step 6: 类型检查 + 提交**

Run: `pnpm -F @zuse/core typecheck`
Expected: 无错误。

```bash
git add packages/core/src/types.ts packages/core/src/retry.ts packages/core/src/retry.test.ts
git commit -m "feat(core): add ErrorCategory + classifyError for failover"
```

---

## Task 2: 两个 client 透出错误分类(core)

**Files:**
- Modify: `packages/core/src/openai-client.ts`(三处 error yield)
- Modify: `packages/core/src/anthropic-client.ts`(三处 error yield,镜像)
- Test: `packages/core/src/openai-client.test.ts`(追加接线测试)

> 说明:`classifyError` 的分类逻辑已在 Task 1 单测覆盖。本任务只验证 client 把它接到了 error 事件上。OpenAIClient 支持注入 fake sdk,故在它上面写集成测试;AnthropicClient 不支持注入,做同款一行改动并由 typecheck 保证形状一致。

- [ ] **Step 1: 写失败测试(OpenAIClient 接线)**

在 `packages/core/src/openai-client.test.ts` 末尾、`describe('OpenAIClient.sendMessages —— 中断与空闲超时', ...)` 之后追加一个新 describe(复用文件内已有的 `fakeSdk` / `PROVIDER` / `CFG` / `MSGS` / `collect`):

```ts
describe('OpenAIClient.sendMessages —— 错误分类透出', () => {
  it('开流即报 402:error 事件带 category=quota、status=402', async () => {
    // 402 不可重试,立即透出;makeStream 抛错 → create reject → client 捕获后分类。
    const sdk = fakeSdk(() => {
      throw Object.assign(new Error('insufficient balance'), { status: 402 })
    })
    const client = new OpenAIClient(PROVIDER, 'm', sdk)
    const events = await collect(client.sendMessages(MSGS, CFG))
    const err = events.find((e) => e.type === 'error') as Extract<StreamEvent, { type: 'error' }>
    expect(err).toBeTruthy()
    expect(err.category).toBe('quota')
    expect(err.status).toBe(402)
  })

  it('401 透出 category=auth', async () => {
    const sdk = fakeSdk(() => {
      throw Object.assign(new Error('invalid key'), { status: 401 })
    })
    const client = new OpenAIClient(PROVIDER, 'm', sdk)
    const events = await collect(client.sendMessages(MSGS, CFG))
    const err = events.find((e) => e.type === 'error') as Extract<StreamEvent, { type: 'error' }>
    expect(err.category).toBe('auth')
  })
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm exec vitest run packages/core/src/openai-client.test.ts`
Expected: FAIL —— `err.category` 为 `undefined`(client 还没附分类)。

- [ ] **Step 3: openai-client.ts 接上分类**

在 `packages/core/src/openai-client.ts` 的 retry import 行加入 `classifyError`(与现有 `isRetryableError, backoffMs, retryAfterMs, sleep` 合并到同一条 import)。

把三处 `yield { type: 'error', message }`(分别在「中断/空闲超时」分支 ~304、「emitted 中途」分支 ~315、「不可重试或重试用尽」分支 ~330)统一改为:

```ts
          yield { type: 'error', message, ...classifyError(err) }
```

(三处 `err` 均在作用域内。中断/空闲超时的 err 无 status → category 自然为 `other`,语义正确。)

- [ ] **Step 4: 运行测试,确认通过**

Run: `pnpm exec vitest run packages/core/src/openai-client.test.ts`
Expected: PASS。

- [ ] **Step 5: anthropic-client.ts 同款改动**

在 `packages/core/src/anthropic-client.ts` 的 retry import 行加入 `classifyError`。把三处 `yield { type: 'error', message }`(~171 中断/空闲、~179 emitted、~191 耗尽)统一改为:

```ts
          yield { type: 'error', message, ...classifyError(err) }
```

- [ ] **Step 6: 全量测试 + 类型检查**

Run: `pnpm exec vitest run packages/core/src/anthropic-client.test.ts packages/core/src/openai-client.test.ts`
Expected: PASS。

Run: `pnpm -F @zuse/core typecheck`
Expected: 无错误。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/openai-client.ts packages/core/src/anthropic-client.ts packages/core/src/openai-client.test.ts
git commit -m "feat(core): clients surface error category for failover"
```

---

## Task 3: failoverMode 设置(core)

**Files:**
- Modify: `packages/core/src/types.ts`(`RawSettings` 没有此处——它在 settings.ts;`ResolvedSettings` 在 types.ts)
- Modify: `packages/core/src/settings.ts`(`RawSettings` 接口、`mergeLayers`、新增 `resolveFailoverMode`)
- Test: `packages/core/src/settings.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/core/src/settings.test.ts` 末尾追加(import 里按需加 `resolveFailoverMode`、`mergeLayers` 若已导出;`mergeLayers` 若未导出则改用 `loadSettings` 配合临时文件——下面用更稳的 `resolveFailoverMode` + 直接构造 settings 对象):

```ts
import { resolveFailoverMode } from './settings.js'
import type { ResolvedSettings } from './types.js'

describe('resolveFailoverMode', () => {
  const base: ResolvedSettings = {
    tools: {},
    permissions: { defaultMode: 'default', allow: [], ask: [], deny: [] },
    providers: {},
  }
  it('缺省回退 dialog', () => {
    expect(resolveFailoverMode(base)).toBe('dialog')
  })
  it('显式 auto 生效', () => {
    expect(resolveFailoverMode({ ...base, failoverMode: 'auto' })).toBe('auto')
  })
  it('显式 dialog 生效', () => {
    expect(resolveFailoverMode({ ...base, failoverMode: 'dialog' })).toBe('dialog')
  })
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm exec vitest run packages/core/src/settings.test.ts`
Expected: FAIL —— `resolveFailoverMode is not a function`;同时 `{ ...base, failoverMode }` 处可能 TS 报错(字段未定义)。

- [ ] **Step 3: 加字段 + 合并 + 解析函数**

(a) `packages/core/src/types.ts` 的 `ResolvedSettings` 接口里,在 `proxy?` 附近加:

```ts
  /** 模型调用失败时的降级策略:'dialog' 弹 /model 选择器(默认);'auto' 自动切同 provider 下一个可用模型。 */
  failoverMode?: 'dialog' | 'auto'
```

(b) `packages/core/src/settings.ts` 的 `RawSettings` 接口里(`proxy?: string` 附近)加:

```ts
  failoverMode?: 'dialog' | 'auto'
```

(c) 同文件 `mergeLayers` 的 for 循环里,紧挨 `if (layer.proxy !== undefined) out.proxy = layer.proxy` 之后加:

```ts
    if (layer.failoverMode !== undefined) out.failoverMode = layer.failoverMode
```

(d) 在 `getDefaultMaxTokens` 附近(导出区)新增:

```ts
/** 解析降级策略:settings.failoverMode,缺省 'dialog'。 */
export function resolveFailoverMode(settings: ResolvedSettings): 'dialog' | 'auto' {
  return settings.failoverMode ?? 'dialog'
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `pnpm exec vitest run packages/core/src/settings.test.ts`
Expected: PASS。

- [ ] **Step 5: 类型检查 + 提交**

Run: `pnpm -F @zuse/core typecheck`
Expected: 无错误。

```bash
git add packages/core/src/types.ts packages/core/src/settings.ts packages/core/src/settings.test.ts
git commit -m "feat(core): add failoverMode setting + resolveFailoverMode"
```

---

## Task 4: 降级决策纯函数 failoverCore(tui)

**Files:**
- Create: `packages/tui/src/hooks/failoverCore.ts`
- Test: `packages/tui/src/hooks/failoverCore.test.ts`

> 把「标坏哪些 key」「选不选得到下家、还是弹框」抽成不依赖 React 的纯函数,与 selectListCore/commandMenuCore 同套路,便于单测。`useConversation` 只做接线。

- [ ] **Step 1: 写失败测试**

Create `packages/tui/src/hooks/failoverCore.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { badKeysForFailure, decideFailover } from './failoverCore.js'

describe('badKeysForFailure', () => {
  const models = ['m1', 'm2', 'm3']
  it('quota/unavailable 只标当前 provider/model', () => {
    expect(badKeysForFailure('p', 'm2', 'quota', models)).toEqual(['p/m2'])
    expect(badKeysForFailure('p', 'm2', 'unavailable', models)).toEqual(['p/m2'])
  })
  it('auth 标整个 provider 的所有 model', () => {
    expect(badKeysForFailure('p', 'm2', 'auth', models)).toEqual(['p/m1', 'p/m2', 'p/m3'])
  })
})

describe('decideFailover', () => {
  const models = ['m1', 'm2', 'm3']
  it('dialog 模式:总是弹框', () => {
    const bad = new Set(['p/m1'])
    expect(decideFailover({ category: 'quota', mode: 'dialog', providerId: 'p', models, currentModel: 'm1', bad })).toEqual({ kind: 'dialog' })
  })
  it('auth:即便 auto 也弹框', () => {
    const bad = new Set(['p/m1', 'p/m2', 'p/m3'])
    expect(decideFailover({ category: 'auth', mode: 'auto', providerId: 'p', models, currentModel: 'm1', bad })).toEqual({ kind: 'dialog' })
  })
  it('auto + 有下家:retry 到第一个未坏且非当前的 model(按声明顺序)', () => {
    const bad = new Set(['p/m1']) // m1 刚失败已被标坏
    expect(decideFailover({ category: 'quota', mode: 'auto', providerId: 'p', models, currentModel: 'm1', bad })).toEqual({ kind: 'retry', model: 'm2' })
  })
  it('auto + 下一个也已坏:跳过到再下一个', () => {
    const bad = new Set(['p/m1', 'p/m2'])
    expect(decideFailover({ category: 'unavailable', mode: 'auto', providerId: 'p', models, currentModel: 'm1', bad })).toEqual({ kind: 'retry', model: 'm3' })
  })
  it('auto + 同 provider 全坏:弹框', () => {
    const bad = new Set(['p/m1', 'p/m2', 'p/m3'])
    expect(decideFailover({ category: 'quota', mode: 'auto', providerId: 'p', models, currentModel: 'm3', bad })).toEqual({ kind: 'dialog' })
  })
  it('auto + provider 未声明 models(空数组):弹框', () => {
    expect(decideFailover({ category: 'quota', mode: 'auto', providerId: 'p', models: [], currentModel: 'm1', bad: new Set(['p/m1']) })).toEqual({ kind: 'dialog' })
  })
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm exec vitest run packages/tui/src/hooks/failoverCore.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 failoverCore.ts**

Create `packages/tui/src/hooks/failoverCore.ts`:

```ts
/**
 * 降级(failover)的纯决策逻辑,不依赖 React/ink,便于单测。
 * useConversation 在 error 事件后调用:先 badKeysForFailure 标坏,再 decideFailover 决定动作。
 */
import type { ErrorCategory } from '@zuse/core'

/** key 形如 `${providerId}/${model}`,与 buildModelOptions 的标注 key 一致。 */
export function modelKey(providerId: string, model: string): string {
  return `${providerId}/${model}`
}

/**
 * 本次失败应标坏哪些 key。
 * - auth(401):整个 provider 共享一个 key,失效则全 provider 不可用 → 标该 provider 所有声明 model。
 * - 其余(quota/unavailable):只标当前 provider/model。
 */
export function badKeysForFailure(
  providerId: string,
  currentModel: string,
  category: ErrorCategory,
  models: string[],
): string[] {
  if (category === 'auth') return models.map((m) => modelKey(providerId, m))
  return [modelKey(providerId, currentModel)]
}

export type FailoverAction = { kind: 'retry'; model: string } | { kind: 'dialog' }

export interface FailoverInput {
  category: ErrorCategory
  mode: 'dialog' | 'auto'
  providerId: string
  /** settings.providers[providerId].models;扁平/未声明则空数组。 */
  models: string[]
  currentModel: string
  /** 已标坏 key 集合(调用方须先把本次失败的 key 加进来再调本函数)。 */
  bad: Set<string>
}

/**
 * 决定降级动作。
 * - dialog 模式、或 auth、或 auto 找不到下家 → 弹框。
 * - auto + 非 auth + 有未坏下家 → retry(按 models 声明顺序取第一个未坏且非当前的)。
 */
export function decideFailover(input: FailoverInput): FailoverAction {
  const { category, mode, providerId, models, currentModel, bad } = input
  if (mode === 'dialog' || category === 'auth') return { kind: 'dialog' }
  const next = models.find((m) => m !== currentModel && !bad.has(modelKey(providerId, m)))
  return next ? { kind: 'retry', model: next } : { kind: 'dialog' }
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `pnpm exec vitest run packages/tui/src/hooks/failoverCore.test.ts`
Expected: PASS。

- [ ] **Step 5: 类型检查 + 提交**

Run: `pnpm -F @zuse/tui typecheck`
Expected: 无错误。

```bash
git add packages/tui/src/hooks/failoverCore.ts packages/tui/src/hooks/failoverCore.test.ts
git commit -m "feat(tui): add failoverCore pure decision logic"
```

---

## Task 5: ModelOption 标注 + buildModelOptions 支持 badKeys(tui)

**Files:**
- Modify: `packages/tui/src/commands/registry.ts`(`ModelOption` 接口、`buildModelOptions` 签名)
- Test: `packages/tui/src/commands/registry.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/tui/src/commands/registry.test.ts` 里,找到 `buildModelOptions` 的 describe(或新建一个),追加:

```ts
import type { ErrorCategory } from '@zuse/core'

describe('buildModelOptions —— 不可用标注', () => {
  const settings = {
    tools: {},
    permissions: { defaultMode: 'default' as const, allow: [], ask: [], deny: [] },
    providers: { p: { models: ['m1', 'm2'] } },
  }
  it('badKeys 命中项带 unavailable,未命中不带', () => {
    const bad = new Map<string, ErrorCategory>([['p/m1', 'quota']])
    const opts = buildModelOptions(settings, 'p', 'm2', bad)
    const m1 = opts.find((o) => o.model === 'm1')!
    const m2 = opts.find((o) => o.model === 'm2')!
    expect(m1.unavailable).toEqual({ reason: 'quota' })
    expect(m2.unavailable).toBeUndefined()
  })
  it('不传 badKeys 时全部无 unavailable(向后兼容)', () => {
    const opts = buildModelOptions(settings, 'p', 'm1')
    expect(opts.every((o) => o.unavailable === undefined)).toBe(true)
  })
})
```

(若文件顶部已 import `buildModelOptions`,沿用;`ErrorCategory` 按需补 import。)

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm exec vitest run packages/tui/src/commands/registry.test.ts`
Expected: FAIL —— `buildModelOptions` 只接 3 个参数 / `o.unavailable` 类型不存在。

- [ ] **Step 3: 改 ModelOption 与 buildModelOptions**

`packages/tui/src/commands/registry.ts`:

(a) 顶部 import 加(若尚无):
```ts
import type { ErrorCategory } from '@zuse/core'
```

(b) `ModelOption` 接口加字段:
```ts
  /** 运行时(内存)标注:该 provider/model 本会话已判不可用,picker 灰显并打标签。 */
  unavailable?: { reason: ErrorCategory }
```

(c) `buildModelOptions` 签名加可选第四参,并在 push option 时标注:
```ts
export function buildModelOptions(
  settings: ResolvedSettings,
  currentProviderId: string,
  currentModel: string,
  badKeys?: ReadonlyMap<string, ErrorCategory>,
): ModelOption[] {
  const options: ModelOption[] = []
  let currentSeen = false
  for (const [id, p] of Object.entries(settings.providers)) {
    for (const m of p.models ?? []) {
      const isCurrent = id === currentProviderId && m === currentModel
      if (isCurrent) currentSeen = true
      const reason = badKeys?.get(`${id}/${m}`)
      options.push({ providerId: id, model: m, isCurrent, ...(reason ? { unavailable: { reason } } : {}) })
    }
  }
  if (!currentSeen) {
    options.push({ providerId: currentProviderId, model: currentModel, isCurrent: true })
  }
  return options
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `pnpm exec vitest run packages/tui/src/commands/registry.test.ts`
Expected: PASS。

- [ ] **Step 5: 类型检查 + 提交**

Run: `pnpm -F @zuse/tui typecheck`
Expected: 无错误。

```bash
git add packages/tui/src/commands/registry.ts packages/tui/src/commands/registry.test.ts
git commit -m "feat(tui): annotate ModelOption with unavailable from badKeys"
```

---

## Task 6: SelectListItem 标注字段 + buildModelSelectItems 透传(tui)

**Files:**
- Modify: `packages/tui/src/components/selectListCore.ts`(`SelectListItem` 加 `disabled?`/`badge?`)
- Modify: `packages/tui/src/components/modelSelectItems.ts`(把 `unavailable` 译成 `disabled`+`badge`)
- Test: `packages/tui/src/components/modelSelectItems.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/tui/src/components/modelSelectItems.test.ts` 追加(reason→文案映射:quota→额度耗尽、auth→key失效、unavailable→不可用):

```ts
describe('buildModelSelectItems —— 不可用标注', () => {
  it('unavailable 项带 disabled 与中文 badge,可用项不带', () => {
    const items = buildModelSelectItems([
      { providerId: 'p', model: 'm1', isCurrent: false, unavailable: { reason: 'quota' } },
      { providerId: 'p', model: 'm2', isCurrent: false },
    ])
    const m1 = items.find((it) => it.label === 'm1')!
    const m2 = items.find((it) => it.label === 'm2')!
    expect(m1.disabled).toBe(true)
    expect(m1.badge).toBe('额度耗尽')
    expect(m2.disabled).toBeUndefined()
    expect(m2.badge).toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm exec vitest run packages/tui/src/components/modelSelectItems.test.ts`
Expected: FAIL —— `it.disabled`/`it.badge` 类型不存在 / 值为 undefined。

- [ ] **Step 3: 加字段 + 译标注**

(a) `packages/tui/src/components/selectListCore.ts` 的 `SelectListItem` 接口加两个可选字段:
```ts
  /** 标为不可选:渲染灰显,回车不确认(导航仍可经过,让用户看到标签)。 */
  disabled?: boolean
  /** 行尾标签(如「额度耗尽」),仅展示用。 */
  badge?: string
```

(b) `packages/tui/src/components/modelSelectItems.ts`:在文件顶部加 reason→文案映射,并在 push option 行时带上 `disabled`/`badge`:

```ts
import type { ErrorCategory } from '@zuse/core'

const REASON_LABEL: Record<ErrorCategory, string> = {
  quota: '额度耗尽',
  auth: 'key失效',
  unavailable: '不可用',
  other: '不可用',
}
```

把现有 push option 那行:
```ts
    items.push({ value: String(i), label: o.model, filterText: `${o.providerId}/${o.model}` })
```
替换为:
```ts
    items.push({
      value: String(i),
      label: o.model,
      filterText: `${o.providerId}/${o.model}`,
      ...(o.unavailable ? { disabled: true, badge: REASON_LABEL[o.unavailable.reason] } : {}),
    })
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `pnpm exec vitest run packages/tui/src/components/modelSelectItems.test.ts`
Expected: PASS。

- [ ] **Step 5: 类型检查 + 提交**

Run: `pnpm -F @zuse/tui typecheck`
Expected: 无错误。

```bash
git add packages/tui/src/components/selectListCore.ts packages/tui/src/components/modelSelectItems.ts packages/tui/src/components/modelSelectItems.test.ts
git commit -m "feat(tui): map unavailable model to disabled+badge select item"
```

---

## Task 7: SelectList 渲染灰显+badge,回车跳过 disabled(tui)

**Files:**
- Modify: `packages/tui/src/components/SelectList.tsx`(渲染 + 回车守卫)

> 组件层改动,无纯函数可单测;靠 typecheck + 构建 + 后续手动验证。改动小且集中。

- [ ] **Step 1: 回车守卫——disabled 项不确认**

在 `packages/tui/src/components/SelectList.tsx` 的 `useInput` 里,把 `key.return` 分支:
```ts
      if (key.return) {
        const item = filtered[cursor]
        if (item) onSelect(item.value)
        return
      }
```
改为:
```ts
      if (key.return) {
        const item = filtered[cursor]
        if (item && !item.disabled) onSelect(item.value)
        return
      }
```

- [ ] **Step 2: 渲染——disabled 灰显 + 行尾 badge**

在 option 行渲染处(当前 `return (<Text ... >{indent}{marker} {dot} {item.label}</Text>)`),替换为带 disabled 处理的版本:

```ts
          const isCursor = absIndex === cursor
          const isCurrent = currentValue !== undefined && item.value === currentValue
          const marker = isCursor ? '❯' : ' '
          const dot = isCurrent ? '●' : ' '
          const indent = grouped ? '  ' : ''
          // 不可用项:整行灰显(优先于光标/当前色),行尾追加 badge。导航仍可停留(已可见),但回车不确认。
          if (item.disabled) {
            return (
              <Text key={item.value} dimColor>
                {indent}
                {marker} {dot} {item.label}
                {item.badge ? ` (${item.badge})` : ''}
              </Text>
            )
          }
          return (
            <Text
              key={item.value}
              color={isCursor ? 'cyan' : isCurrent ? 'green' : undefined}
              bold={isCursor}
            >
              {indent}
              {marker} {dot} {item.label}
            </Text>
          )
```

- [ ] **Step 3: 类型检查 + 构建**

Run: `pnpm -F @zuse/tui typecheck`
Expected: 无错误。

Run: `pnpm build`
Expected: 构建成功。

- [ ] **Step 4: 提交**

```bash
git add packages/tui/src/components/SelectList.tsx
git commit -m "feat(tui): SelectList dims disabled items + badge, blocks confirm"
```

---

## Task 8: ModelSelect 接收 badKeys 并透传(tui)

**Files:**
- Modify: `packages/tui/src/components/ModelSelect.tsx`(新增 `badKeys` prop,传给 `buildModelOptions`)

- [ ] **Step 1: 加 prop 并透传**

`packages/tui/src/components/ModelSelect.tsx`:

(a) 顶部 import 补 `ErrorCategory`:
```ts
import type { ResolvedSettings, ErrorCategory } from '@zuse/core'
```

(b) `ModelSelectProps` 接口加:
```ts
  /** 本会话已判不可用的 provider/model(key=`pid/model`),picker 据此灰显标注。 */
  badKeys?: ReadonlyMap<string, ErrorCategory>
```

(c) 函数参数解构加 `badKeys`,并把 `buildModelOptions` 调用改为:
```ts
  const options = buildModelOptions(settings, currentProviderId, currentModel, badKeys)
```

- [ ] **Step 2: 类型检查**

Run: `pnpm -F @zuse/tui typecheck`
Expected: 无错误(App.tsx 暂未传 badKeys,因 prop 可选,不报错)。

- [ ] **Step 3: 提交**

```bash
git add packages/tui/src/components/ModelSelect.tsx
git commit -m "feat(tui): ModelSelect accepts badKeys to annotate picker"
```

---

## Task 9: useConversation 降级编排 + App 接线(tui)

**Files:**
- Modify: `packages/tui/src/hooks/useConversation.ts`(badModelsRef、error 分支、循环后 applyFailover、isResend、暴露 badModels)
- Modify: `packages/tui/src/App.tsx`(把 badModels 传给 ModelSelect)

> 集成层,无现成 hook 测试基建;靠 typecheck + 构建 + Step 末的手动验证清单。核心约束:**绝不在 `for await` 内重入 sendMessage**——error 分支只置 `failoverDecision`,循环结束、finally 清 abortRef 后才执行。

- [ ] **Step 1: import + badModelsRef + 暴露**

`packages/tui/src/hooks/useConversation.ts`:

(a) 从 `@zuse/core` 的 import 块补 `resolveFailoverMode` 和类型 `ErrorCategory`:
```ts
  resolveFailoverMode,
  ...
  type ErrorCategory,
```
并从本地 import failoverCore:
```ts
import { badKeysForFailure, decideFailover, modelKey } from './failoverCore.js'
```

(b) 在其它 ref 旁新增(刷新即清的内存标记):
```ts
  // 本会话判不可用的 provider/model(key=`pid/model` → 原因)。仅内存,进程重启即清。
  const badModelsRef = useRef<Map<string, ErrorCategory>>(new Map())
```

(c) `UseConversationReturn` 接口加:
```ts
  /** 本会话不可用标记(供 /model picker 灰显标注)。 */
  badModels: ReadonlyMap<string, ErrorCategory>
```

(d) 返回对象里加 `badModels: badModelsRef.current,`。

- [ ] **Step 2: sendMessage 支持 isResend,声明 failoverDecision**

(a) 把 `sendMessage` 的签名加第四参:
```ts
  const sendMessage = useCallback(
    async (text: string, displayText?: string, pasteFiles?: Record<number, string>, opts?: { isResend?: boolean }) => {
```

(b) 在函数体内、`const conversation = conversationRef.current` 之后,把乐观 push user 气泡用 isResend 守卫(重发时原 user 气泡仍在屏,不重复):
```ts
      // 重发(降级后自动重试)不再压新 user 气泡——失败回合没提交,原气泡仍在。
      if (!opts?.isResend) {
        const userMessage: UIMessage = { id: generateId(), role: 'user', text, displayText, pasteFiles, isStreaming: false }
        setState((prev) => ({ ...prev, messages: [...prev.messages, userMessage], isThinking: true }))
      } else {
        setState((prev) => ({ ...prev, isThinking: true }))
      }
```
(删除原先无条件 push userMessage 的那段。)

(c) 在 `for await` 循环之前声明决策变量:
```ts
      // 降级决策:error 分支只「记下」,绝不在 for-await 内重入 sendMessage;循环结束后才执行。
      let failoverDecision: ErrorCategory | null = null
```

- [ ] **Step 3: 改写 error 分支(只记决定)**

把 error 分支(当前 `else if (event.type === 'error')`)替换为:
```ts
          } else if (event.type === 'error') {
            if (controller.signal.aborted) {
              showAborted()
            } else {
              const cat: ErrorCategory = event.category ?? 'other'
              // 只在「还没吐出任何文本」时才考虑降级:额度/认证错误都发生在开流阶段,满足;
              // 流到一半才报错则只提示(重发会重复内容)。
              const preStream = accumulated === '' && currentAssistantId === null
              if (preStream && cat !== 'other') {
                failoverDecision = cat
              } else {
                showError(event.message)
              }
            }
          }
```

- [ ] **Step 4: 循环结束后执行 applyFailover**

在 `try` 块里、`for await` 循环结束之后(就是设置 `setState(... totalUsage ...)` 那段之后)、`} catch (err) {` 之前,加:
```ts
        // 降级:此时 for-await 已结束(client 已 return),安全地切模型/弹框。
        if (failoverDecision) {
          const cat = failoverDecision
          const pid = currentProviderId
          // 用 clientRef.current.getModel() 而非闭包里的 currentModel:auto 连环降级时,
          // 递归 sendMessage 是同一闭包实例(currentModel 是陈旧的初始值),而 clientRef 已被
          // switchModel 同步热替换,getModel() 才是本回合真正在用、刚失败的那个 model。
          const failedModel = clientRef.current?.getModel() ?? currentModel
          const models = settings.providers[pid]?.models ?? []
          // 1) 标坏(auth 标整个 provider)。
          for (const k of badKeysForFailure(pid, failedModel, cat, models)) {
            badModelsRef.current.set(k, k === modelKey(pid, failedModel) ? cat : 'auth')
          }
          // 2) 决策。
          const reasonText = cat === 'auth' ? 'API key 失效' : cat === 'quota' ? '额度耗尽' : '模型不可用'
          const mode = resolveFailoverMode(settings)
          const action = decideFailover({ category: cat, mode, providerId: pid, models, currentModel: failedModel, bad: badModelsRef.current })
          if (action.kind === 'retry') {
            print(`${reasonText},已切换到 ${pid}/${action.model} 重试`)
            switchModel({ providerId: pid, model: action.model }, false)
            // switchModel 已同步热替换 clientRef;重发的 runAgent 用 clientRef.current.getModel()
            // 取新模型,故直接重发即可(无需等 setCurrentModel 这类异步 state)。
            abortRef.current = null
            await sendMessage(text, undefined, undefined, { isResend: true })
            return
          }
          // dialog:弹框,picker 据 badModelsRef 灰显标注。
          print(`${reasonText},请选择其他模型`)
          setModelSelectorOpen(true)
        }
```

> 说明:`switchModel` 内部 `setCurrentModel/setCurrentProviderId` 是异步 state 更新,但它**同步**热替换了 `clientRef.current`;重发的 `sendMessage` → `runAgent` 用 `clientRef.current.getModel()` 取模型,故无需等 state。`auth` 时 `currentProviderId` 不变(同 provider 全标坏),decideFailover 必返回 dialog。

- [ ] **Step 5: 依赖数组补齐**

`sendMessage` 的 `useCallback` 依赖数组当前是 `[maxTokens, registry, patch, cwd, settings, systemPrompt]`。新增引用了 `currentProviderId`、`currentModel`、`switchModel`、`print`、`setModelSelectorOpen`(后两个是稳定函数,但 currentProviderId/currentModel/switchModel 需要加)。改为:
```ts
    [maxTokens, registry, patch, cwd, settings, systemPrompt, currentProviderId, currentModel, switchModel, print],
```
(`switchModel`、`print` 已是 useCallback,稳定;`setModelSelectorOpen` 是 setState dispatcher,React 保证稳定,无需列入。)

- [ ] **Step 6: App.tsx 把 badModels 传给 ModelSelect**

`packages/tui/src/App.tsx`:

(a) 从 `useConversation()` 解构里加 `badModels,`(在 `confirmModelSelection` 附近)。

(b) `<ModelSelect ... />` 加一个 prop:
```tsx
        <ModelSelect
          settings={resolved}
          currentProviderId={currentProviderId}
          currentModel={currentModel}
          badKeys={badModels}
          onConfirm={confirmModelSelection}
          onCancel={closeModelSelector}
        />
```

- [ ] **Step 7: 类型检查 + 构建**

Run: `pnpm -F @zuse/tui typecheck`
Expected: 无错误。

Run: `pnpm build`
Expected: 构建成功。

- [ ] **Step 8: 全量测试**

Run: `pnpm test`
Expected: 全绿(含前 8 个任务新增的测试)。

- [ ] **Step 9: 手动验证(端到端)**

准备一个 `.zuse/settings.local.json`,某 provider 配 2+ 个 model,其一用必报额度/认证错的配置(或临时把第一个 model 的 id 改成不存在的名字以触发 404=unavailable)。然后:

1. **dialog 模式(默认,不配 failoverMode)**:发一条消息触发首个 model 出错 → 期望弹出 `/model` 选择器,出错的 model 灰显且行尾标 `(额度耗尽)`/`(不可用)`/`(key失效)`,光标可经过但回车不切换;选另一个可用 model 回车 → 正常切换继续。
2. **auto 模式(`"failoverMode": "auto"`)**:同 provider 有下家时 → 期望打印「已切换到 …/… 重试」并自动用下一个 model 重新作答(不弹框、user 气泡不重复);把同 provider 的 model 都改坏 → 期望回退到弹框。
3. **401(auth)**:把某 provider 的 apiKey 改错 → 即便 auto 也弹框,且该 provider 下**所有** model 都灰显标 `(key失效)`。
4. **重启清标记**:退出重进,所有灰显消失(标记仅内存)。

把验证结果记录在提交信息或 PR 描述里。

- [ ] **Step 10: 提交**

```bash
git add packages/tui/src/hooks/useConversation.ts packages/tui/src/App.tsx
git commit -m "feat(tui): wire model failover orchestration into useConversation"
```

---

## 自检对照(spec 覆盖)

- 错误分类(spec §6)→ Task 1、2 ✓
- failoverMode 设置(spec §7)→ Task 3 ✓
- 降级编排 + 未吐文本守卫 + 循环后执行(spec §8、§11)→ Task 9 ✓
- 会话级内存标记、auth 标整 provider、刷新即清(spec §4、§8、G4)→ Task 4(badKeysForFailure)+ Task 9(badModelsRef)✓
- picker 灰显标注 + 不可确认(spec §9)→ Task 5、6、7、8 ✓
- 触发矩阵(spec §4)→ Task 1(分类)+ Task 4(decideFailover)+ Task 9(接线)✓
- 重发去重 isResend(spec §8)→ Task 9 Step 2 ✓

## 注意事项 / 已知风险

- **abort 卫生**:Task 9 Step 4 在重发前 `abortRef.current = null`,且重发发生在原 `for await` 结束之后——原 controller 生命周期已终。重发会在 `sendMessage` 顶部新建 controller。务必保证不在 `for await` 内调 `sendMessage`(已由「只记 failoverDecision」保证)。
- **auto 连环降级终止性**:每次失败把当前 model 标坏,`decideFailover` 只选未坏下家,候选单调减少,最终必落到 `dialog`。无需计数器。
- **finally 与 return**:Task 9 Step 4 的 retry 分支里有 `return`,但 `try` 的 `finally { abortRef.current = null }` 仍会执行——无副作用(重发已自建 controller)。
