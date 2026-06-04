# Phase 5：设置系统与权限模型 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 zuse 加一套对齐 Claude Code 的三层 `settings.json` 配置系统，并在其上构建 allow / ask / deny + defaultMode 的权限模型，含 `ask` 交互式批准（本会话允许 / 写盘持久两档）。

**Architecture:** 自底向上分层落地——先类型，再 `settings.ts`（加载/合并/写回），再 `permission.ts`（纯判定，零 I/O），再把判定接入 `agent.ts` 的工具执行闸门，最后 TUI 弹批准框。core 侧全程 TDD（vitest，node 环境）；TUI 侧按本仓库既有惯例（目前 TUI 零自动化测试）做手工验证。

**Tech Stack:** TypeScript（ESM，`.js` 扩展名 import）、Node 22 内置 `fs`/`path`/`os`、vitest、ink（TUI）。

---

## 关于提交与测试的两条全局约定（执行者必读）

1. **不自动提交。** 用户的长期偏好是"做完并跑过检查后，把改动留着不提交，等用户明确要求再提交"。因此本计划每个任务的收尾步骤是**跑测试 + typecheck**（checkpoint），**不含 `git commit`**。全部任务完成、用户审阅后再由用户决定提交。
2. **测试命令。**
   - 单文件：`pnpm exec vitest run packages/core/src/<file>.test.ts`
   - 按用例名：`pnpm exec vitest run packages/core/src/<file>.test.ts -t "<片段>"`
   - 全量：`pnpm test`
   - 类型检查：`pnpm -F @zuse/core typecheck`（或 `pnpm -r typecheck` 全量）
   - 注意 vitest 只收集 `packages/*/src/**/*.test.ts`（见 `vitest.config.ts`），所有新测试必须是 `.test.ts`。

---

## 文件结构（决定拆分边界）

**新增**
- `packages/core/src/settings.ts` —— 三层加载、合并、`findProjectRoot`、写回 `appendAllowRule`。
- `packages/core/src/settings.test.ts`
- `packages/core/src/permission.ts` —— 规则文法解析、匹配器、`decide` 判定。纯函数，零 I/O。
- `packages/core/src/permission.test.ts`
- `packages/tui/src/components/PermissionDialog.tsx` —— 批准对话框（ink `useInput` 捕获按键）。
- `<repo>/.zuse/settings.local.json` —— 开发期配置 + key（gitignored，手工创建）。

**改动**
- `packages/core/src/types.ts` —— 加权限/设置相关类型。
- `packages/core/src/tool.ts` —— `Tool` 加 `readOnly?`/`specifierFor?`；`getDefinitions(toolsConfig?)` 过滤。
- `packages/core/src/agent.ts` —— `RunAgentOptions` 加 `settings`/`canUseTool`/`sessionAllow`/`onPersistAllow`；工具执行前加判定闸门。
- `packages/core/src/env.ts` —— 删 dotenv 加载；`findProjectRoot` 迁到 settings.ts；`getClientConfig`/`getDefaultModel`/`getDefaultMaxTokens` 改为接收 `ResolvedSettings`。
- `packages/core/src/anthropic-client.ts` —— `createAnthropicClientFromEnv` 改为 `createAnthropicClient(settings)`。
- `packages/core/src/anthropic-client.test.ts` —— 跟随新签名。
- `packages/core/src/index.ts` —— 导出 settings / permission。
- `packages/tools/src/{read,write,edit,ls,glob,grep,bash}.ts` —— 各补 `readOnly`/`specifierFor`。
- `packages/tui/src/hooks/useConversation.ts` —— 接 `settings`、`canUseTool`、`pendingPermission` 状态。
- `packages/tui/src/App.tsx` —— 启动加载 settings、渲染对话框。
- `scripts/ping-api.ts` —— 改用 `loadSettings()` 读 key（`.env` 将被删）。
- `.gitignore` —— 加 `.zuse/settings.local.json`。
- `.env` 删除；`.env.example` 由 `.zuse/settings.local.json` 示例替代。

---

## Task 1：类型定义（types.ts）

**Files:**
- Modify: `packages/core/src/types.ts`（在文件末尾追加）

纯类型，无独立测试，靠后续任务的 typecheck 兜底。

- [ ] **Step 1: 在 `packages/core/src/types.ts` 末尾追加以下类型**

```ts
// ——— Phase 5：设置与权限 ———

/** 权限模式（对齐 CC，本期不含 plan）。 */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions'

/** 工具暴露开关。enabled 在场 → 只暴露交集；disabled → 黑名单。 */
export interface ToolsConfig {
  enabled?: string[]
  disabled?: string[]
}

/** permissions 块（合并后，数组与 defaultMode 一定有值）。 */
export interface PermissionsConfig {
  defaultMode: PermissionMode
  allow: string[]
  ask: string[]
  deny: string[]
}

/** 三层合并、补默认值后的最终设置。供 TUI 与 agent 使用。 */
export interface ResolvedSettings {
  model?: string
  maxTokens?: number
  baseURL?: string
  apiKey?: string
  tools: ToolsConfig
  permissions: PermissionsConfig
}

/** 判定结果三态。 */
export type PermissionDecision = 'allow' | 'deny' | 'ask'

/** ask 时交给 canUseTool 的请求载体。rule 是预先算好的待追加规则字符串。 */
export interface PermissionRequest {
  toolName: string
  input: unknown
  /** 命令（Bash）或路径（文件工具）；无则 null。 */
  specifier: string | null
  /** 用于会话覆盖 / 写盘的规则字符串，如 `Bash(git status)` / `Write(./a.ts)`。 */
  rule: string
}

/** 用户对一次 ask 的裁决（方案 A 回调返回）。 */
export type PermissionVerdict = 'allow' | 'deny' | 'allow_session' | 'allow_persist'
```

- [ ] **Step 2: typecheck**

Run: `pnpm -F @zuse/core typecheck`
Expected: PASS（仅新增类型，无引用错误）

---

## Task 2：settings.ts —— 三层加载与合并

**Files:**
- Create: `packages/core/src/settings.ts`
- Create: `packages/core/src/settings.test.ts`

设计要点：`loadSettings` 接收可选的三个文件路径（默认从 `homedir()` 与 `findProjectRoot()` 推导），测试通过传入临时目录路径来隔离文件系统。合并顺序 **用户 < 项目 < 本地**：标量高层覆盖、permission 三数组跨层拼接、tools 浅合并；最后 `process.env.ZUSE_API_KEY` 覆盖 apiKey。

- [ ] **Step 1: 写失败测试 `packages/core/src/settings.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadSettings, appendAllowRule } from './settings.js'

let dir: string
const p = (name: string): string => join(dir, name)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zuse-settings-'))
  delete process.env.ZUSE_API_KEY
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.ZUSE_API_KEY
})

describe('loadSettings', () => {
  it('returns defaults when no files exist', () => {
    const s = loadSettings({ userPath: p('u.json'), projectPath: p('pj.json'), localPath: p('l.json') })
    expect(s.permissions.defaultMode).toBe('default')
    expect(s.permissions.allow).toEqual([])
    expect(s.tools).toEqual({})
    expect(s.apiKey).toBeUndefined()
  })

  it('local overrides user for scalars; permission arrays concatenate', () => {
    writeFileSync(p('u.json'), JSON.stringify({
      model: 'user-model', apiKey: 'user-key',
      permissions: { allow: ['Read(./**)'], deny: ['Read(./.env)'] },
    }))
    writeFileSync(p('l.json'), JSON.stringify({
      model: 'local-model', apiKey: 'local-key',
      permissions: { defaultMode: 'acceptEdits', allow: ['Bash(git status)'] },
    }))
    const s = loadSettings({ userPath: p('u.json'), projectPath: p('pj.json'), localPath: p('l.json') })
    expect(s.model).toBe('local-model')          // 高层覆盖
    expect(s.apiKey).toBe('local-key')
    expect(s.permissions.defaultMode).toBe('acceptEdits')
    expect(s.permissions.allow).toEqual(['Read(./**)', 'Bash(git status)']) // 跨层拼接
    expect(s.permissions.deny).toEqual(['Read(./.env)'])
  })

  it('ZUSE_API_KEY env overrides file apiKey', () => {
    writeFileSync(p('l.json'), JSON.stringify({ apiKey: 'file-key' }))
    process.env.ZUSE_API_KEY = 'env-key'
    const s = loadSettings({ userPath: p('u.json'), projectPath: p('pj.json'), localPath: p('l.json') })
    expect(s.apiKey).toBe('env-key')
  })

  it('throws a file-identifying error on bad JSON', () => {
    writeFileSync(p('l.json'), '{ not json')
    expect(() => loadSettings({ userPath: p('u.json'), projectPath: p('pj.json'), localPath: p('l.json') }))
      .toThrow(/l\.json/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/core/src/settings.test.ts -t "loadSettings"`
Expected: FAIL —— `loadSettings` 尚未定义（模块解析失败）。

- [ ] **Step 3: 写 `packages/core/src/settings.ts`（含 `findProjectRoot`、`loadSettings`；`appendAllowRule` 在 Task 3 补）**

```ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { cwd } from 'node:process'
import type { ResolvedSettings, PermissionMode } from './types.js'

/** 通过查找 pnpm-workspace.yaml 定位项目根（从 env.ts 迁来，统一出口）。 */
export function findProjectRoot(): string {
  let dir = cwd()
  while (dir !== resolve(dir, '..')) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir
    dir = resolve(dir, '..')
  }
  return cwd()
}

/** 单层文件的原始（未补默认值）形状，全部可选。 */
interface RawSettings {
  model?: string
  maxTokens?: number
  baseURL?: string
  apiKey?: string
  tools?: { enabled?: string[]; disabled?: string[] }
  permissions?: {
    defaultMode?: PermissionMode
    allow?: string[]
    ask?: string[]
    deny?: string[]
  }
}

export interface LoadSettingsOptions {
  userPath?: string
  projectPath?: string
  localPath?: string
}

/** 读取并解析一层；文件缺失返回空对象，解析失败抛出指明文件名的错误。 */
function readLayer(path: string): RawSettings {
  if (!existsSync(path)) return {}
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to read settings file ${path}: ${msg}`)
  }
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('top-level value must be a JSON object')
    }
    return parsed as RawSettings
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to parse settings file ${path}: ${msg}`)
  }
}

/** 低 → 高 合并：标量高层覆盖、permission 数组跨层拼接、tools 浅合并。 */
function mergeLayers(layers: RawSettings[]): ResolvedSettings {
  const out: ResolvedSettings = {
    tools: {},
    permissions: { defaultMode: 'default', allow: [], ask: [], deny: [] },
  }
  for (const layer of layers) {
    if (layer.model !== undefined) out.model = layer.model
    if (layer.maxTokens !== undefined) out.maxTokens = layer.maxTokens
    if (layer.baseURL !== undefined) out.baseURL = layer.baseURL
    if (layer.apiKey !== undefined) out.apiKey = layer.apiKey
    if (layer.tools) out.tools = { ...out.tools, ...layer.tools }
    const pm = layer.permissions
    if (pm) {
      if (pm.defaultMode !== undefined) out.permissions.defaultMode = pm.defaultMode
      if (pm.allow) out.permissions.allow.push(...pm.allow)
      if (pm.ask) out.permissions.ask.push(...pm.ask)
      if (pm.deny) out.permissions.deny.push(...pm.deny)
    }
  }
  const envKey = process.env.ZUSE_API_KEY
  if (envKey) out.apiKey = envKey
  return out
}

/** 三层加载 + 合并。优先级 用户 < 项目 < 本地。 */
export function loadSettings(opts: LoadSettingsOptions = {}): ResolvedSettings {
  const root = findProjectRoot()
  const userPath = opts.userPath ?? join(homedir(), '.zuse', 'settings.json')
  const projectPath = opts.projectPath ?? join(root, '.zuse', 'settings.json')
  const localPath = opts.localPath ?? join(root, '.zuse', 'settings.local.json')
  return mergeLayers([readLayer(userPath), readLayer(projectPath), readLayer(localPath)])
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run packages/core/src/settings.test.ts -t "loadSettings"`
Expected: PASS（4 个用例全绿）

- [ ] **Step 5: checkpoint**

Run: `pnpm -F @zuse/core typecheck`
Expected: PASS

---

## Task 3：settings.ts —— 写回 `appendAllowRule`

**Files:**
- Modify: `packages/core/src/settings.ts`
- Modify: `packages/core/src/settings.test.ts`

把一条 allow 规则追加进**本地层** `settings.local.json` 的 `permissions.allow` 并落盘：文件/目录不存在则创建，已存在同规则则去重跳过。只动本地层。

- [ ] **Step 1: 在 settings.test.ts 追加失败测试**

```ts
describe('appendAllowRule', () => {
  it('creates the local file (and dir) when absent', () => {
    const local = join(dir, 'nested', 'settings.local.json')
    appendAllowRule('Bash(git status)', local)
    expect(existsSync(local)).toBe(true)
    const data = JSON.parse(readFileSync(local, 'utf8'))
    expect(data.permissions.allow).toEqual(['Bash(git status)'])
  })

  it('appends to existing allow without dropping other fields', () => {
    const local = p('settings.local.json')
    writeFileSync(local, JSON.stringify({ apiKey: 'k', permissions: { allow: ['Read(./**)'] } }))
    appendAllowRule('Write(./a.ts)', local)
    const data = JSON.parse(readFileSync(local, 'utf8'))
    expect(data.apiKey).toBe('k')
    expect(data.permissions.allow).toEqual(['Read(./**)', 'Write(./a.ts)'])
  })

  it('is idempotent — skips a duplicate rule', () => {
    const local = p('settings.local.json')
    appendAllowRule('Bash(git status)', local)
    appendAllowRule('Bash(git status)', local)
    const data = JSON.parse(readFileSync(local, 'utf8'))
    expect(data.permissions.allow).toEqual(['Bash(git status)'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/core/src/settings.test.ts -t "appendAllowRule"`
Expected: FAIL —— `appendAllowRule` 未导出。

- [ ] **Step 3: 在 `packages/core/src/settings.ts` 末尾追加实现**

```ts
/**
 * 把一条 allow 规则写入本地层 settings.local.json 的 permissions.allow。
 * 文件/目录不存在则创建；同规则已存在则去重跳过。只写本地层。
 * @param localPath 省略时取 <项目根>/.zuse/settings.local.json
 */
export function appendAllowRule(rule: string, localPath?: string): void {
  const path = localPath ?? join(findProjectRoot(), '.zuse', 'settings.local.json')
  let data: RawSettings = {}
  if (existsSync(path)) {
    try {
      data = JSON.parse(readFileSync(path, 'utf8')) as RawSettings
    } catch {
      data = {} // 坏文件不应阻断放行；以空对象重建
    }
  }
  const permissions = data.permissions ?? (data.permissions = {})
  const allow = permissions.allow ?? (permissions.allow = [])
  if (!allow.includes(rule)) allow.push(rule)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run packages/core/src/settings.test.ts`
Expected: PASS（loadSettings + appendAllowRule 全绿）

- [ ] **Step 5: checkpoint**

Run: `pnpm -F @zuse/core typecheck`
Expected: PASS

---

## Task 4：permission.ts —— 规则匹配与判定

**Files:**
- Create: `packages/core/src/permission.ts`
- Create: `packages/core/src/permission.test.ts`

纯函数、零 I/O。导出 `buildRule` / `parseRule` / `matchesRule` / `decide`。判定顺序见 spec §6.3：禁用 → deny → bypass → allow → ask → defaultMode 兜底。`decide` 取 `Tool`（读 `readOnly`/`name`）+ 已算好的 `specifier`。

- [ ] **Step 1: 写失败测试 `packages/core/src/permission.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { buildRule, parseRule, matchesRule, decide } from './permission.js'
import type { Tool } from './tool.js'
import type { ResolvedSettings, PermissionMode } from './types.js'

const cwd = '/repo'

function tool(name: string, readOnly: boolean): Tool {
  return {
    name, description: '', inputSchema: { type: 'object', properties: {} },
    run: async () => ({ output: '' }), readOnly,
  }
}
const Read = tool('Read', true)
const Write = tool('Write', false)
const Bash = tool('Bash', false)

function settings(over: Partial<ResolvedSettings['permissions']> & { mode?: PermissionMode } = {}): ResolvedSettings {
  return {
    tools: {},
    permissions: {
      defaultMode: over.mode ?? 'default',
      allow: over.allow ?? [], ask: over.ask ?? [], deny: over.deny ?? [],
    },
  }
}

describe('rule grammar', () => {
  it('builds rules from name + specifier', () => {
    expect(buildRule('Bash', 'git status')).toBe('Bash(git status)')
    expect(buildRule('Read', null)).toBe('Read')
  })
  it('parses bare and parenthesized rules', () => {
    expect(parseRule('Read')).toEqual({ tool: 'Read', specifier: null })
    expect(parseRule('Bash(git diff *)')).toEqual({ tool: 'Bash', specifier: 'git diff *' })
  })
})

describe('matchesRule', () => {
  it('bare rule matches any call of that tool', () => {
    expect(matchesRule('Read', 'Read', '/repo/a.ts', cwd)).toBe(true)
    expect(matchesRule('Read', 'Write', '/repo/a.ts', cwd)).toBe(false)
  })
  it('Bash prefix and exact matching', () => {
    expect(matchesRule('Bash(git diff *)', 'Bash', 'git diff HEAD', cwd)).toBe(true)
    expect(matchesRule('Bash(git status)', 'Bash', 'git status', cwd)).toBe(true)
    expect(matchesRule('Bash(git status)', 'Bash', 'git statusx', cwd)).toBe(false)
    expect(matchesRule('Bash(*)', 'Bash', 'rm -rf /', cwd)).toBe(true)
  })
  it('file path glob matching (relative to cwd)', () => {
    expect(matchesRule('Read(./src/**)', 'Read', '/repo/src/a/b.ts', cwd)).toBe(true)
    expect(matchesRule('Read(./.env)', 'Read', '/repo/.env', cwd)).toBe(true)
    expect(matchesRule('Read(./**/.env)', 'Read', '/repo/pkg/.env', cwd)).toBe(true)
    expect(matchesRule('Read(./src/**)', 'Read', '/repo/test/a.ts', cwd)).toBe(false)
  })
})

describe('decide', () => {
  it('deny beats allow', () => {
    const s = settings({ allow: ['Read(./**)'], deny: ['Read(./.env)'] })
    expect(decide(Read, '/repo/.env', s, [], cwd).decision).toBe('deny')
    expect(decide(Read, '/repo/a.ts', s, [], cwd).decision).toBe('allow')
  })
  it('bypassPermissions allows (but deny still wins)', () => {
    expect(decide(Bash, 'rm -rf /', settings({ mode: 'bypassPermissions' }), [], cwd).decision).toBe('allow')
    const s = settings({ mode: 'bypassPermissions', deny: ['Bash(rm -rf *)'] })
    expect(decide(Bash, 'rm -rf /', s, [], cwd).decision).toBe('deny')
  })
  it('ask rule yields ask', () => {
    expect(decide(Bash, 'npm i', settings({ ask: ['Bash(*)'] }), [], cwd).decision).toBe('ask')
  })
  it('default mode: readOnly allow, others ask', () => {
    expect(decide(Read, '/repo/a.ts', settings(), [], cwd).decision).toBe('allow')
    expect(decide(Write, '/repo/a.ts', settings(), [], cwd).decision).toBe('ask')
  })
  it('acceptEdits: Write allowed, Bash still ask', () => {
    expect(decide(Write, '/repo/a.ts', settings({ mode: 'acceptEdits' }), [], cwd).decision).toBe('allow')
    expect(decide(Bash, 'npm i', settings({ mode: 'acceptEdits' }), [], cwd).decision).toBe('ask')
  })
  it('session overlay suppresses ask', () => {
    const s = settings({ ask: ['Bash(*)'] })
    expect(decide(Bash, 'git status', s, ['Bash(git status)'], cwd).decision).toBe('allow')
  })
  it('disabled tool denies', () => {
    const s: ResolvedSettings = { tools: { disabled: ['Bash'] }, permissions: settings().permissions }
    expect(decide(Bash, 'ls', s, [], cwd).decision).toBe('deny')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/core/src/permission.test.ts`
Expected: FAIL —— `permission.js` 未定义。

- [ ] **Step 3: 写 `packages/core/src/permission.ts`**

```ts
import { isAbsolute, resolve, relative, sep } from 'node:path'
import type { Tool } from './tool.js'
import type { ResolvedSettings, PermissionDecision } from './types.js'

/** 由工具名 + 限定符拼出规则字符串。 */
export function buildRule(toolName: string, specifier: string | null): string {
  return specifier === null ? toolName : `${toolName}(${specifier})`
}

/** 解析规则；非法返回 null。`Tool` -> {tool, specifier:null}；`Tool(x)` -> {tool, specifier:'x'}。 */
export function parseRule(rule: string): { tool: string; specifier: string | null } | null {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?$/.exec(rule.trim())
  if (!m) return null
  return { tool: m[1]!, specifier: m[2] === undefined ? null : m[2] }
}

/** Bash 限定符匹配：`*` 全匹配；尾 `*` 前缀匹配；否则精确。 */
function matchCommand(spec: string, command: string): boolean {
  if (spec === '*') return true
  if (spec.endsWith('*')) return command.startsWith(spec.slice(0, -1))
  return command === spec
}

/** 把 glob 转成锚定正则。支持 `**`（含 /）、`*`（不含 /）、`?`；其余字符转义。 */
function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/^\.\//, '') // 去掉前导 ./
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*'
        i++
        if (g[i + 1] === '/') i++ // 吃掉 **/ 里的斜杠，使其可匹配零级目录
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+^${}()|[]\\/'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp('^' + re + '$')
}

/** 文件路径匹配：把输入路径规整成相对 cwd 的 posix 形式，再用 glob 比对。 */
function matchPath(spec: string, rawPath: string, cwd: string): boolean {
  const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath)
  const rel = relative(cwd, abs).split(sep).join('/')
  return globToRegExp(spec).test(rel)
}

/** 单条规则是否命中本次调用。 */
export function matchesRule(rule: string, toolName: string, specifier: string | null, cwd: string): boolean {
  const p = parseRule(rule)
  if (!p) return false
  if (p.tool !== toolName) return false
  if (p.specifier === null) return true       // 裸规则：匹配该工具任意调用
  if (specifier === null) return false        // 规则要限定符，但本次没有可比对的
  if (toolName === 'Bash') return matchCommand(p.specifier, specifier)
  return matchPath(p.specifier, specifier, cwd)
}

/**
 * 权限判定（spec §6.3）。顺序：禁用 → deny → bypass → allow → ask → defaultMode 兜底。
 * @param sessionAllow 本会话内存覆盖层（额外 allow 规则）。
 */
export function decide(
  tool: Tool,
  specifier: string | null,
  settings: ResolvedSettings,
  sessionAllow: string[],
  cwd: string,
): { decision: PermissionDecision; rule: string; matched?: string } {
  const name = tool.name
  const rule = buildRule(name, specifier)

  // 1. 工具暴露开关：被禁 → deny（既不暴露也兜底拦截）。
  const { enabled, disabled } = settings.tools
  if (enabled && !enabled.includes(name)) return { decision: 'deny', rule, matched: 'tools.enabled' }
  if (disabled && disabled.includes(name)) return { decision: 'deny', rule, matched: 'tools.disabled' }

  const perms = settings.permissions

  // 2. deny 永远最高优先。
  for (const r of perms.deny) {
    if (matchesRule(r, name, specifier, cwd)) return { decision: 'deny', rule, matched: r }
  }

  // 3. bypass。
  if (perms.defaultMode === 'bypassPermissions') return { decision: 'allow', rule }

  // 4. allow（含会话覆盖层）。
  for (const r of [...perms.allow, ...sessionAllow]) {
    if (matchesRule(r, name, specifier, cwd)) return { decision: 'allow', rule, matched: r }
  }

  // 5. ask。
  for (const r of perms.ask) {
    if (matchesRule(r, name, specifier, cwd)) return { decision: 'ask', rule, matched: r }
  }

  // 6. defaultMode 兜底。
  if (perms.defaultMode === 'acceptEdits') {
    if (tool.readOnly || name === 'Edit' || name === 'Write') return { decision: 'allow', rule }
    return { decision: 'ask', rule }
  }
  // 'default'
  return { decision: tool.readOnly ? 'allow' : 'ask', rule }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run packages/core/src/permission.test.ts`
Expected: PASS（全部用例绿）

- [ ] **Step 5: checkpoint**

Run: `pnpm -F @zuse/core typecheck`
Expected: PASS

---

## Task 5：tool.ts —— Tool 扩展 + getDefinitions 过滤

**Files:**
- Modify: `packages/core/src/tool.ts`
- Modify: `packages/core/src/tool.test.ts`

- [ ] **Step 1: 在 tool.test.ts 追加过滤的失败测试**

```ts
// 顶部 import 增加：
// import type { ToolsConfig } from './types.js'

describe('ToolRegistry.getDefinitions filtering', () => {
  function reg3(): ToolRegistry {
    const reg = new ToolRegistry()
    reg.register(fakeTool('Read'))
    reg.register(fakeTool('Write'))
    reg.register(fakeTool('Bash'))
    return reg
  }
  it('returns all when no config', () => {
    expect(reg3().getDefinitions().map((d) => d.name)).toEqual(['Read', 'Write', 'Bash'])
  })
  it('enabled keeps only the intersection', () => {
    expect(reg3().getDefinitions({ enabled: ['Read', 'Bash'] }).map((d) => d.name)).toEqual(['Read', 'Bash'])
  })
  it('disabled removes blacklisted', () => {
    expect(reg3().getDefinitions({ disabled: ['Bash'] }).map((d) => d.name)).toEqual(['Read', 'Write'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/core/src/tool.test.ts -t "filtering"`
Expected: FAIL —— `getDefinitions` 还不接受参数（过滤无效，三条全返回）。

- [ ] **Step 3: 修改 `packages/core/src/tool.ts`**

3a. 顶部 import 增加 `ToolsConfig`：

```ts
import type { ToolsConfig } from './types.js'
```

3b. `Tool` 接口加两个可选字段（在 `run` 之后）：

```ts
export interface Tool {
  name: string
  description: string
  inputSchema: JSONSchema
  run(input: unknown, ctx: ToolContext): Promise<ToolResult>
  /** 只读工具（Read/Glob/Grep/LS 为 true），供 defaultMode 分类。 */
  readOnly?: boolean
  /** 返回用于规则限定符匹配的字符串：Bash 返回命令，文件工具返回路径；无则 null。 */
  specifierFor?(input: unknown): string | null
}
```

3c. 把 `getDefinitions()` 改为接受可选 `toolsConfig`：

```ts
  /** 面向厂商的工具定义（名称 + 描述 + schema）。可按 tools 配置过滤暴露。 */
  getDefinitions(toolsConfig?: ToolsConfig): ToolDefinition[] {
    let tools = this.list()
    if (toolsConfig?.enabled) {
      const set = new Set(toolsConfig.enabled)
      tools = tools.filter((t) => set.has(t.name))
    }
    if (toolsConfig?.disabled) {
      const set = new Set(toolsConfig.disabled)
      tools = tools.filter((t) => !set.has(t.name))
    }
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }))
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run packages/core/src/tool.test.ts`
Expected: PASS（含原有用例 + 新过滤用例）

- [ ] **Step 5: checkpoint**

Run: `pnpm -F @zuse/core typecheck`
Expected: PASS

---

## Task 6：各工具补 readOnly / specifierFor

**Files:**
- Modify: `packages/tools/src/{read,write,edit,ls,glob,grep,bash}.ts`
- Modify: `packages/tools/src/read.test.ts`（加一个 specifierFor 断言代表性验证）

只读工具：Read / Glob / Grep / LS。写类/执行类不标 readOnly（默认 falsy）：Write / Edit / Bash。

- [ ] **Step 1: 在 read.test.ts 追加一个 specifierFor 断言**

```ts
// 在 read.test.ts 顶部已 import { ReadTool } 的前提下，追加：
describe('ReadTool metadata', () => {
  it('is read-only and exposes file_path as specifier', () => {
    expect(ReadTool.readOnly).toBe(true)
    expect(ReadTool.specifierFor?.({ file_path: 'a.ts' })).toBe('a.ts')
    expect(ReadTool.specifierFor?.({})).toBeNull()
  })
})
```

（若 read.test.ts 未导入 `ReadTool`，在顶部加 `import { ReadTool } from './read.js'`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/tools/src/read.test.ts -t "metadata"`
Expected: FAIL —— `readOnly`/`specifierFor` 还不存在。

- [ ] **Step 3: 给每个工具对象补字段**

`packages/tools/src/read.ts` —— 在 `ReadTool` 对象里 `inputSchema,` 之后、`async run` 之前加：

```ts
  readOnly: true,
  specifierFor: (input: unknown): string | null => {
    const p = (input as { file_path?: unknown }).file_path
    return typeof p === 'string' ? p : null
  },
```

`packages/tools/src/write.ts` —— `WriteTool` 里加（不标 readOnly）：

```ts
  specifierFor: (input: unknown): string | null => {
    const p = (input as { file_path?: unknown }).file_path
    return typeof p === 'string' ? p : null
  },
```

`packages/tools/src/edit.ts` —— `EditTool` 里加（同 Write）：

```ts
  specifierFor: (input: unknown): string | null => {
    const p = (input as { file_path?: unknown }).file_path
    return typeof p === 'string' ? p : null
  },
```

`packages/tools/src/ls.ts` —— `LSTool` 里加：

```ts
  readOnly: true,
  specifierFor: (input: unknown): string | null => {
    const p = (input as { path?: unknown }).path
    return typeof p === 'string' ? p : '.'
  },
```

`packages/tools/src/glob.ts` —— `GlobTool` 里加：

```ts
  readOnly: true,
  specifierFor: (input: unknown): string | null => {
    const p = (input as { pattern?: unknown }).pattern
    return typeof p === 'string' ? p : null
  },
```

`packages/tools/src/grep.ts` —— `GrepTool` 里加：

```ts
  readOnly: true,
  specifierFor: (input: unknown): string | null => {
    const p = (input as { path?: unknown }).path
    return typeof p === 'string' ? p : '.'
  },
```

`packages/tools/src/bash.ts` —— `BashTool` 里加（在 `inputSchema,` 之后；注意删掉那行 `// TODO Phase 5` 注释由 Task 7 处理，这里只加字段）：

```ts
  specifierFor: (input: unknown): string | null => {
    const c = (input as { command?: unknown }).command
    return typeof c === 'string' ? c : null
  },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run packages/tools/src/read.test.ts`
Expected: PASS

- [ ] **Step 5: checkpoint**

Run: `pnpm -F @zuse/tools typecheck`
Expected: PASS

---

## Task 7：agent.ts —— 权限闸门集成

**Files:**
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/src/agent.test.ts`

`RunAgentOptions` 加四项：`settings`（必填）、`canUseTool?`、`sessionAllow?`（调用方持有的内存覆盖层，跨回合保留）、`onPersistAllow?`（写盘注入，默认调 `appendAllowRule`）。工具执行前 `decide`；`deny` 合成拒绝结果、`ask` 走回调、`allow_session`/`allow_persist` 推进覆盖层（后者额外写盘）。`getDefinitions` 改为按 `settings.tools` 过滤。

> 注意：现有用例都没传 `settings`。为不破坏它们，`settings` 在缺省时回退为"全允许"的宽松设置（`defaultMode: 'bypassPermissions'`）—— 见 Step 3 的 `opts.settings ?? PERMISSIVE`。这样旧测试无需改动即可继续过。

- [ ] **Step 1: 在 agent.test.ts 追加权限相关失败测试**

```ts
// 顶部 import 增加：
// import type { ResolvedSettings, PermissionVerdict } from './types.js'

// 放在 describe('runAgent', ...) 内部：
const askSettings: ResolvedSettings = {
  tools: {},
  permissions: { defaultMode: 'default', allow: [], ask: ['echo'], deny: [] },
}

function askScript(): StreamEvent[][] {
  return [
    [
      { type: 'tool-use', id: 'c1', name: 'echo', input: { value: 'x' } },
      { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
    ],
    [{ type: 'text-delta', text: 'done' }, { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }],
  ]
}

it('deny synthesizes an error result and does NOT run the tool', async () => {
  let ran = false
  const reg = new ToolRegistry()
  reg.register({ ...echoTool(), run: async () => { ran = true; return { output: 'should-not' } } })
  const denySettings: ResolvedSettings = {
    tools: {}, permissions: { defaultMode: 'default', allow: [], ask: [], deny: ['echo'] },
  }
  const { client } = fakeClient(askScript())
  const events = await collect(runAgent({
    conversation: new Conversation(), client, registry: reg, userText: 'go', config, cwd: '.', signal,
    settings: denySettings,
  }))
  expect(ran).toBe(false)
  const tr = events.find((e) => e.type === 'tool-result')
  expect(tr).toMatchObject({ is_error: true })
})

it('ask → canUseTool deny blocks; allow runs', async () => {
  const reg = new ToolRegistry(); reg.register(echoTool())
  const { client } = fakeClient(askScript())
  const denied = await collect(runAgent({
    conversation: new Conversation(), client, registry: reg, userText: 'go', config, cwd: '.', signal,
    settings: askSettings, canUseTool: async () => 'deny',
  }))
  expect((denied.find((e) => e.type === 'tool-result') as { is_error?: boolean }).is_error).toBe(true)

  const { client: client2 } = fakeClient(askScript())
  const allowed = await collect(runAgent({
    conversation: new Conversation(), client: client2, registry: reg, userText: 'go', config, cwd: '.', signal,
    settings: askSettings, canUseTool: async () => 'allow',
  }))
  expect((allowed.find((e) => e.type === 'tool-result') as { output?: string }).output).toBe('echoed:x')
})

it('no canUseTool → ask defaults to deny', async () => {
  const reg = new ToolRegistry(); reg.register(echoTool())
  const { client } = fakeClient(askScript())
  const events = await collect(runAgent({
    conversation: new Conversation(), client, registry: reg, userText: 'go', config, cwd: '.', signal,
    settings: askSettings,
  }))
  expect((events.find((e) => e.type === 'tool-result') as { is_error?: boolean }).is_error).toBe(true)
})

it('allow_session suppresses re-ask in the same session (no disk write)', async () => {
  const reg = new ToolRegistry(); reg.register(echoTool())
  const sessionAllow: string[] = []
  let writes = 0
  // 两次调用 echo 的脚本：模型连请求两次再收尾
  const scripts: StreamEvent[][] = [
    [{ type: 'tool-use', id: 'a', name: 'echo', input: { value: '1' } }, { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE }],
    [{ type: 'tool-use', id: 'b', name: 'echo', input: { value: '2' } }, { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE }],
    [{ type: 'text-delta', text: 'done' }, { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }],
  ]
  const { client } = fakeClient(scripts)
  let asked = 0
  const canUseTool = async (): Promise<PermissionVerdict> => { asked++; return 'allow_session' }
  await collect(runAgent({
    conversation: new Conversation(), client, registry: reg, userText: 'go', config, cwd: '.', signal,
    settings: askSettings, canUseTool, sessionAllow, onPersistAllow: () => { writes++ },
  }))
  expect(asked).toBe(1)          // 第二次同名调用被会话覆盖层放行，不再问
  expect(sessionAllow).toContain('echo')
  expect(writes).toBe(0)         // 会话档不写盘
})

it('allow_persist triggers a disk write', async () => {
  const reg = new ToolRegistry(); reg.register(echoTool())
  const sessionAllow: string[] = []
  const persisted: string[] = []
  const { client } = fakeClient(askScript())
  await collect(runAgent({
    conversation: new Conversation(), client, registry: reg, userText: 'go', config, cwd: '.', signal,
    settings: askSettings, canUseTool: async () => 'allow_persist',
    sessionAllow, onPersistAllow: (rule) => persisted.push(rule),
  }))
  expect(persisted).toEqual(['echo'])
  expect(sessionAllow).toContain('echo')
})

it('disabled tool is denied even if the model calls it', async () => {
  const reg = new ToolRegistry(); reg.register(echoTool())
  const s: ResolvedSettings = { tools: { disabled: ['echo'] }, permissions: askSettings.permissions }
  const { client } = fakeClient(askScript())
  const events = await collect(runAgent({
    conversation: new Conversation(), client, registry: reg, userText: 'go', config, cwd: '.', signal,
    settings: s, canUseTool: async () => 'allow',
  }))
  expect((events.find((e) => e.type === 'tool-result') as { is_error?: boolean }).is_error).toBe(true)
})
```

> 说明：`echo` 工具默认无 `readOnly`，在 `default` 模式下兜底为 `ask`；上面 `askSettings` 又显式把 `echo` 放进 `ask`，双保险。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/core/src/agent.test.ts -t "deny synthesizes"`
Expected: FAIL —— `RunAgentOptions` 还没有 `settings` 字段（typecheck/运行失败）。

- [ ] **Step 3: 修改 `packages/core/src/agent.ts`**

3a. 顶部 import 增补：

```ts
import type { Message, ContentBlock, StreamEvent, ModelConfig, Usage, ResolvedSettings, PermissionRequest, PermissionVerdict } from './types.js'
import type { ModelClient } from './model-client.js'
import type { ToolContext, ToolRegistry, FileReadTracker, Tool } from './tool.js'
import { createFileTracker } from './tool.js'
import { decide } from './permission.js'
import { appendAllowRule } from './settings.js'
import type { Conversation } from './conversation.js'
```

3b. 在文件靠上处加一个宽松回退设置（给未传 settings 的旧调用兜底）：

```ts
/** 未提供 settings 时的宽松回退：全部放行（保持 Phase 4 行为，便于旧测试/无头调用）。 */
const PERMISSIVE_SETTINGS: ResolvedSettings = {
  tools: {},
  permissions: { defaultMode: 'bypassPermissions', allow: [], ask: [], deny: [] },
}
```

3c. `RunAgentOptions` 增加字段：

```ts
export interface RunAgentOptions {
  conversation: Conversation
  client: ModelClient
  registry: ToolRegistry
  /** 本回合用户的新输入。 */
  userText: string
  config: ModelConfig
  cwd: string
  signal: AbortSignal
  maxTurns?: number
  tracker?: FileReadTracker
  /** 解析后的设置；缺省时回退为全允许（保持 Phase 4 行为）。 */
  settings?: ResolvedSettings
  /** ask 判定的交互回调；缺省（无头/测试）时 ask 默认 deny。 */
  canUseTool?: (req: PermissionRequest) => Promise<PermissionVerdict>
  /** 本会话内存覆盖层（额外 allow 规则）。由调用方持有以跨回合保留。 */
  sessionAllow?: string[]
  /** allow_persist 时的写盘动作；缺省调用 settings 的 appendAllowRule。 */
  onPersistAllow?: (rule: string) => void
}
```

3d. 在 `runAgent` 顶部解构后补默认值（紧跟现有 `const tracker = ...` 之后）：

```ts
  const settings = opts.settings ?? PERMISSIVE_SETTINGS
  const sessionAllow = opts.sessionAllow ?? []
  const onPersistAllow = opts.onPersistAllow ?? ((rule: string): void => appendAllowRule(rule))
```

3e. 工具定义按配置过滤——把：

```ts
  const toolDefs = registry.getDefinitions()
```

改为：

```ts
  const toolDefs = registry.getDefinitions(settings.tools)
```

3f. 替换工具执行循环（现 [agent.ts:108-126] 的 `const ctx ... staged.push(...)` 整段）为：

```ts
    // 执行每个被请求的工具（先过权限闸门），并把结果作为一条 user 消息暂存。
    const ctx: ToolContext = { cwd, signal, tracker }
    const resultBlocks: ContentBlock[] = []
    for (const tu of toolUses) {
      const result = await gateAndRunTool(registry, tu, ctx, {
        settings, sessionAllow, cwd, canUseTool: opts.canUseTool, onPersistAllow,
      })
      yield {
        type: 'tool-result',
        id: tu.id,
        name: tu.name,
        output: result.output,
        is_error: result.isError,
      }
      resultBlocks.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: result.output,
        is_error: result.isError,
      })
    }
    staged.push({ role: 'user', content: resultBlocks })
```

3g. 在文件末尾、`runOneTool` 旁边新增 `gateAndRunTool`：

```ts
interface GateDeps {
  settings: ResolvedSettings
  sessionAllow: string[]
  cwd: string
  canUseTool?: (req: PermissionRequest) => Promise<PermissionVerdict>
  onPersistAllow: (rule: string) => void
}

/**
 * 权限闸门 + 执行（spec §7）。未知工具按故障模式④回喂；deny 合成拒绝结果不执行；
 * ask 走 canUseTool（无回调则默认 deny）；allow_session/allow_persist 推进会话
 * 覆盖层，后者额外写盘。
 */
async function gateAndRunTool(
  registry: ToolRegistry,
  tu: PendingToolUse,
  ctx: ToolContext,
  deps: GateDeps,
): Promise<{ output: string; isError: boolean }> {
  const tool: Tool | undefined = registry.get(tu.name)
  if (!tool) return { output: `Unknown tool: ${tu.name}`, isError: true }

  const specifier = tool.specifierFor?.(tu.input) ?? null
  const { decision, rule, matched } = decide(tool, specifier, deps.settings, deps.sessionAllow, deps.cwd)

  if (decision === 'deny') {
    return { output: `Permission denied by settings (${matched ?? rule}).`, isError: true }
  }

  if (decision === 'ask') {
    const verdict = deps.canUseTool
      ? await deps.canUseTool({ toolName: tu.name, input: tu.input, specifier, rule })
      : 'deny'
    if (verdict === 'deny') return { output: `Permission denied by user (${rule}).`, isError: true }
    if (verdict === 'allow_session' || verdict === 'allow_persist') {
      if (!deps.sessionAllow.includes(rule)) deps.sessionAllow.push(rule)
    }
    if (verdict === 'allow_persist') deps.onPersistAllow(rule)
  }

  return runOneTool(registry, tu, ctx)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run packages/core/src/agent.test.ts`
Expected: PASS（旧用例 + 6 个新权限用例全绿）

- [ ] **Step 5: checkpoint**

Run: `pnpm -F @zuse/core typecheck`
Expected: PASS

---

## Task 8：env.ts 重构 + anthropic-client 工厂改名

**Files:**
- Modify: `packages/core/src/env.ts`
- Modify: `packages/core/src/anthropic-client.ts`
- Modify: `packages/core/src/anthropic-client.test.ts`

删掉 dotenv 加载与 DashScope/Anthropic 分支；三个读取函数改为接收 `ResolvedSettings`；`findProjectRoot` 从 env.ts 删除（已迁到 settings.ts）。

- [ ] **Step 1: 整体替换 `packages/core/src/env.ts` 内容为**

```ts
import type { ClientConfig, ResolvedSettings } from './types.js'

/**
 * 从已解析的 settings 读取 API client 配置。
 * apiKey 优先级：process.env.ZUSE_API_KEY > settings.apiKey
 *（loadSettings 已把 ZUSE_API_KEY 合并进 settings.apiKey，这里再兜一层）。
 */
export function getClientConfig(settings: ResolvedSettings): ClientConfig {
  const apiKey = process.env.ZUSE_API_KEY || settings.apiKey || ''
  if (!apiKey) {
    throw new Error(
      'API key not found. Set "apiKey" in ~/.zuse/settings.json or <repo>/.zuse/settings.local.json, ' +
      'or export ZUSE_API_KEY.',
    )
  }
  return { apiKey, baseURL: settings.baseURL }
}

/** 默认模型：settings.model，否则回退。 */
export function getDefaultModel(settings: ResolvedSettings): string {
  return settings.model || 'claude-sonnet-4-5-20250514'
}

/** max_tokens：settings.maxTokens，否则回退 4096。 */
export function getDefaultMaxTokens(settings: ResolvedSettings): number {
  return settings.maxTokens && settings.maxTokens > 0 ? settings.maxTokens : 4096
}
```

- [ ] **Step 2: 修改 `packages/core/src/anthropic-client.ts`**

2a. 顶部 import 改为：

```ts
import Anthropic from '@anthropic-ai/sdk'
import type { Message, StreamEvent, ModelConfig, ClientConfig, Usage, ResolvedSettings } from './types.js'
import type { ModelClient } from './model-client.js'
import type { ToolDefinition } from './tool.js'
import { getClientConfig, getDefaultModel } from './env.js'
```

2b. 构造函数里的 `this.model = defaultModel || getDefaultModel()` 改为（去掉对无参 `getDefaultModel` 的依赖）：

```ts
    this.model = defaultModel || 'claude-sonnet-4-5-20250514'
```

2c. 把文件底部的 `createAnthropicClientFromEnv` 替换为基于 settings 的工厂：

```ts
/** 用已解析的 settings 创建 AnthropicClient。 */
export function createAnthropicClient(settings: ResolvedSettings): AnthropicClient {
  return new AnthropicClient(getClientConfig(settings), getDefaultModel(settings))
}
```

- [ ] **Step 3: 修改 `packages/core/src/anthropic-client.test.ts` 跟随新签名**

把 `beforeAll` 内与 `sendMessages` 调用处改为先 `loadSettings()`：

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { AnthropicClient } from './anthropic-client.js'
import { getClientConfig, getDefaultModel, getDefaultMaxTokens } from './env.js'
import { loadSettings } from './settings.js'
import type { Message, StreamEvent } from './types.js'

describe('AnthropicClient', () => {
  let client: AnthropicClient
  const settings = loadSettings()

  beforeAll(() => {
    try {
      client = new AnthropicClient(getClientConfig(settings), getDefaultModel(settings))
    } catch {
      console.log('Skipping AnthropicClient tests — no API key')
    }
  })
```

并把测试体里 `client.sendMessages(messages, { model: getDefaultModel(), max_tokens: getDefaultMaxTokens() })` 改为：

```ts
      for await (const event of client.sendMessages(messages, { model: getDefaultModel(settings), max_tokens: getDefaultMaxTokens(settings) })) {
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run packages/core/src/anthropic-client.test.ts`
Expected: PASS（无 key 时各用例走 catch 跳过，仍算通过）

- [ ] **Step 5: checkpoint**

Run: `pnpm -F @zuse/core typecheck`
Expected: PASS

---

## Task 9：index.ts 导出新 API

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: 在 `packages/core/src/index.ts` 的 export 列表中追加两行**

```ts
export * from './settings.js'
export * from './permission.js'
```

（放在 `export * from './tool.js'` 之后即可。）

- [ ] **Step 2: checkpoint —— 全量类型检查 + core 全测试**

Run: `pnpm -F @zuse/core typecheck && pnpm exec vitest run packages/core`
Expected: PASS

---

## Task 10：TUI —— PermissionDialog + useConversation 接线 + App 加载 settings

**Files:**
- Create: `packages/tui/src/components/PermissionDialog.tsx`
- Modify: `packages/tui/src/hooks/useConversation.ts`
- Modify: `packages/tui/src/App.tsx`

> 本任务为 UI 接线，按本仓库既有惯例（TUI 无自动化测试）做**手工验证**（Step 5）。核心判定/写盘逻辑已在 Task 2–7 被单测覆盖，这里只验证"弹框→按键→继续"这条交互链。

- [ ] **Step 1: 创建 `packages/tui/src/components/PermissionDialog.tsx`**

```tsx
import { Box, Text, useInput } from 'ink'
import type { PermissionRequest, PermissionVerdict } from '@zuse/core'

interface PermissionDialogProps {
  req: PermissionRequest
  onDecision: (verdict: PermissionVerdict) => void
}

/**
 * 工具调用批准对话框。四个按键：
 *  y → 本次允许；a → 本会话总是允许（仅内存）；
 *  A(Shift+A) → 总是允许并写入 settings.local.json（持久）；n/Esc → 拒绝。
 */
export function PermissionDialog({ req, onDecision }: PermissionDialogProps) {
  useInput((input, key) => {
    if (key.escape || input === 'n') onDecision('deny')
    else if (input === 'y') onDecision('allow')
    else if (input === 'a') onDecision('allow_session')
    else if (input === 'A') onDecision('allow_persist') // Shift+A
  })

  const detail = req.specifier ? `${req.toolName}: ${req.specifier}` : req.toolName

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">权限请求</Text>
      <Text>{detail}</Text>
      <Text dimColor>
        [y] 允许  [a] 本会话总是  [A] 总是并写盘  [n]/Esc 拒绝
      </Text>
    </Box>
  )
}
```

- [ ] **Step 2: 修改 `packages/tui/src/hooks/useConversation.ts`**

2a. import 增补（`@zuse/core` 解构里加类型，并加 `appendAllowRule` 不需要——写盘默认在 core 内完成，TUI 不直接调）：

```ts
import {
  Conversation,
  runAgent,
  createFileTracker,
  type ModelClient,
  type ToolRegistry,
  type FileReadTracker,
  type ResolvedSettings,
  type PermissionRequest,
  type PermissionVerdict,
} from '@zuse/core'
```

2b. `UseConversationOptions` 加 `settings`：

```ts
interface UseConversationOptions {
  client: ModelClient | null
  maxTokens: number
  registry: ToolRegistry
  settings: ResolvedSettings
}
```

2c. `UseConversationReturn` 加批准相关出口：

```ts
interface UseConversationReturn {
  state: ConversationState
  submit: (input: string) => Promise<void>
  clear: () => void
  pendingPermission: PermissionRequest | null
  resolvePermission: (verdict: PermissionVerdict) => void
}
```

2d. 函数签名解构 `settings`：

```ts
export function useConversation({ client, maxTokens, registry, settings }: UseConversationOptions): UseConversationReturn {
```

2e. 在 `trackerRef` 旁加会话覆盖层 ref + pending 状态 + resolver ref：

```ts
  // 本会话权限覆盖层（allow_session/allow_persist 追加的规则），跨 submit 保留。
  const sessionAllowRef = useRef<string[]>([])
  // 等待用户裁决的权限请求；非 null 时渲染对话框、禁用输入框。
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null)
  // 保存当前 ask 的 resolve，按键后调用它让 agent 循环继续。
  const permissionResolveRef = useRef<((v: PermissionVerdict) => void) | null>(null)
```

2f. 在 `sendMessage` 内、`runAgent({...})` 调用里追加三项（`tracker: trackerRef.current,` 之后）：

```ts
          settings,
          sessionAllow: sessionAllowRef.current,
          canUseTool: (req: PermissionRequest) =>
            new Promise<PermissionVerdict>((resolve) => {
              permissionResolveRef.current = resolve
              setPendingPermission(req)
            }),
```

2g. 在 `clear` / `return` 之间新增 `resolvePermission`：

```ts
  // 用户在对话框按键 → 兑现 agent 正在 await 的 promise，并收起对话框。
  const resolvePermission = useCallback((verdict: PermissionVerdict) => {
    const resolve = permissionResolveRef.current
    permissionResolveRef.current = null
    setPendingPermission(null)
    resolve?.(verdict)
  }, [])
```

2h. `return` 增加两个出口：

```ts
  return { state, submit, clear, pendingPermission, resolvePermission }
```

> 注：`canUseTool` 写进 `runAgent` 调用内联闭包即可，不必进 `useCallback` 依赖（它只用 ref 与 setState）。`sendMessage` 的依赖数组保持原样——`settings` 在组件生命周期内稳定（App 启动时加载一次），加不加进依赖都行；为稳妥可在依赖数组追加 `settings`。

- [ ] **Step 3: 修改 `packages/tui/src/App.tsx`**

整体替换为：

```tsx
import { Box, Text } from 'ink'
import { InputBox } from './components/InputBox.js'
import { MessageList } from './components/MessageList.js'
import { UsageFooter } from './components/UsageFooter.js'
import { PermissionDialog } from './components/PermissionDialog.js'
import { useConversation } from './hooks/useConversation.js'
import { createAnthropicClient, getDefaultMaxTokens, loadSettings, type ResolvedSettings } from '@zuse/core'
import { createDefaultRegistry } from '@zuse/tools'

// 整个会话期间工具集是固定的 —— 在组件外构建一次。
const registry = createDefaultRegistry()

export function App() {
  let client: ReturnType<typeof createAnthropicClient> | null = null
  let settings: ResolvedSettings | null = null
  let initError: string | undefined

  try {
    settings = loadSettings()
    client = createAnthropicClient(settings)
  } catch (err) {
    initError = err instanceof Error ? err.message : 'Failed to initialize client'
  }

  const { state, submit, pendingPermission, resolvePermission } = useConversation({
    client,
    maxTokens: settings ? getDefaultMaxTokens(settings) : 4096,
    registry,
    settings: settings ?? { tools: {}, permissions: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
  })

  if (initError) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red" bold>Error: {initError}</Text>
        <Text dimColor>请检查 ~/.zuse/settings.json 或 .zuse/settings.local.json 配置。</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" height="100%">
      <Box padding={1}>
        <Text bold color="cyan">Zuse Chat</Text>
        <Text dimColor> (Ctrl+C to exit)</Text>
      </Box>

      <Box flexGrow={1} flexDirection="column">
        <MessageList messages={state.messages} />
        {state.error && !state.isThinking && (
          <Box paddingX={1}>
            <Text color="red">Error: {state.error}</Text>
          </Box>
        )}
      </Box>

      <UsageFooter
        model={client?.getModel() || 'unknown'}
        totalUsage={state.totalUsage}
        contextTokens={state.contextTokens}
        isThinking={state.isThinking}
      />

      {pendingPermission ? (
        <PermissionDialog req={pendingPermission} onDecision={resolvePermission} />
      ) : (
        <InputBox onSubmit={submit} isDisabled={state.isThinking} />
      )}
    </Box>
  )
}
```

> 关键：pending 时**用对话框替换 InputBox**，避免两个组件同时 `useInput` 抢按键。

- [ ] **Step 4: typecheck**

Run: `pnpm -F @zuse/tui typecheck`
Expected: PASS

- [ ] **Step 5: 手工验证交互链**

前置：先完成 Task 11 的 `settings.local.json`（含可用 key）。然后：

1. 在 `<repo>/.zuse/settings.local.json` 里设 `"permissions": { "ask": ["Bash(*)"] }`。
2. Run: `pnpm dev`
3. 让模型跑一条命令，例如输入：`运行 ls 列出当前目录`。
4. 期望：底部弹出黄框"权限请求 / Bash: ls"，输入框消失。
   - 按 `y` → 命令执行、结果回显、对话框消失。
   - 再问一次同样命令 → 仍会弹框（y 只本次）。
   - 按 `a` 后再问 → 不再弹框（会话覆盖层生效）。
   - 按 `A` 后查看 `.zuse/settings.local.json` → `permissions.allow` 多了一条 `Bash(ls)`。
   - 按 `n`/Esc → 回喂"Permission denied by user"，模型据此改口。

---

## Task 11：配置文件迁移（settings.local.json / .gitignore / .env 收尾 / ping 脚本）

**Files:**
- Create: `<repo>/.zuse/settings.local.json`
- Modify: `.gitignore`
- Delete: `.env`
- Replace: `.env.example` → 删除，新增 `.zuse/settings.local.json.example`
- Modify: `scripts/ping-api.ts`

> **密钥安全（务必遵守）：** 历史对话里出现过的 key 视为已泄露，必须重新生成后再填。下面写文件时**只放占位符**，真实（已重置的）key 由你手动粘贴。绝不把真实 key 写进会进 git 的文件。

- [ ] **Step 1: 先把 `.env` 里的现有值记下来（不打印 key 本身）**

Run: `cat .env` —— 记下 `DASHSCOPE_BASE_URL` 与 `DASHSCOPE_MODEL` 的值，`DASHSCOPE_API_KEY` 的值稍后手动迁移（建议趁机在 DashScope 控制台重置一把新 key）。

- [ ] **Step 2: 创建 `<repo>/.zuse/settings.local.json`（gitignored）**

把 baseURL / model 填成上一步记下的值，apiKey 填你的（新）key：

```json
{
  "model": "qwen3-coder-plus",
  "maxTokens": 4096,
  "baseURL": "https://coding.dashscope.aliyuncs.com/apps/anthropic",
  "apiKey": "<在此粘贴你重置后的 DashScope key>",
  "permissions": {
    "defaultMode": "default",
    "allow": ["Read(./**)", "Grep", "Glob", "LS"],
    "ask": ["Bash(*)", "Write(./**)", "Edit(./**)"],
    "deny": ["Read(./.env)", "Read(./**/.env)", "Bash(rm -rf *)"]
  }
}
```

- [ ] **Step 3: 创建示例文件 `<repo>/.zuse/settings.local.json.example`（进 git，无 key）**

```json
{
  "model": "qwen3-coder-plus",
  "maxTokens": 4096,
  "baseURL": "https://coding.dashscope.aliyuncs.com/apps/anthropic",
  "apiKey": "sk-REPLACE_ME",
  "permissions": {
    "defaultMode": "default",
    "allow": ["Read(./**)", "Grep", "Glob", "LS"],
    "ask": ["Bash(*)", "Write(./**)", "Edit(./**)"],
    "deny": ["Read(./.env)", "Read(./**/.env)", "Bash(rm -rf *)"]
  }
}
```

- [ ] **Step 4: 更新 `.gitignore`**

在 `# env` 段把 `.env*` 保留（历史遗留防护），并新增 zuse 本地层。把现有 `# env` 段替换为：

```
# env
.env
.env.local
.env.*.local

# zuse 本地设置（含 secret，绝不进 git）
.zuse/settings.local.json
```

- [ ] **Step 5: 验证本地层不会被 git 跟踪**

Run: `git check-ignore .zuse/settings.local.json && echo IGNORED`
Expected: 打印 `.zuse/settings.local.json` 与 `IGNORED`（确认被忽略）。
若未忽略 —— **停止**，先修好 .gitignore 再继续，避免泄露。

- [ ] **Step 6: 改 `scripts/ping-api.ts` 改用 settings（删掉自带 dotenv 块）**

整体替换为：

```ts
import Anthropic from '@anthropic-ai/sdk'
import { loadSettings, getClientConfig, getDefaultModel } from '../packages/core/src/settings.js'
import { getClientConfig as _gcc } from '../packages/core/src/env.js'

const settings = loadSettings()
const { apiKey, baseURL } = _gcc(settings)

const client = new Anthropic({ apiKey, baseURL })

async function main() {
  const response = await client.messages.create({
    model: settings.model || 'qwen3-coder-plus',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
  })
  const textBlock = response.content.find((block) => block.type === 'text')
  const text = textBlock && textBlock.type === 'text' ? textBlock.text : '(no text)'
  console.log('Model:', response.model)
  console.log('Stop reason:', response.stop_reason)
  console.log('Usage:', response.usage)
  console.log('Response text:', text)
}

main().catch((err) => {
  console.error('Ping failed:', err)
  process.exit(1)
})
```

> 注意上面 import 同时引了 `loadSettings`、`getClientConfig`（来自 env）。修正版（去掉 settings.ts 里并不存在的 getClientConfig/getDefaultModel 导出）应为：

```ts
import Anthropic from '@anthropic-ai/sdk'
import { loadSettings } from '../packages/core/src/settings.js'
import { getClientConfig } from '../packages/core/src/env.js'

const settings = loadSettings()
const { apiKey, baseURL } = getClientConfig(settings)

const client = new Anthropic({ apiKey, baseURL })

async function main() {
  const response = await client.messages.create({
    model: settings.model || 'qwen3-coder-plus',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
  })
  const textBlock = response.content.find((block) => block.type === 'text')
  const text = textBlock && textBlock.type === 'text' ? textBlock.text : '(no text)'
  console.log('Model:', response.model)
  console.log('Stop reason:', response.stop_reason)
  console.log('Usage:', response.usage)
  console.log('Response text:', text)
}

main().catch((err) => {
  console.error('Ping failed:', err)
  process.exit(1)
})
```

（实现时直接用这个修正版，忽略上面第一段。）

- [ ] **Step 7: 删除旧文件**

Run: `rm -f .env .env.example`
（确认 `.env` 的 key 已迁入 settings.local.json 后再删。）

- [ ] **Step 8: 验证 ping 与 dev**

Run: `pnpm api:ping`
Expected: 打印 `Response text: pong`（证明 settings 读 key 成功）。

---

## Task 12：全量回归 + 文档标注

**Files:**
- Modify: `docs/superpowers/plans/phase-roadmap.md`（把 Phase 5 标为已实现 / settings.json 为配置入口）
- Modify: `BACKLOG.md`（如其中提到 settings 入口，更新指向）

- [ ] **Step 1: 全量测试 + 类型检查**

Run: `pnpm test && pnpm -r typecheck`
Expected: 全绿。

- [ ] **Step 2: lint**

Run: `pnpm lint`
Expected: 无错误（如有 `any`/未用变量等按提示修）。

- [ ] **Step 3: 更新 roadmap 与 BACKLOG**

打开 `docs/superpowers/plans/phase-roadmap.md`，把 Phase 5（权限模型）标注为"已实现：三层 settings.json + allow/ask/deny + ask 交互（本会话/写盘两档）"，并指明 `settings.json` 为配置入口、`.env` 已退役。`BACKLOG.md` 若有相关条目同步更新。（具体措辞按文件现有风格。）

- [ ] **Step 4: 最终 checkpoint（不提交）**

Run: `git status --short`
确认改动集合符合预期，且 `.zuse/settings.local.json` **不在**待提交列表里。改动留着不提交，交由用户审阅后决定提交。

---

## 自检（Self-Review）

**1. spec 覆盖：**
- §3 三层加载（含项目层 loader）→ Task 2（`loadSettings` 始终读三路径；项目层缺失贡献空）。✅
- §4 schema / apiKey 根级 / ZUSE_API_KEY 覆盖 → Task 1 类型 + Task 2 合并 + Task 8 getClientConfig。✅
- §4.1 .env 退役、getClientConfig 接 settings → Task 8 + Task 11。✅
- §5 加载合并 + appendAllowRule 写回 → Task 2 + Task 3。✅
- §6 规则文法 / Tool 扩展 / 判定算法 → Task 4 + Task 5 + Task 6。✅
- §7 agent 集成 / 四档 verdict / 规则生成 → Task 7（allow_session/allow_persist 推覆盖层、后者写盘）。✅
- §8 工具暴露开关（隐藏 + 兜底 deny）→ Task 5（getDefinitions 过滤）+ Task 4（decide 禁用兜底）。✅
- §9 TUI 四键对话框 + canUseTool promise 机制 → Task 10。✅
- §10 测试：settings 两层合并/坏 JSON/env 覆盖/写回 → Task 2-3；permission 全套 → Task 4；agent deny/ask/session/persist/禁用/无回调 → Task 7。✅
- §11 文件清单 → 各任务逐项对应。✅

**2. 占位符扫描：** 无 TBD/TODO；每个代码步骤含完整代码。Task 11 Step 6 出现过一段"错误 import 再修正"的演示——已明确标注"实现时用修正版"，落地时只写修正版。

**3. 类型一致性：** `decide(tool, specifier, settings, sessionAllow, cwd)` 在 Task 4 定义、Task 7 调用一致；`PermissionRequest`/`PermissionVerdict` 在 Task 1 定义，Task 7/10 一致使用；`getDefinitions(toolsConfig?)`、`loadSettings(opts)`、`appendAllowRule(rule, localPath?)`、`createAnthropicClient(settings)`、`getClientConfig(settings)` 签名跨任务一致。

**4. 与 spec 的两处有意偏差（已确认合理）：**
- **TUI hook 单测**降级为手工验证（Task 10 Step 5）：本仓库 TUI 目前零自动化测试、未装 ink-testing-library；引入测试基建属范围蔓延。核心可测逻辑（判定/写盘/会话抑制）已在 core 侧 Task 4/7 全覆盖。
- **每任务"提交"步骤**改为"跑检查"checkpoint：遵循用户长期偏好（做完跑过检查后留着不提交，等用户明确要求）。
- **session 覆盖层 + 写盘的归属**：放在 `agent.ts`（`gateAndRunTool`）而非 TUI，使 agent.test 能真正断言"persist 触发写盘"；TUI 的 `canUseTool` 保持纯粹（只把按键映射成 verdict）。行为与 spec §7 一致。
