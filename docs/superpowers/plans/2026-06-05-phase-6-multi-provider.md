# Phase 6 · 多 Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 zuse 支持多 provider（Anthropic 协议 + OpenAI 协议，含本地 Ollama），运行时 `/model` 切换，并引入 Anthropic prompt 缓存与 cache token 统计。

**Architecture:** 数据驱动的 provider registry 落在 settings；`ModelClient` 接口下放两个手搓实现（`AnthropicClient` / `OpenAIClient`），按 `protocol` 工厂分发；TUI 把 client 所有权下移到 hook 以支持热替换。两个 client 对外只产出 provider 无关的 `StreamEvent`。

**Tech Stack:** TypeScript（ESM）、`@anthropic-ai/sdk`、`openai` SDK、vitest、Ink/React、jsonc-parser。

**Spec:** [docs/superpowers/specs/2026-06-05-zuse-multi-provider-design.md](../specs/2026-06-05-zuse-multi-provider-design.md)

**约定：** 所有命令在仓库根 `e:/ai-study/zuse` 下执行。测试用 `pnpm test`（vitest run）。core 全程 TDD；TUI 手工验证。提交信息沿用 `phase 6.x:` 前缀，**注释一律中文**。**完成后不要自动 commit/push**——等用户明确要求（见用户既定习惯）。提交命令仅作每个 task 的收尾占位，由执行者在用户授权后统一处理。

---

## File Structure

**core（packages/core/src/）**

- `types.ts` — 改：`Usage` 加两个 cache 字段；新增 `ProviderConfig`、`ModelSelection`、`RawProviderConfig`；`ResolvedSettings` 加 `providers`。
- `conversation.ts` — 改：`addUsage` 累加 cache 字段。
- `settings.ts` — 改：`providers` 按 id 深合并；新增 `resolveModelSelection`、`getProviderConfig`、`createClientFromSettings`、`setModelInSettings`；保留 `getDefaultMaxTokens`；移除被取代的 `getClientConfig`/`getDefaultModel`。（注：前置重构已把原 `env.ts` 并入 `settings.ts` 并删除 `env.ts`，本期所有 provider 解析逻辑都落在 `settings.ts`。）
- `model-client.ts` — 改：保留接口，新增 `createModelClient` 工厂。
- `anthropic-client.ts` — 改：构造签名收敛为 `(ProviderConfig, model)`；抽出纯函数 `buildAnthropicRequest` 并打 cache_control；usage 带出 cache 字段。
- `openai-client.ts` — 新：`OpenAIClient` + 纯函数 `toOpenAIMessages` / `toOpenAITools` / `streamToEvents`。
- `index.ts` — 改：导出新符号。

**core 测试**

- `conversation.test.ts` — 改：addUsage cache 累加。
- `settings.test.ts` — 改：providers 深合并 + setModelInSettings。
- `settings.test.ts`（同上）— 增：resolveModelSelection / getProviderConfig / 向后兼容 / key 来源（原计划的 env.test.ts 并入此文件）。
- `openai-client.test.ts` — 新：三处翻译 + 流式累积。
- `anthropic-client.test.ts` — 改：构造签名更新 + buildAnthropicRequest cache 断言。
- `model-client.test.ts` — 新：工厂按 protocol 选实现。

**tui（packages/tui/src/）**

- `App.tsx` — 改：client 所有权下移到 hook，只传 settings。
- `hooks/useConversation.ts` — 改：`clientRef` / `currentModel` / `switchModel`。
- `commands/types.ts` — 改：`CommandContext` 加 `switchModel` + `currentModel`。
- `commands/registry.ts` — 改：新增 `/model` 命令。
- `components/UsageFooter.tsx` — 改：显示 cache 命中。

**配置 / 文档**

- `packages/core/package.json` — 加 `openai` 依赖。
- `.zuse/settings.local.jsonc`、`.zuse/settings.local.json.example`、`.env.example` — 迁到 registry 结构。
- `BACKLOG.md` — 记「未来可换 Vercel AI SDK」。
- `README.md`、`docs/superpowers/plans/phase-roadmap.md` — Phase 6 完成后更新状态。

---

## Task 6.1: Usage 加 cache 字段 + addUsage 累加

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/conversation.ts`
- Test: `packages/core/src/conversation.test.ts`

- [ ] **Step 1: 写失败测试** — 在 `conversation.test.ts` 末尾追加：

```typescript
describe('addUsage cache fields', () => {
  it('accumulates cache_read and cache_creation across turns', () => {
    const conv = new Conversation()
    conv.addUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 })
    conv.addUsage({ input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 50 })
    const u = conv.totalUsage
    expect(u.input_tokens).toBe(13)
    expect(u.output_tokens).toBe(7)
    expect(u.cache_read_input_tokens).toBe(150)
    expect(u.cache_creation_input_tokens).toBe(20)
  })

  it('treats missing cache fields as zero', () => {
    const conv = new Conversation()
    conv.addUsage({ input_tokens: 1, output_tokens: 1 })
    expect(conv.totalUsage.cache_read_input_tokens).toBe(0)
    expect(conv.totalUsage.cache_creation_input_tokens).toBe(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- conversation`
Expected: FAIL（totalUsage 无 cache 字段 / 为 undefined）。

- [ ] **Step 3: 改 `types.ts` 的 `Usage`** — 把现有 `Usage` 接口替换为：

```typescript
// Token 用量追踪（故障模式⑧的防御）。Phase 6 起含缓存命中统计。
export interface Usage {
  input_tokens: number
  output_tokens: number
  // 缓存命中读取的输入 token（Anthropic: cache_read_input_tokens；OpenAI: cached_tokens）。
  cache_read_input_tokens?: number
  // 首次写入缓存的输入 token（Anthropic 专有；OpenAI 无对应，留空）。
  cache_creation_input_tokens?: number
}
```

- [ ] **Step 4: 改 `conversation.ts`** — 把 `_totalUsage` 初值与 `addUsage` / `clear` 改为带 cache 字段：

```typescript
  private _totalUsage: Usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  }

  /** 把一个回合的用量累加进运行总计（故障模式⑧）。缺省 cache 字段按 0 计。 */
  addUsage(usage: Usage): void {
    this._totalUsage = {
      input_tokens: this._totalUsage.input_tokens + usage.input_tokens,
      output_tokens: this._totalUsage.output_tokens + usage.output_tokens,
      cache_read_input_tokens:
        (this._totalUsage.cache_read_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
      cache_creation_input_tokens:
        (this._totalUsage.cache_creation_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    }
  }
```

并把 `clear()` 里的 `_totalUsage` 重置同样补上两个 cache 字段（值为 0）。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test -- conversation`
Expected: PASS。

- [ ] **Step 6: 提交（占位，授权后执行）**

```bash
git add packages/core/src/types.ts packages/core/src/conversation.ts packages/core/src/conversation.test.ts
git commit -m "phase 6.1: Usage 加缓存命中字段 + addUsage 累加"
```

---

## Task 6.2: settings —— providers 按 id 深合并

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/settings.ts`
- Test: `packages/core/src/settings.test.ts`

- [ ] **Step 1: 先加类型（`types.ts`）** — 在 Phase 5 类型区追加：

```typescript
/** provider 的 wire 协议。 */
export type ProviderProtocol = 'anthropic' | 'openai'

/** settings 文件里单个 provider 的原始（未解析）形状，全部可选。 */
export interface RawProviderConfig {
  protocol?: ProviderProtocol
  baseURL?: string
  apiKey?: string
  models?: string[]
}

/** 解析后、可直接交给 client 工厂的完整 provider 配置。 */
export interface ProviderConfig {
  id: string
  protocol: ProviderProtocol
  baseURL?: string
  apiKey: string
  models: string[]
}

/** 当前选中：哪个 provider 的哪个 model。 */
export interface ModelSelection {
  providerId: string
  model: string
}
```

并在 `ResolvedSettings` 接口里加一行：`providers: Record<string, RawProviderConfig>`（注意：合并后一定有值，缺省为 `{}`）。

- [ ] **Step 2: 写失败测试（`settings.test.ts`）** — 追加：

```typescript
describe('providers registry merge', () => {
  it('defaults providers to empty object when absent', () => {
    const s = loadSettings({ userPath: p('u.json'), projectPath: p('pj.json'), localPath: p('l.json') })
    expect(s.providers).toEqual({})
  })

  it('deep-merges a provider by id across layers (project骨架 + local补key)', () => {
    writeFileSync(p('pj.json'), JSON.stringify({
      providers: { qwen: { protocol: 'anthropic', baseURL: 'https://dash/anthropic', models: ['qwen3-max'] } },
    }))
    writeFileSync(p('l.json'), JSON.stringify({
      providers: { qwen: { apiKey: 'sk-local' } },
    }))
    const s = loadSettings({ userPath: p('u.json'), projectPath: p('pj.json'), localPath: p('l.json') })
    expect(s.providers.qwen).toEqual({
      protocol: 'anthropic',
      baseURL: 'https://dash/anthropic',
      apiKey: 'sk-local',
      models: ['qwen3-max'],
    })
  })

  it('higher layer overrides scalar provider fields but keeps untouched ones', () => {
    writeFileSync(p('pj.json'), JSON.stringify({
      providers: { ds: { protocol: 'openai', baseURL: 'https://a/v1', apiKey: 'sk-1', models: ['x'] } },
    }))
    writeFileSync(p('l.json'), JSON.stringify({
      providers: { ds: { baseURL: 'https://b/v1' } },
    }))
    const s = loadSettings({ userPath: p('u.json'), projectPath: p('pj.json'), localPath: p('l.json') })
    expect(s.providers.ds.baseURL).toBe('https://b/v1')
    expect(s.providers.ds.apiKey).toBe('sk-1')
    expect(s.providers.ds.protocol).toBe('openai')
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test -- settings`
Expected: FAIL（`s.providers` 为 undefined）。

- [ ] **Step 4: 实现深合并（`settings.ts`）**

在 `RawSettings` 接口加：`providers?: Record<string, RawProviderConfig>;`（先 `import type { ..., RawProviderConfig }`）。

在 `mergeLayers` 的 `out` 初值加 `providers: {}`，并在层循环里加 provider 深合并：

```typescript
    if (layer.providers) {
      for (const [id, p] of Object.entries(layer.providers)) {
        out.providers[id] = { ...(out.providers[id] ?? {}), ...p }
      }
    }
```

（放在现有 `if (layer.tools)` 处理之后、permissions 之前皆可。）

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test -- settings`
Expected: PASS。

- [ ] **Step 6: 提交（占位）**

```bash
git add packages/core/src/types.ts packages/core/src/settings.ts packages/core/src/settings.test.ts
git commit -m "phase 6.2: settings 增加 providers registry 按 id 深合并"
```

---

## Task 6.3: env —— provider 解析与向后兼容

**Files:**
- Modify: `packages/core/src/settings.ts`（新增 provider 解析函数；移除被取代的 `getClientConfig` / `getDefaultModel`）
- Modify: `scripts/ping-api.ts`
- Test: `packages/core/src/settings.test.ts`

**说明：** 前置重构已把原 `env.ts` 并入 `settings.ts` 并删除 `env.ts`。本 task 把新的 provider 解析纯函数加进 `settings.ts`，并移除被取代的 `getClientConfig` / `getDefaultModel`。client 工厂与 `createClientFromSettings` 留到 6.6。

- [ ] **Step 1: 写失败测试（追加到 `settings.test.ts`）**

> 把 `resolveModelSelection, getProviderConfig, getDefaultMaxTokens` 合并进 `settings.test.ts` 顶部对 `./settings.js` 的现有 import；确保从 `vitest` 也导入了 `afterEach`；补 `import type { ResolvedSettings } from './types.js'`（若缺）。下面的 `base()` / `afterEach` / 两个 `describe` 直接追加到文件末尾，与既有用例并存（既有 `p()` 临时目录清理保持不动）。

```typescript
const base = (over: Partial<ResolvedSettings>): ResolvedSettings => ({
  tools: {},
  permissions: { defaultMode: 'default', allow: [], ask: [], deny: [] },
  providers: {},
  ...over,
})

afterEach(() => {
  delete process.env.ZUSE_API_KEY
  delete process.env.ZUSE_API_KEY_QWEN
})

describe('resolveModelSelection', () => {
  it('parses "<providerId>/<model>"', () => {
    expect(resolveModelSelection(base({ model: 'qwen/qwen3-max' }))).toEqual({ providerId: 'qwen', model: 'qwen3-max' })
  })
  it('treats bare string as default provider', () => {
    expect(resolveModelSelection(base({ model: 'claude-x' }))).toEqual({ providerId: 'default', model: 'claude-x' })
  })
  it('only splits on the first slash', () => {
    expect(resolveModelSelection(base({ model: 'ollama/qwen2.5/coder' }))).toEqual({ providerId: 'ollama', model: 'qwen2.5/coder' })
  })
  it('falls back to default provider + default model when model unset', () => {
    const sel = resolveModelSelection(base({}))
    expect(sel.providerId).toBe('default')
    expect(sel.model).toBeTruthy()
  })
})

describe('getProviderConfig', () => {
  it('synthesizes a default anthropic provider from flat fields when no registry', () => {
    const cfg = getProviderConfig(base({ model: 'claude-x', baseURL: 'https://h', apiKey: 'sk-flat' }), 'default')
    expect(cfg).toEqual({ id: 'default', protocol: 'anthropic', baseURL: 'https://h', apiKey: 'sk-flat', models: ['claude-x'] })
  })
  it('reads a named provider from the registry, defaulting protocol to anthropic', () => {
    const s = base({ providers: { qwen: { baseURL: 'https://d', apiKey: 'sk-q', models: ['m'] } } })
    expect(getProviderConfig(s, 'qwen')).toEqual({ id: 'qwen', protocol: 'anthropic', baseURL: 'https://d', apiKey: 'sk-q', models: ['m'] })
  })
  it('prefers ZUSE_API_KEY_<ID> env over literal apiKey', () => {
    process.env.ZUSE_API_KEY_QWEN = 'sk-env'
    const s = base({ providers: { qwen: { protocol: 'openai', apiKey: 'sk-lit', models: [] } } })
    expect(getProviderConfig(s, 'qwen').apiKey).toBe('sk-env')
  })
  it('accepts a placeholder key (Ollama) without throwing', () => {
    const s = base({ providers: { ollama: { protocol: 'openai', baseURL: 'http://localhost:11434/v1', apiKey: 'ollama', models: [] } } })
    expect(getProviderConfig(s, 'ollama').apiKey).toBe('ollama')
  })
  it('throws a provider-named error when key is missing', () => {
    const s = base({ providers: { ds: { protocol: 'openai', models: [] } } })
    expect(() => getProviderConfig(s, 'ds')).toThrow(/ds/)
  })
  it('throws when provider id is not in the registry', () => {
    expect(() => getProviderConfig(base({}), 'nope')).toThrow(/nope/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- env`
Expected: FAIL（函数未定义）。

- [ ] **Step 3: 改 `settings.ts`** — 分三步：

(a) 顶部类型 import 改为引入新类型、去掉不再用的 `ClientConfig`：

```typescript
import type { ResolvedSettings, PermissionMode, ProviderConfig, ModelSelection } from './types.js'
```

(b) 删除前置重构留下的 `getClientConfig` 与 `getDefaultModel` 两个函数（被 provider 解析取代）；`getDefaultMaxTokens` 保留不动。

(c) 在 import 之后加两个常量，并在文件末尾追加三个函数：

```typescript
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250514'
const DEFAULT_PROVIDER_ID = 'default'
```

```typescript
/** 把 settings.model（`<id>/<model>` 或裸字符串）解析成选中项。 */
export function resolveModelSelection(settings: ResolvedSettings): ModelSelection {
  const raw = settings.model
  if (!raw) return { providerId: DEFAULT_PROVIDER_ID, model: DEFAULT_MODEL }
  const slash = raw.indexOf('/')
  if (slash === -1) return { providerId: DEFAULT_PROVIDER_ID, model: raw }
  return { providerId: raw.slice(0, slash), model: raw.slice(slash + 1) }
}

/** key 来源：ZUSE_API_KEY_<ID>（id 大写）优先，其次字面量。 */
function resolveApiKey(providerId: string, literal: string | undefined): string {
  const envKey = process.env[`ZUSE_API_KEY_${providerId.toUpperCase()}`]
  return envKey || literal || ''
}

/**
 * 取某个 provider 的完整配置。
 * - 'default' 且 registry 无该 id：从扁平 model/baseURL/apiKey 合成一个 anthropic provider（向后兼容）。
 * - 否则查 registry；protocol 缺省 anthropic。
 * 缺 key 抛出指明 provider 的错误（占位 key 因非空而合法）。
 */
export function getProviderConfig(settings: ResolvedSettings, providerId: string): ProviderConfig {
  const raw = settings.providers[providerId]

  if (!raw) {
    if (providerId === DEFAULT_PROVIDER_ID) {
      const apiKey = resolveApiKey(providerId, settings.apiKey)
      if (!apiKey) {
        throw new Error(
          'API key not found for provider "default". Set "apiKey" in settings.local.json, ' +
          'define a "providers" entry, or export ZUSE_API_KEY.',
        )
      }
      return {
        id: DEFAULT_PROVIDER_ID,
        protocol: 'anthropic',
        baseURL: settings.baseURL,
        apiKey,
        models: settings.model ? [settings.model] : [],
      }
    }
    throw new Error(`Provider "${providerId}" is not configured in settings.providers.`)
  }

  const apiKey = resolveApiKey(providerId, raw.apiKey)
  if (!apiKey) {
    throw new Error(
      `API key not found for provider "${providerId}". Set its "apiKey" in settings.local.json ` +
      `or export ZUSE_API_KEY_${providerId.toUpperCase()}.`,
    )
  }
  return {
    id: providerId,
    protocol: raw.protocol ?? 'anthropic',
    baseURL: raw.baseURL,
    apiKey,
    models: raw.models ?? [],
  }
}
```

> `getDefaultMaxTokens` 已存在于 `settings.ts`（前置重构搬入），不要重复定义。
>
> 注意：删除 `getClientConfig` / `getDefaultModel` 会暂时打断 `anthropic-client.ts`（6.5 改）、`anthropic-client.test.ts`（6.5 改）、`scripts/ping-api.ts`（见 Step 4）—— 这是预期的"红灯期"，到 6.6 全绿。

- [ ] **Step 4: 修 `scripts/ping-api.ts` 的旧引用** — 它当前 `import { loadSettings, getClientConfig } from '../packages/core/src/settings.js'`。先看用法：

Run: `grep -n "getClientConfig\|getDefaultModel\|AnthropicClient" scripts/ping-api.ts`

把对 `getClientConfig` / `getDefaultModel` 的引用改为 provider 解析（保持现有相对 import 风格）：

```typescript
import { loadSettings, resolveModelSelection, getProviderConfig } from '../packages/core/src/settings.js'
const settings = loadSettings()
const sel = resolveModelSelection(settings)
const provider = getProviderConfig(settings, sel.providerId)
// 6.5 起 AnthropicClient 构造签名为 (ProviderConfig, model)：
const client = new AnthropicClient(provider, sel.model)
```

> ping-api 是 dev 脚本、不进 vitest 门。从 6.3 删除 `getClientConfig` 起到 6.5 改好 `AnthropicClient` 构造签名之间，它会短暂处于不可运行/不可 typecheck 状态——属预期红灯。6.6 后可统一改用 `createModelClient(provider, sel.model)`，手工 `pnpm api:ping` 验证。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test -- env`
Expected: PASS。

- [ ] **Step 6: 提交（占位）**

```bash
git add packages/core/src/settings.ts packages/core/src/settings.test.ts scripts/ping-api.ts
git commit -m "phase 6.3: settings 增加 provider 解析与扁平配置向后兼容"
```

---

## Task 6.4: OpenAIClient —— 手搓三处翻译 + 流式累积

**Files:**
- Modify: `packages/core/package.json`（加依赖）
- Create: `packages/core/src/openai-client.ts`
- Test: `packages/core/src/openai-client.test.ts`（新）

- [ ] **Step 1: 装 openai SDK**

Run: `pnpm -F @zuse/core add openai`
Expected: `packages/core/package.json` 的 dependencies 多出 `"openai": "^4..."`。

- [ ] **Step 2: 写失败测试（新建 `openai-client.test.ts`）**

```typescript
import { describe, it, expect } from 'vitest'
import { toOpenAIMessages, toOpenAITools, streamToEvents } from './openai-client.js'
import type { Message, StreamEvent } from './types.js'
import type { ToolDefinition } from './tool.js'

describe('toOpenAIMessages', () => {
  it('prepends system, maps text, tool_use → tool_calls, tool_result → top-level tool message', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] },
    ]
    const out = toOpenAIMessages(messages, 'SYS')
    expect(out[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(out[1]).toEqual({ role: 'user', content: 'hi' })
    expect(out[2]).toEqual({
      role: 'assistant',
      content: 'ok',
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: '/a' }) } }],
    })
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'file body' })
  })

  it('omits the system message when no system prompt', () => {
    const out = toOpenAIMessages([{ role: 'user', content: [{ type: 'text', text: 'x' }] }], undefined)
    expect(out[0]).toEqual({ role: 'user', content: 'x' })
  })
})

describe('toOpenAITools', () => {
  it('maps input_schema → function.parameters', () => {
    const defs: ToolDefinition[] = [{ name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: {} } }]
    expect(toOpenAITools(defs)).toEqual([
      { type: 'function', function: { name: 'Read', description: 'read a file', parameters: { type: 'object', properties: {} } } },
    ])
  })
})

// 把一串 chunk 包成异步可迭代，喂给 streamToEvents。
async function* feed(chunks: unknown[]): AsyncIterable<any> {
  for (const c of chunks) yield c
}
async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

describe('streamToEvents', () => {
  it('emits message-start, text-delta, message-stop(end_turn) with usage', async () => {
    const chunks = [
      { id: 'm1', model: 'deepseek-chat', choices: [{ delta: { content: 'Hel' }, finish_reason: null }] },
      { id: 'm1', model: 'deepseek-chat', choices: [{ delta: { content: 'lo' }, finish_reason: null }] },
      { id: 'm1', model: 'deepseek-chat', choices: [{ delta: {}, finish_reason: 'stop' }] },
      { id: 'm1', model: 'deepseek-chat', choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 8 } } },
    ]
    const events = await collect(streamToEvents(feed(chunks)))
    expect(events[0]).toEqual({ type: 'message-start', id: 'm1', model: 'deepseek-chat' })
    expect(events.filter((e) => e.type === 'text-delta').map((e: any) => e.text).join('')).toBe('Hello')
    const stop = events.find((e) => e.type === 'message-stop') as any
    expect(stop.stop_reason).toBe('end_turn')
    expect(stop.usage).toEqual({ input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 8 })
  })

  it('accumulates fragmented tool_call arguments by index and emits tool-use before stop', async () => {
    const chunks = [
      { id: 'm2', model: 'x', choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'Bash', arguments: '{"cmd":' } }] }, finish_reason: null }] },
      { id: 'm2', model: 'x', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, finish_reason: null }] },
      { id: 'm2', model: 'x', choices: [{ delta: { tool_calls: [{ index: 1, id: 'c1', function: { name: 'Read', arguments: '{"file_path":"/a"}' } }] }, finish_reason: null }] },
      { id: 'm2', model: 'x', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 7 } },
    ]
    const events = await collect(streamToEvents(feed(chunks)))
    const uses = events.filter((e) => e.type === 'tool-use') as any[]
    expect(uses).toEqual([
      { type: 'tool-use', id: 'c0', name: 'Bash', input: { cmd: 'ls' } },
      { type: 'tool-use', id: 'c1', name: 'Read', input: { file_path: '/a' } },
    ])
    const stopIdx = events.findIndex((e) => e.type === 'message-stop')
    const lastUseIdx = events.map((e) => e.type).lastIndexOf('tool-use')
    expect(lastUseIdx).toBeLessThan(stopIdx) // tool-use 必须在 message-stop 之前
    expect((events[stopIdx] as any).stop_reason).toBe('tool_use')
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test -- openai-client`
Expected: FAIL（模块/函数未定义）。

- [ ] **Step 4: 实现 `openai-client.ts`**

```typescript
import OpenAI from 'openai'
import type { Message, StreamEvent, ModelConfig, ProviderConfig, Usage } from './types.js'
import type { ModelClient } from './model-client.js'
import type { ToolDefinition } from './tool.js'

/** zuse Message[] → OpenAI chat messages。system 置顶；tool_result 提升为顶层 tool 消息。 */
export function toOpenAIMessages(
  messages: Message[],
  system: string | undefined,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = []
  if (system) out.push({ role: 'system', content: system })

  for (const m of messages) {
    // tool_result 块各自成为一条顶层 { role:'tool' } 消息（OpenAI 的结构差异）。
    const toolResults = m.content.filter((b) => b.type === 'tool_result')
    for (const b of toolResults) {
      if (b.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content })
      }
    }

    const text = m.content
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
    const toolUses = m.content.filter((b) => b.type === 'tool_use')

    if (m.role === 'assistant' && toolUses.length > 0) {
      out.push({
        role: 'assistant',
        content: text || null,
        tool_calls: toolUses.map((b) =>
          b.type === 'tool_use'
            ? { id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input) } }
            : (undefined as never),
        ),
      })
    } else if (text || toolResults.length === 0) {
      // 纯文本消息（user 或 assistant）。只含 tool_result 的 user 消息上面已处理，这里跳过空壳。
      if (text) out.push({ role: m.role, content: text })
    }
  }
  return out
}

/** zuse ToolDefinition[] → OpenAI tools（input_schema → function.parameters）。 */
export function toOpenAITools(defs: ToolDefinition[]): OpenAI.Chat.ChatCompletionTool[] {
  return defs.map((d) => ({
    type: 'function',
    function: { name: d.name, description: d.description, parameters: d.input_schema as Record<string, unknown> },
  }))
}

/** finish_reason → zuse stop_reason。 */
function mapStopReason(reason: string | null | undefined): string {
  if (reason === 'tool_calls') return 'tool_use'
  if (reason === 'stop' || reason === 'length') return 'end_turn'
  return reason || 'end_turn'
}

interface AccTool { id: string; name: string; args: string }

/**
 * OpenAI 流 → zuse StreamEvent。
 * message-start / text-delta 即时产出；tool-use 与 message-stop 在流结束后产出
 *（与 AnthropicClient 一致：先收集 tool_use，再 stop）。
 */
export async function* streamToEvents(stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>): AsyncIterable<StreamEvent> {
  let started = false
  let stopReason = 'end_turn'
  const tools = new Map<number, AccTool>()
  let usage: Usage = { input_tokens: 0, output_tokens: 0 }

  for await (const chunk of stream) {
    if (!started) {
      started = true
      yield { type: 'message-start', id: chunk.id, model: chunk.model }
    }
    const choice = chunk.choices[0]
    if (choice) {
      const delta = choice.delta
      if (delta?.content) yield { type: 'text-delta', text: delta.content }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const acc = tools.get(tc.index) ?? { id: '', name: '', args: '' }
          if (tc.id) acc.id = tc.id
          if (tc.function?.name) acc.name = tc.function.name
          if (tc.function?.arguments) acc.args += tc.function.arguments
          tools.set(tc.index, acc)
        }
      }
      if (choice.finish_reason) stopReason = mapStopReason(choice.finish_reason)
    }
    if (chunk.usage) {
      usage = {
        input_tokens: chunk.usage.prompt_tokens,
        output_tokens: chunk.usage.completion_tokens,
        cache_read_input_tokens: chunk.usage.prompt_tokens_details?.cached_tokens,
      }
    }
  }

  // 按 index 升序产出 tool-use；空参数串按 {} 处理。
  for (const idx of [...tools.keys()].sort((a, b) => a - b)) {
    const t = tools.get(idx)!
    let input: unknown = {}
    if (t.args) {
      try {
        input = JSON.parse(t.args)
      } catch {
        input = {}
      }
    }
    yield { type: 'tool-use', id: t.id, name: t.name, input }
  }
  yield { type: 'message-stop', stop_reason: stopReason, usage }
}

/**
 * OpenAIClient —— 用 openai SDK 实现 ModelClient。
 * 覆盖 OpenAI 原生及一切 OpenAI 兼容端点（DeepSeek / Ollama / vLLM …）。
 */
export class OpenAIClient implements ModelClient {
  private client: OpenAI
  private model: string

  /** sdk 可注入，便于单测；省略时按 provider 配置 new 一个。 */
  constructor(provider: ProviderConfig, model: string, sdk?: OpenAI) {
    this.client = sdk ?? new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseURL })
    this.model = model
  }

  getModel(): string {
    return this.model
  }

  async *sendMessages(
    messages: Message[],
    config: ModelConfig,
    tools?: ToolDefinition[],
  ): AsyncIterable<StreamEvent> {
    const model = config.model || this.model
    try {
      const stream = await this.client.chat.completions.create({
        model,
        max_tokens: config.max_tokens,
        messages: toOpenAIMessages(messages, config.system),
        ...(tools && tools.length > 0 ? { tools: toOpenAITools(tools) } : {}),
        stream: true,
        stream_options: { include_usage: true },
      })
      yield* streamToEvents(stream)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      yield { type: 'error', message }
    }
  }
}
```

> 翻译说明：`toOpenAIMessages` 对「只含 tool_result 的 user 消息」只产出顶层 tool 消息、不再多发空 user 壳；assistant 同时含 text+tool_use 时合成一条带 `tool_calls` 的 assistant 消息。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test -- openai-client`
Expected: PASS（5 个用例）。

- [ ] **Step 6: typecheck**

Run: `pnpm -F @zuse/core typecheck`
Expected: 无错误。

- [ ] **Step 7: 提交（占位）**

```bash
git add packages/core/package.json pnpm-lock.yaml packages/core/src/openai-client.ts packages/core/src/openai-client.test.ts
git commit -m "phase 6.4: OpenAIClient —— 手搓 OpenAI 协议翻译与流式累积"
```

---

## Task 6.5: AnthropicClient —— 构造签名收敛 + cache_control 打标

**Files:**
- Modify: `packages/core/src/anthropic-client.ts`
- Test: `packages/core/src/anthropic-client.test.ts`

- [ ] **Step 1: 写失败测试** — 把 `anthropic-client.test.ts` 顶部对 client 的构造改为新签名，并新增 `buildAnthropicRequest` 的纯函数断言。替换文件为：

```typescript
import { describe, it, expect, beforeAll } from 'vitest'
import { AnthropicClient, buildAnthropicRequest } from './anthropic-client.js'
import { loadSettings, resolveModelSelection, getProviderConfig, getDefaultMaxTokens } from './settings.js'
import type { Message, StreamEvent } from './types.js'
import type { ToolDefinition } from './tool.js'

describe('buildAnthropicRequest cache_control', () => {
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'a' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
    { role: 'user', content: [{ type: 'text', text: 'c' }] },
  ]
  const tools: ToolDefinition[] = [
    { name: 'Read', description: 'r', input_schema: { type: 'object' } },
    { name: 'Bash', description: 'b', input_schema: { type: 'object' } },
  ]

  it('marks system as a cache breakpoint', () => {
    const req = buildAnthropicRequest(messages, { model: 'm', max_tokens: 10, system: 'SYS' }, tools)
    expect(Array.isArray(req.system)).toBe(true)
    expect((req.system as any)[0]).toMatchObject({ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } })
  })

  it('marks the last tool definition as a cache breakpoint', () => {
    const req = buildAnthropicRequest(messages, { model: 'm', max_tokens: 10 }, tools)
    const t = req.tools as any[]
    expect(t[0].cache_control).toBeUndefined()
    expect(t[1].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('marks the last message as a rolling cache breakpoint', () => {
    const req = buildAnthropicRequest(messages, { model: 'm', max_tokens: 10 }, tools)
    const msgs = req.messages as any[]
    const lastBlocks = msgs[msgs.length - 1].content
    expect(lastBlocks[lastBlocks.length - 1].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('omits system field entirely when no system prompt', () => {
    const req = buildAnthropicRequest(messages, { model: 'm', max_tokens: 10 }, tools)
    expect('system' in req).toBe(false)
  })
})

describe('AnthropicClient (live, skipped without key)', () => {
  let client: AnthropicClient | undefined
  const settings = loadSettings()
  const sel = resolveModelSelection(settings)

  beforeAll(() => {
    try {
      client = new AnthropicClient(getProviderConfig(settings, sel.providerId), sel.model)
    } catch {
      console.log('Skipping live AnthropicClient tests — no API key')
    }
  })

  it('returns model name', () => {
    if (!client) return
    expect(client.getModel()).toBeTruthy()
  })

  it('streams and tracks usage', async () => {
    if (!client) return
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'Say exactly: hello world' }] }]
    const events: StreamEvent[] = []
    for await (const e of client.sendMessages(messages, { model: sel.model, max_tokens: getDefaultMaxTokens(settings) })) {
      events.push(e)
    }
    expect(events.find((e) => e.type === 'message-start')).toBeTruthy()
    expect(events.find((e) => e.type === 'message-stop')).toBeTruthy()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- anthropic-client`
Expected: FAIL（`buildAnthropicRequest` 未定义；构造签名不匹配）。

- [ ] **Step 3: 重写 `anthropic-client.ts`** — 整文件替换为：

```typescript
import Anthropic from '@anthropic-ai/sdk'
import type { Message, StreamEvent, ModelConfig, ProviderConfig, Usage } from './types.js'
import type { ModelClient } from './model-client.js'
import type { ToolDefinition } from './tool.js'

const CACHE: Anthropic.CacheControlEphemeral = { type: 'ephemeral' }

/**
 * 组装 messages.stream() 的入参（纯函数，便于测试缓存打标）。
 * 缓存断点：system、最后一个 tool 定义、最后一条消息的最后一个块（滚动）。
 */
export function buildAnthropicRequest(
  messages: Message[],
  config: ModelConfig,
  tools?: ToolDefinition[],
): Anthropic.MessageStreamParams {
  const sdkMessages: Anthropic.MessageParam[] = messages.map((m) => ({
    role: m.role,
    content: m.content.map((block): Anthropic.ContentBlockParam => {
      if (block.type === 'text') return { type: 'text', text: block.text }
      if (block.type === 'tool_use')
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: block.content,
        is_error: block.is_error,
      }
    }),
  }))

  // 滚动断点：给最后一条消息的最后一个内容块挂 cache_control。
  const last = sdkMessages[sdkMessages.length - 1]
  if (last && Array.isArray(last.content) && last.content.length > 0) {
    const lastBlock = last.content[last.content.length - 1] as Anthropic.ContentBlockParam
    ;(lastBlock as { cache_control?: Anthropic.CacheControlEphemeral }).cache_control = CACHE
  }

  const sdkTools: Anthropic.Tool[] | undefined =
    tools && tools.length > 0
      ? tools.map((t, i) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as Anthropic.Tool.InputSchema,
          // 最后一个工具定义挂断点 → 整个 tools 块进缓存。
          ...(i === tools.length - 1 ? { cache_control: CACHE } : {}),
        }))
      : undefined

  return {
    model: config.model,
    max_tokens: config.max_tokens,
    messages: sdkMessages,
    ...(config.system ? { system: [{ type: 'text', text: config.system, cache_control: CACHE }] } : {}),
    ...(sdkTools ? { tools: sdkTools } : {}),
  }
}

/**
 * AnthropicClient —— 用 @anthropic-ai/sdk 实现 ModelClient。
 * 适用于 Anthropic 原生 API 及兼容 Anthropic 协议的端点（DashScope 等）。
 */
export class AnthropicClient implements ModelClient {
  private client: Anthropic
  private model: string

  constructor(provider: ProviderConfig, model: string) {
    this.client = new Anthropic({ apiKey: provider.apiKey, baseURL: provider.baseURL })
    this.model = model
  }

  getModel(): string {
    return this.model
  }

  async *sendMessages(
    messages: Message[],
    config: ModelConfig,
    tools?: ToolDefinition[],
  ): AsyncIterable<StreamEvent> {
    const params = buildAnthropicRequest(messages, { ...config, model: config.model || this.model }, tools)
    try {
      const stream = this.client.messages.stream(params)
      for await (const event of stream) {
        if (event.type === 'message_start') {
          yield { type: 'message-start', id: event.message.id, model: event.message.model }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') yield { type: 'text-delta', text: event.delta.text }
        } else if (event.type === 'message_delta') {
          if (event.delta.stop_reason) {
            const finalMessage = await stream.finalMessage()
            for (const block of finalMessage.content) {
              if (block.type === 'tool_use') {
                yield { type: 'tool-use', id: block.id, name: block.name, input: block.input }
              }
            }
            const u = finalMessage.usage
            const usage: Usage = {
              input_tokens: u.input_tokens,
              output_tokens: u.output_tokens,
              cache_read_input_tokens: u.cache_read_input_tokens ?? undefined,
              cache_creation_input_tokens: u.cache_creation_input_tokens ?? undefined,
            }
            yield { type: 'message-stop', stop_reason: event.delta.stop_reason, usage }
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      yield { type: 'error', message }
    }
  }
}
```

> 注意：旧 `anthropic-client.ts` 顶部对 `getClientConfig` / `getDefaultModel`（前置重构后从 `./settings.js` 导入）的 import 一并删除 —— client 不再自己解析 settings，构造只收 `ProviderConfig + model`。统一入口 `createClientFromSettings` 在 6.6 落到 `settings.ts`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- anthropic-client`
Expected: PASS（4 个 cache 用例通过；live 用例无 key 时跳过）。

- [ ] **Step 5: 提交（占位）**

```bash
git add packages/core/src/anthropic-client.ts packages/core/src/anthropic-client.test.ts
git commit -m "phase 6.5: AnthropicClient 构造收敛 + cache_control 三断点打标"
```

---

## Task 6.6: client 工厂 + createClientFromSettings + 导出

**Files:**
- Modify: `packages/core/src/model-client.ts`
- Modify: `packages/core/src/settings.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/model-client.test.ts`（新）

- [ ] **Step 1: 写失败测试（新建 `model-client.test.ts`）**

```typescript
import { describe, it, expect } from 'vitest'
import { createModelClient } from './model-client.js'
import { AnthropicClient } from './anthropic-client.js'
import { OpenAIClient } from './openai-client.js'
import type { ProviderConfig } from './types.js'

const anthropic: ProviderConfig = { id: 'q', protocol: 'anthropic', baseURL: 'https://h', apiKey: 'k', models: [] }
const openai: ProviderConfig = { id: 'd', protocol: 'openai', baseURL: 'https://h/v1', apiKey: 'k', models: [] }

describe('createModelClient', () => {
  it('builds an AnthropicClient for protocol "anthropic"', () => {
    const c = createModelClient(anthropic, 'm')
    expect(c).toBeInstanceOf(AnthropicClient)
    expect(c.getModel()).toBe('m')
  })
  it('builds an OpenAIClient for protocol "openai"', () => {
    const c = createModelClient(openai, 'm')
    expect(c).toBeInstanceOf(OpenAIClient)
    expect(c.getModel()).toBe('m')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- model-client`
Expected: FAIL（`createModelClient` 未定义）。

- [ ] **Step 3: 在 `model-client.ts` 末尾加工厂**

```typescript
import type { ProviderConfig } from './types.js'
import { AnthropicClient } from './anthropic-client.js'
import { OpenAIClient } from './openai-client.js'

/** 按 provider 协议选具体实现。clients 仅 type-only 依赖本文件，无运行时环。 */
export function createModelClient(provider: ProviderConfig, model: string): ModelClient {
  switch (provider.protocol) {
    case 'anthropic':
      return new AnthropicClient(provider, model)
    case 'openai':
      return new OpenAIClient(provider, model)
    default: {
      const _exhaustive: never = provider.protocol
      throw new Error(`Unknown provider protocol: ${String(_exhaustive)}`)
    }
  }
}
```

（`import type { Message, ... }` 那行原样保留在文件顶部；上面这段新 import 放文件顶部 import 区。）

- [ ] **Step 4: 在 `settings.ts` 加统一入口**

顶部 import 区加（`ResolvedSettings` 已导入）：

```typescript
import { createModelClient } from './model-client.js'
import type { ModelClient } from './model-client.js'
```

文件末尾加：

```typescript
/** 从 settings 解析选中项 + provider 配置，造出对应 client。TUI 启动入口。 */
export function createClientFromSettings(settings: ResolvedSettings): ModelClient {
  const sel = resolveModelSelection(settings)
  return createModelClient(getProviderConfig(settings, sel.providerId), sel.model)
}
```

> 无环检查：`settings.ts → model-client.ts → {anthropic,openai}-client.ts → types.ts`；后两个 client 只 `type`-only 依赖 `model-client.ts`，不回指 `settings.ts`，故无运行时循环。

- [ ] **Step 5: 改 `index.ts` 导出** — 确认导出包含 `model-client.js`、`openai-client.js`。在现有 export 区加：

```typescript
export * from './openai-client.js'
```

（`model-client.js`、`settings.js`、`anthropic-client.js` 已在导出列表中，无需重复；`env.js` 已被前置重构从导出列表移除。`createModelClient` 随 `model-client.js`；`createClientFromSettings` / `resolveModelSelection` / `getProviderConfig` 随 `settings.js` 的 `export *` 自动带出。）

- [ ] **Step 6: 跑全量测试 + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿（包含 6.1–6.6 所有用例）。

- [ ] **Step 7: 提交（占位）**

```bash
git add packages/core/src/model-client.ts packages/core/src/settings.ts packages/core/src/index.ts packages/core/src/model-client.test.ts
git commit -m "phase 6.6: client 工厂 + createClientFromSettings + 导出"
```

---

## Task 6.7: setModelInSettings —— /model --save 写盘

**Files:**
- Modify: `packages/core/src/settings.ts`
- Test: `packages/core/src/settings.test.ts`

- [ ] **Step 1: 写失败测试（`settings.test.ts` 追加）**

```typescript
import { setModelInSettings } from './settings.js' // 顶部 import 合并进现有那一行

describe('setModelInSettings', () => {
  it('writes the model field, creating the file if absent', () => {
    setModelInSettings('qwen/qwen3-max', p('l.json'))
    const data = JSON.parse(readFileSync(p('l.json'), 'utf8'))
    expect(data.model).toBe('qwen/qwen3-max')
  })

  it('updates only the model field, preserving other content', () => {
    writeFileSync(p('l.json'), JSON.stringify({ model: 'old', maxTokens: 8192, providers: { x: { apiKey: 'k' } } }, null, 2))
    setModelInSettings('deepseek/deepseek-chat', p('l.json'))
    const data = JSON.parse(readFileSync(p('l.json'), 'utf8'))
    expect(data.model).toBe('deepseek/deepseek-chat')
    expect(data.maxTokens).toBe(8192)
    expect(data.providers.x.apiKey).toBe('k')
  })

  it('is idempotent (same model → no error, value unchanged)', () => {
    writeFileSync(p('l.json'), JSON.stringify({ model: 'a/b' }))
    setModelInSettings('a/b', p('l.json'))
    expect(JSON.parse(readFileSync(p('l.json'), 'utf8')).model).toBe('a/b')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- settings`
Expected: FAIL（`setModelInSettings` 未定义）。

- [ ] **Step 3: 实现（`settings.ts` 末尾）** — 仿 `appendAllowRule`：

```typescript
/**
 * 把顶层 `model` 写入本地层 settings.local.json，保留注释与格式（jsonc）。
 * 文件/目录不存在则创建。只改 model 一处。
 * @param localPath 省略时取 <项目根>/.zuse/settings.local.json
 */
export function setModelInSettings(model: string, localPath?: string): void {
  const basePath = localPath ?? join(findProjectRoot(), '.zuse', 'settings.local.json')
  const path = resolveLayerPath(basePath)
  let text = '{}'
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf8')
      if (raw.trim()) text = raw
    } catch {
      text = '{}'
    }
  }
  const edits = modify(text, ['model'], model, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  const updated = applyEdits(text, edits)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, updated.endsWith('\n') ? updated : updated + '\n', 'utf8')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- settings`
Expected: PASS。

- [ ] **Step 5: 提交（占位）**

```bash
git add packages/core/src/settings.ts packages/core/src/settings.test.ts
git commit -m "phase 6.7: setModelInSettings —— /model --save 写盘"
```

---

## Task 6.8: TUI —— client 热替换 + /model 命令 + footer cache（手工验证）

**Files:**
- Modify: `packages/tui/src/App.tsx`
- Modify: `packages/tui/src/hooks/useConversation.ts`
- Modify: `packages/tui/src/commands/types.ts`
- Modify: `packages/tui/src/commands/registry.ts`
- Modify: `packages/tui/src/components/UsageFooter.tsx`

> TUI 不写自动化测试（项目惯例）。每步改完后用 `pnpm dev` 手工过 Step 7 清单。

- [ ] **Step 1: `App.tsx` —— 把 client 所有权交给 hook**

只解析 settings（不再 new client）；把 settings 传给 hook；footer 的 model 改读 hook 的 `currentModel`：

```tsx
import { getDefaultMaxTokens, loadSettings, type ResolvedSettings } from '@zuse/core'
// 删除 createAnthropicClient 的 import

export function App({ cwd }: AppProps) {
  let settings: ResolvedSettings | null = null
  let initError: string | undefined
  try {
    settings = loadSettings()
  } catch (err) {
    initError = err instanceof Error ? err.message : 'Failed to load settings'
  }

  const resolved = settings ?? { tools: {}, permissions: { defaultMode: 'default', allow: [], ask: [], deny: [] }, providers: {} }
  const { state, submit, pendingPermission, resolvePermission, currentModel, clientError } = useConversation({
    maxTokens: getDefaultMaxTokens(resolved),
    registry,
    cwd,
    settings: resolved,
  })

  if (initError || clientError) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red" bold>Error: {initError ?? clientError}</Text>
        <Text dimColor>请检查 ~/.zuse/settings.json 或 .zuse/settings.local.json 配置。</Text>
      </Box>
    )
  }
  // …其余 JSX 不变，只把 <UsageFooter model={...}/> 改为 model={currentModel}
```

`UsageFooter` 的 `model` 改成 `model={currentModel}`。

- [ ] **Step 2: `useConversation.ts` —— clientRef / currentModel / switchModel**

改 options：去掉 `client`，加 `settings` 已有；新增返回 `currentModel`、`clientError`、`switchModel`。核心改动：

```typescript
import {
  Conversation, runAgent, createFileTracker, createClientFromSettings, createModelClient,
  resolveModelSelection, getProviderConfig, setModelInSettings,
  type ModelClient, type ToolRegistry, type FileReadTracker, type ResolvedSettings,
  type PermissionRequest, type PermissionVerdict, type ModelSelection,
} from '@zuse/core'

interface UseConversationOptions {
  maxTokens: number
  registry: ToolRegistry
  cwd: string
  settings: ResolvedSettings
}

// 在 hook 体内、state 定义附近：
const clientRef = useRef<ModelClient | null>(null)
const [currentModel, setCurrentModel] = useState<string>('unknown')
const [clientError, setClientError] = useState<string | undefined>(undefined)

// 首次构建 client（懒初始化，放进一个 useEffect 或就地 try）：
if (clientRef.current === null && !clientError) {
  try {
    const c = createClientFromSettings(settings)
    clientRef.current = c
    // 注意：setState 不能在渲染体内裸调；用 useEffect 初始化更稳。见下方实现注记。
  } catch (err) {
    setClientError(err instanceof Error ? err.message : 'Failed to init client')
  }
}
```

**实现注记（避免渲染期 setState）：** 用一个 `useEffect(() => { ... }, [])` 做首次初始化：

```typescript
useEffect(() => {
  try {
    clientRef.current = createClientFromSettings(settings)
    setCurrentModel(clientRef.current.getModel())
  } catch (err) {
    setClientError(err instanceof Error ? err.message : 'Failed to init client')
  }
}, []) // settings 启动后不变，空依赖即可
```

`sendMessage` 内对 `client` 的引用改成 `clientRef.current`（开头判空：`if (!clientRef.current) { setState(error) ; return }`），`config.model` 用 `clientRef.current.getModel()`。

新增 `switchModel`：

```typescript
const switchModel = useCallback((sel: ModelSelection, persist: boolean): string => {
  try {
    const provider = getProviderConfig(settings, sel.providerId)
    clientRef.current = createModelClient(provider, sel.model)
    setCurrentModel(sel.model)
    if (persist) setModelInSettings(`${sel.providerId}/${sel.model}`)
    return `已切换到 ${sel.providerId}/${sel.model}${persist ? '（已写盘）' : ''}`
  } catch (err) {
    return `切换失败：${err instanceof Error ? err.message : String(err)}`
  }
}, [settings])
```

把 `switchModel`、`currentModel`、`clientError` 加进 hook 返回值，并把 `switchModel` + `currentModel` 注入 `CommandContext`（在 `submit` 构造 ctx 处）。

- [ ] **Step 3: `commands/types.ts` —— 扩 CommandContext**

```typescript
import type { Conversation, ResolvedSettings, ModelSelection } from '@zuse/core'

export interface CommandContext {
  args: string
  print: (text: string) => void
  clear: () => void
  conversation: Conversation
  load: (conversation: Conversation) => void
  settings: ResolvedSettings
  /** 当前选中的 model 名（用于 /model 列表标星）。 */
  currentModel: string
  /** 切换 model；persist=true 时写盘。返回给用户看的提示串。 */
  switchModel: (sel: ModelSelection, persist: boolean) => string
}
```

- [ ] **Step 4: `commands/registry.ts` —— /model 命令**

```typescript
import { resolveModelSelection } from '@zuse/core'

const model: SlashCommand = {
  name: 'model',
  description: 'List or switch model: /model [<provider/model>] [--save]',
  run: ({ args, settings, currentModel, switchModel, print }) => {
    // 无参：列出所有 provider × model 组合，标当前项。
    if (!args) {
      const lines: string[] = ['可用模型（* = 当前）:']
      for (const [id, p] of Object.entries(settings.providers)) {
        const models = p.models && p.models.length ? p.models : ['(未列出，可自由输入)']
        for (const m of models) {
          const star = m === currentModel ? '*' : ' '
          lines.push(`  ${star} ${id}/${m}`)
        }
      }
      if (Object.keys(settings.providers).length === 0) {
        lines.push('  (未配置 providers；当前用扁平配置的 default provider)')
      }
      print(lines.join('\n'))
      return
    }
    // 有参：解析 --save 标志，其余作为 model 引用。
    const parts = args.split(/\s+/)
    const persist = parts.includes('--save')
    const ref = parts.filter((x) => x !== '--save').join(' ')
    if (!ref) {
      print('Usage: /model <provider/model> [--save]')
      return
    }
    const sel = ref.includes('/')
      ? resolveModelSelection({ ...settings, model: ref })
      : { providerId: resolveModelSelection(settings).providerId, model: ref } // 无斜杠 → 当前 provider 下换 model
    print(switchModel(sel, persist))
  },
}

// 加进 COMMANDS 表：
export const COMMANDS: SlashCommand[] = [help, config, model, clear, save, load]
```

> `help` 命令的 `padEnd(6)` 对 `model`（5 字）够用，无需改。

- [ ] **Step 5: `UsageFooter.tsx` —— 显示 cache 命中**

在 totalUsage 展示处加缓存读取（若 > 0）。先看现有渲染：

Run: `grep -n "totalUsage\|input_tokens\|output_tokens" packages/tui/src/components/UsageFooter.tsx`

在显示 token 总计的那行后追加一段（按文件现有 JSX 风格）：

```tsx
{totalUsage && (totalUsage.cache_read_input_tokens ?? 0) > 0 && (
  <Text dimColor> · cache {(((totalUsage.cache_read_input_tokens ?? 0) / 1000)).toFixed(1)}k read</Text>
)}
```

- [ ] **Step 6: typecheck**

Run: `pnpm typecheck`
Expected: 全包无错误（core + tui）。

- [ ] **Step 7: 手工验证（`pnpm dev`，逐条过）**

先把 `.zuse/settings.local.jsonc` 临时配上至少两个 provider（见 Task 6.9 的迁移内容），然后：

- [ ] `/model`（无参）列出所有 `provider/model` 组合，当前项带 `*`。
- [ ] `/model qwen/qwen3-max` 切换后，footer 模型名变成 `qwen3-max`；历史不清空，可继续对话。
- [ ] `/model deepseek/deepseek-chat --save` 后，`.zuse/settings.local.jsonc` 顶层 `model` 被改为该值、原有注释与 providers 仍在；重启 `pnpm dev` 默认即新模型。
- [ ] 配一个 OpenAI 协议 provider（DeepSeek 或本地 Ollama），切过去跑一轮**带工具调用**的对话（如「读一下 README」），确认 tool_call 往返正常、结果回填。
- [ ] 留在 Anthropic provider 多聊几轮，footer 出现 `cache … read` 且数字随轮次上升。

- [ ] **Step 8: 提交（占位）**

```bash
git add packages/tui/src
git commit -m "phase 6.8: TUI client 热替换 + /model 命令 + footer cache 显示"
```

---

## Task 6.9: 配置迁移 + 文档收尾

**Files:**
- Modify: `.zuse/settings.local.jsonc`
- Modify: `.zuse/settings.local.json.example`
- Modify: `.env.example`
- Modify: `BACKLOG.md`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/phase-roadmap.md`

- [ ] **Step 1: 迁移 `.zuse/settings.local.json.example` 到 registry 结构**

```jsonc
{
  "model": "qwen/qwen3-coder-plus",
  "maxTokens": 4096,
  "providers": {
    "qwen": {
      "protocol": "anthropic",
      "baseURL": "https://dashscope.aliyuncs.com/apps/anthropic",
      "apiKey": "sk-REPLACE_ME",
      "models": ["qwen3-coder-plus", "qwen3-max"]
    },
    "deepseek": {
      "protocol": "openai",
      "baseURL": "https://api.deepseek.com/v1",
      "apiKey": "sk-REPLACE_ME",
      "models": ["deepseek-chat"]
    },
    "ollama": {
      "protocol": "openai",
      "baseURL": "http://localhost:11434/v1",
      "apiKey": "ollama",
      "models": ["qwen2.5-coder"]
    }
  },
  "permissions": {
    "defaultMode": "default",
    "allow": ["Read(./**)", "Grep", "Glob"],
    "ask": ["Bash(*)", "Write(./**)", "Edit(./**)"],
    "deny": ["Read(./.env)", "Read(./**/.env)", "Bash(rm -rf *)"]
  }
}
```

- [ ] **Step 2: 迁移本地实配 `.zuse/settings.local.jsonc`** — 把现有扁平的 `model`/`baseURL`/`apiKey`（DashScope qwen）改写成上面 registry 结构里的 `qwen` 条目，`model` 顶层改为 `"qwen/<现有模型名>"`。保留现有 permissions 块原样。**用现有真实 key**，不要写占位。

> 备注：因为 6.3 做了向后兼容，这步即使不迁移、保持扁平也能跑（合成 default provider）；但迁移后才能演示 `/model` 跨 provider 切换。

- [ ] **Step 3: 更新 `.env.example`** — 顶部加一段说明，env 仅用于覆盖 key：

```bash
# 配置主入口是 .zuse/settings.local.json(c) 的 providers registry。
# 环境变量仅用于覆盖 key（CI / 不想把 key 落盘时）：
#   ZUSE_API_KEY_<PROVIDER_ID>   覆盖某 provider 的 key（id 大写），如 ZUSE_API_KEY_QWEN
#   ZUSE_API_KEY                 覆盖当前选中 provider 的 key（遗留）
#   ZUSE_MAX_TOKENS              覆盖 maxTokens
```

（保留文件其余历史说明或按需精简。）

- [ ] **Step 4: `BACKLOG.md` 加一条**

```markdown
- **未来可换 Vercel AI SDK（挂 Phase 6 之后 · 可选）。** 现状：Phase 6 手搓 `AnthropicClient` / `OpenAIClient`，吃透两套 tool_use / 流式 / usage 差异（学习目标）。`ModelClient` 这个 seam 留好了——若日后 zuse 转向生产工具、想省维护，把两个 client 换成 `ai` + `@ai-sdk/*` 适配器是局部改动，接口 / agent loop / TUI 全不动。触发条件：要加的 provider 越来越多、边界 case 维护成本超过学习收益时。
```

- [ ] **Step 5: 更新 `README.md` 状态段** — 在 Phase 5 段之前加 Phase 6 完成说明（仿现有行文）：

```markdown
Phase 6: Done. 多 provider。`ModelClient` 接口下两套手搓实现——`AnthropicClient`
（Anthropic 原生 + DashScope 等兼容端点，含 prompt 缓存 cache_control 三断点）与
`OpenAIClient`（OpenAI 协议：DeepSeek / 本地 Ollama / vLLM，手写 tool_call 分片累积
与 usage 抽取）。数据驱动的 `providers` registry：加 provider = 一条配置 + 一个
env var。`/model` 运行时切换（session 生效，`--save` 写盘），切换不清空历史。footer
显示缓存命中。下一步：Phase 6.5 联网工具 / Phase 7 UI 打磨。
```

并把 Phase 5 段末「Next: …」一类指引顺手更新。

- [ ] **Step 6: 更新 `phase-roadmap.md`** — 在「## Phase 6: 多Provider」段末仿 Phase 5 加一段 `### ✅ 已实现（2026-06-05）`，链到本 plan 与 spec，列落地要点（registry / 两 client / /model / cache）。

- [ ] **Step 7: 全量回归**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: 全绿。

- [ ] **Step 8: 提交（占位）**

```bash
git add .zuse/settings.local.json.example .env.example BACKLOG.md README.md docs/superpowers/plans/phase-roadmap.md
# 注意：.zuse/settings.local.jsonc 含真实 key 且已 gitignore，不要 add。
git commit -m "phase 6.9: 配置迁移到 providers registry + 文档收尾"
```

---

## Self-Review 记录

- **Spec 覆盖：** §3 配置→6.2/6.3/6.9；§4 两 client+工厂→6.4/6.5/6.6；§5 /model→6.7/6.8；§6 缓存→6.1/6.5/6.8；§7 测试→各 task TDD + 6.8 手工清单；§8 文件清单→全覆盖；§9 风险（多并发 tool_call index 累积）→6.4 测试已覆盖。
- **类型一致：** `ProviderConfig`/`ModelSelection`/`RawProviderConfig`（6.2 定义）在 6.3/6.4/6.5/6.6 一致引用；`createModelClient(provider, model)`、`createClientFromSettings(settings)`、`getProviderConfig(settings, id)`、`resolveModelSelection(settings)`、`switchModel(sel, persist)`、`setModelInSettings(model, path?)` 跨 task 签名统一。
- **无占位：** 所有 code step 均含完整代码 / 命令 / 预期。
- **已知衔接点：** 6.3 移除 `getClientConfig`/`getDefaultModel` 会暂时打断 `anthropic-client.ts`（6.5 修）与 `ping-api.ts`（6.3 Step 4 临时处理）；执行顺序须 6.3→6.4→6.5→6.6，中途单包 typecheck 可能红，到 6.6 Step 6 全绿。
