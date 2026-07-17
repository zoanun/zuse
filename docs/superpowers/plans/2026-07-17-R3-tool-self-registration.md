# R3 — 内置工具自注册 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `createDefaultRegistry` 的硬编码 `register()` 清单改为"每个工具文件自声明 `toolModule`（make + 可选 enabled）+ 一个显式 `BUILTIN_TOOL_MODULES` 数组循环注册"，使加/删内置工具只动该工具文件 + barrel 一行，不改注册函数体。

**Architecture:** 纯内部重构。新增 `tool-module.ts`（`ToolModule` 接口 + 迁入的 `DefaultRegistryOptions`）与 `builtin-tools.ts`（模块数组 + `createDefaultRegistry` 循环）。12 个工具文件各加 `export const toolModule`。`index.ts` 改为 re-export。`createDefaultRegistry` 的签名、产出工具集、顺序、启用条件**完全不变**，由回归锁测试守护。

**Tech Stack:** TypeScript ESM、`@zuse/tools`（tsup 构建）、`@zuse/core` 的 `Tool`/`ToolRegistry`、Vitest。

**测试命令**：单测 `pnpm exec vitest run packages/tools`；类型检查 `pnpm --filter @zuse/tools exec tsc --noEmit`；构建 `pnpm --filter @zuse/tools build`；下游回归 `pnpm exec vitest run packages/server`。

**约束**：`createDefaultRegistry(opts)` 对外签名与行为不变；`index.ts` 必须继续 re-export `createDefaultRegistry` 与 `DefaultRegistryOptions`（server 依赖）；`tool-module.ts` 对 `SkillEntry`/`LspManager` 及各工具文件对 `ToolModule`/`DefaultRegistryOptions` 一律 `import type`（类型级、无运行时循环）；不碰会话级工具（Agent/TodoWrite/ScheduleWakeup 属 R2）。

**已核实的事实**（写测试/代码据此）：
- 纯对象工具与其 `name`：`ReadTool`→'Read'、`WriteTool`→'Write'、`EditTool`→'Edit'、`GlobTool`→'Glob'、`GrepTool`→'Grep'、`BashTool`→'Bash'、`WebFetchTool`→'WebFetch'（`packages/tools/src/{read,write,edit,glob,grep,bash,webfetch}.ts`）。
- 工厂签名：`createMemoryTool(project: string, opts?)`→'Memory'；`createSkillTool(skills: SkillEntry[])`→'Skill'；`createWebSearchTool(config: WebSearchConfig)`→'WebSearch'；`createLspTool(manager: LspManager)`→'Lsp'；`createLspInstallTool(run?)`→'LspInstall'。
- 现 `DefaultRegistryOptions`（`index.ts:58-67`）：`{ webSearch?: WebSearchConfig | null; lsp?: LspManager; memoryProject?: string; skills?: SkillEntry[] }`。
- 现注册顺序（`index.ts:76-92`）：Read, Write, Edit, Glob, Grep, Bash, WebFetch, Memory, [Skill if skills.length>0], [WebSearch if webSearch], [Lsp, LspInstall if lsp]。

---

## Task 1: 回归锁测试（先锁住现有行为，绿）

**Files:**
- Create: `packages/tools/src/builtin-tools.test.ts`

这是特征化测试：针对**当前** `createDefaultRegistry`（来自 `./index.js`）断言"工具名列表 + 顺序"，先跑成**绿**，锁住重构前的真相；重构后必须仍绿。

- [ ] **Step 1: 写测试**

```ts
import { describe, it, expect } from 'vitest'
import { createDefaultRegistry } from './index.js'
import type { WebSearchConfig } from '@zuse/core'

// 取注册表里工具名的有序列表。ToolRegistry.list() 按注册顺序返回。
function names(opts: Parameters<typeof createDefaultRegistry>[0] = {}): string[] {
  return createDefaultRegistry(opts).list().map((t) => t.name)
}

// 假的 LspManager / WebSearchConfig：只要能让条件分支注册工具即可，不触发真实 I/O。
const fakeLsp = {} as unknown as import('./lsp/manager.js').LspManager
const fakeWebSearch = { provider: 'brave', apiKey: 'x' } as unknown as WebSearchConfig
const fakeSkills = [{ name: 's', description: 'd', body: 'b', path: '/tmp/s' }] as unknown as
  import('./skills.js').SkillEntry[]

describe('createDefaultRegistry — 内置工具集与顺序（回归锁）', () => {
  it('{} → 无条件工具集', () => {
    expect(names({})).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'Memory'])
  })
  it('{skills} → 追加 Skill', () => {
    expect(names({ skills: fakeSkills })).toEqual([
      'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'Memory', 'Skill',
    ])
  })
  it('空 skills 数组 → 不追加 Skill', () => {
    expect(names({ skills: [] })).not.toContain('Skill')
  })
  it('{webSearch} → 追加 WebSearch', () => {
    expect(names({ webSearch: fakeWebSearch })).toContain('WebSearch')
  })
  it('{lsp} → 追加 Lsp 和 LspInstall（顺序 Lsp 在前）', () => {
    const n = names({ lsp: fakeLsp })
    expect(n.slice(-2)).toEqual(['Lsp', 'LspInstall'])
  })
  it('全开 → 完整有序集', () => {
    expect(names({ skills: fakeSkills, webSearch: fakeWebSearch, lsp: fakeLsp })).toEqual([
      'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'Memory',
      'Skill', 'WebSearch', 'Lsp', 'LspInstall',
    ])
  })
})
```

- [ ] **Step 2: 跑测试，确认现在就绿（锁住现状）**

Run: `pnpm exec vitest run packages/tools/src/builtin-tools.test.ts`
Expected: PASS（6 个用例全过——这是针对现有 `createDefaultRegistry` 的特征化断言）。
> 若某条不过，说明我对现状的理解有误——停下核对 `index.ts`，不要改测试去迁就臆想。

- [ ] **Step 3: Commit**

```bash
git add packages/tools/src/builtin-tools.test.ts
git commit -m "test(tools): lock createDefaultRegistry tool set + order before R3 refactor"
```

---

## Task 2: `tool-module.ts` —— ToolModule 接口 + 迁入 DefaultRegistryOptions

**Files:**
- Create: `packages/tools/src/tool-module.ts`

- [ ] **Step 1: 写文件**

```ts
import type { Tool, WebSearchConfig } from '@zuse/core'
import type { LspManager } from './lsp/manager.js'
import type { SkillEntry } from './skills.js'

/** createDefaultRegistry 的可选项（原在 index.ts，迁至此以供各工具模块引用）。 */
export interface DefaultRegistryOptions {
  /** WebSearch 配置；非空才注册 WebSearch（没 key 不暴露给模型）。 */
  webSearch?: WebSearchConfig | null
  /** LSP 进程池；传入时注册 Lsp/LspInstall。 */
  lsp?: LspManager
  /** Memory 工具的项目归属（会话起始 cwd 的 slug；缺省空串 = 全局）。 */
  memoryProject?: string
  /** 已扫描的技能清单；非空才注册 Skill。 */
  skills?: SkillEntry[]
}

/** 一个内置工具的自声明：如何构造、是否启用。删掉工具文件即少一个工具。 */
export interface ToolModule {
  /** 构造工具实例。纯对象工具即 `() => ReadTool`；工厂工具从 opts 取入参。 */
  make(opts: DefaultRegistryOptions): Tool
  /** 是否在本次注册中启用；缺省视为 true（无条件工具不实现它）。 */
  enabled?(opts: DefaultRegistryOptions): boolean
}
```

> `import type` 全程类型级：`tool-module.ts` 引 `SkillEntry`/`LspManager`，工具文件反向引 `ToolModule`/`DefaultRegistryOptions`，均编译期擦除，无运行时循环。

- [ ] **Step 2: 类型检查**

Run: `pnpm --filter @zuse/tools exec tsc --noEmit`
Expected: 通过（此时 `index.ts` 仍有自己的 `DefaultRegistryOptions` 定义，两处并存不冲突——同名 interface 在不同文件是不同符号；Task 5 会删掉 index.ts 里那份并改为 re-export）。

- [ ] **Step 3: Commit**

```bash
git add packages/tools/src/tool-module.ts
git commit -m "feat(tools): add ToolModule contract + relocate DefaultRegistryOptions"
```

---

## Task 3: 7 个纯对象工具文件各加 `toolModule`

**Files:**
- Modify: `packages/tools/src/read.ts`, `write.ts`, `edit.ts`, `glob.ts`, `grep.ts`, `bash.ts`, `webfetch.ts`

每个文件在其现有 `XxxTool` 常量导出之后，追加一个 `toolModule` 导出。**7 个文件模式相同，逐一照做。**

- [ ] **Step 1: read.ts —— 在文件末尾（`ReadTool` 定义之后）追加**

```ts
import type { ToolModule } from './tool-module.js'
export const toolModule: ToolModule = { make: () => ReadTool }
```
> `import type` 放文件顶部 import 区；`export const toolModule` 放 `ReadTool` 之后。下同。

- [ ] **Step 2: write.ts 追加**

```ts
import type { ToolModule } from './tool-module.js'
export const toolModule: ToolModule = { make: () => WriteTool }
```

- [ ] **Step 3: edit.ts 追加**

```ts
import type { ToolModule } from './tool-module.js'
export const toolModule: ToolModule = { make: () => EditTool }
```

- [ ] **Step 4: glob.ts 追加**

```ts
import type { ToolModule } from './tool-module.js'
export const toolModule: ToolModule = { make: () => GlobTool }
```

- [ ] **Step 5: grep.ts 追加**

```ts
import type { ToolModule } from './tool-module.js'
export const toolModule: ToolModule = { make: () => GrepTool }
```

- [ ] **Step 6: bash.ts 追加**

```ts
import type { ToolModule } from './tool-module.js'
export const toolModule: ToolModule = { make: () => BashTool }
```

- [ ] **Step 7: webfetch.ts 追加**

```ts
import type { ToolModule } from './tool-module.js'
export const toolModule: ToolModule = { make: () => WebFetchTool }
```

- [ ] **Step 8: 类型检查**

Run: `pnpm --filter @zuse/tools exec tsc --noEmit`
Expected: 通过。

- [ ] **Step 9: Commit**

```bash
git add packages/tools/src/read.ts packages/tools/src/write.ts packages/tools/src/edit.ts packages/tools/src/glob.ts packages/tools/src/grep.ts packages/tools/src/bash.ts packages/tools/src/webfetch.ts
git commit -m "feat(tools): plain tools self-declare toolModule (read/write/edit/glob/grep/bash/webfetch)"
```

---

## Task 4: 5 个工厂/条件工具文件各加 `toolModule`（含 enabled）

**Files:**
- Modify: `packages/tools/src/memory.ts`, `skills.ts`, `websearch.ts`, `lsp/index.ts`, `lsp/install.ts`

启用条件从中央函数搬回各自文件。

- [ ] **Step 1: memory.ts 追加（无条件，工厂取 memoryProject）**

```ts
import type { ToolModule } from './tool-module.js'
export const toolModule: ToolModule = {
  make: (o) => createMemoryTool(o.memoryProject ?? ''),
}
```

- [ ] **Step 2: skills.ts 追加（skills 非空才启用）**

```ts
import type { ToolModule } from './tool-module.js'
export const toolModule: ToolModule = {
  make: (o) => createSkillTool(o.skills ?? []),
  enabled: (o) => (o.skills?.length ?? 0) > 0,
}
```

- [ ] **Step 3: websearch.ts 追加（有配置才启用）**

```ts
import type { ToolModule } from './tool-module.js'
export const toolModule: ToolModule = {
  make: (o) => createWebSearchTool(o.webSearch!),
  enabled: (o) => !!o.webSearch,
}
```
> `o.webSearch!`：只有 `enabled` 返回 true 时 `make` 才被调用，此处非空断言安全。

- [ ] **Step 4: lsp/index.ts 追加（有 lsp 才启用）**

```ts
import type { ToolModule } from '../tool-module.js'
export const toolModule: ToolModule = {
  make: (o) => createLspTool(o.lsp!),
  enabled: (o) => !!o.lsp,
}
```
> 注意路径：`lsp/index.ts` 在子目录，import 为 `'../tool-module.js'`。

- [ ] **Step 5: lsp/install.ts 追加（与 Lsp 同生命周期，有 lsp 才启用）**

```ts
import type { ToolModule } from '../tool-module.js'
export const toolModule: ToolModule = {
  make: () => createLspInstallTool(),
  enabled: (o) => !!o.lsp,
}
```

- [ ] **Step 6: 类型检查**

Run: `pnpm --filter @zuse/tools exec tsc --noEmit`
Expected: 通过。

- [ ] **Step 7: Commit**

```bash
git add packages/tools/src/memory.ts packages/tools/src/skills.ts packages/tools/src/websearch.ts packages/tools/src/lsp/index.ts packages/tools/src/lsp/install.ts
git commit -m "feat(tools): factory/conditional tools self-declare toolModule + enabled (memory/skill/websearch/lsp)"
```

---

## Task 5: `builtin-tools.ts` + 改 `index.ts` re-export（重构落地）

**Files:**
- Create: `packages/tools/src/builtin-tools.ts`
- Modify: `packages/tools/src/index.ts`

- [ ] **Step 1: 写 `builtin-tools.ts`**

```ts
import { ToolRegistry } from '@zuse/core'
import type { DefaultRegistryOptions, ToolModule } from './tool-module.js'
import { toolModule as readToolModule } from './read.js'
import { toolModule as writeToolModule } from './write.js'
import { toolModule as editToolModule } from './edit.js'
import { toolModule as globToolModule } from './glob.js'
import { toolModule as grepToolModule } from './grep.js'
import { toolModule as bashToolModule } from './bash.js'
import { toolModule as webfetchToolModule } from './webfetch.js'
import { toolModule as memoryToolModule } from './memory.js'
import { toolModule as skillToolModule } from './skills.js'
import { toolModule as websearchToolModule } from './websearch.js'
import { toolModule as lspToolModule } from './lsp/index.js'
import { toolModule as lspInstallToolModule } from './lsp/install.js'

/**
 * 内置工具集，**数组顺序即注册顺序**（须与重构前一致）。
 * 加内置工具 = 新建工具文件（导出 toolModule）+ 在此 import 并加入数组。
 * 删内置工具 = 删该文件 + 去掉这里的一行（TS 会用未解析 import 指引你）。
 */
export const BUILTIN_TOOL_MODULES: ToolModule[] = [
  readToolModule,
  writeToolModule,
  editToolModule,
  globToolModule,
  grepToolModule,
  bashToolModule,
  webfetchToolModule,
  memoryToolModule,
  skillToolModule,
  websearchToolModule,
  lspToolModule,
  lspInstallToolModule,
]

/**
 * 构建预装 v1 工具集的登记表。启用条件在各工具的 toolModule.enabled 里；
 * 缺省视为启用。行为与重构前逐一致（见 builtin-tools.test.ts 回归锁）。
 */
export function createDefaultRegistry(opts: DefaultRegistryOptions = {}): ToolRegistry {
  const registry = new ToolRegistry()
  for (const m of BUILTIN_TOOL_MODULES) {
    if (m.enabled?.(opts) ?? true) registry.register(m.make(opts))
  }
  return registry
}
```

- [ ] **Step 2: 改 `index.ts` —— 删掉本体，改为 re-export**

删除 `index.ts` 中：顶部为 `createDefaultRegistry` 而引入的工具/类型 import（`ReadTool…WebFetchTool`、`createWebSearchTool`、`createLspTool`、`createLspInstallTool`、`LspManager`、`createMemoryTool`、`createSkillTool`、`WebSearchConfig` 等**仅供本体使用**的 import）、`DefaultRegistryOptions` interface 定义（`index.ts:57-67`）、`createDefaultRegistry` 函数体（`index.ts:69-94`）。

> 谨慎：`index.ts` 里很多 import 同时用于 **re-export block**（`export { ReadTool, … }`、`export { createMemoryTool, … }` 等）。**只删那些删除本体后变为未使用的 import**；凡仍出现在 `export { … } from './x.js'` 直接 re-export 或被其它保留代码引用的，一律保留。以 `tsc --noEmit` 的"未使用/未定义"报错为准逐个消化，不要凭记忆删。

在 `index.ts` 末尾（或导出区）加：

```ts
export { createDefaultRegistry, BUILTIN_TOOL_MODULES } from './builtin-tools.js'
export type { DefaultRegistryOptions, ToolModule } from './tool-module.js'
```

> 保证对外 API 不变：`createDefaultRegistry` 与 `DefaultRegistryOptions` 仍从 `@zuse/tools` 顶层可 import（server 依赖它们）。

- [ ] **Step 3: 类型检查（据报错清理 index.ts 的死 import）**

Run: `pnpm --filter @zuse/tools exec tsc --noEmit`
Expected: 通过。若报"声明了但未使用"，删掉那条 import；若报"找不到名字"，说明误删了仍被 re-export 用到的 import，补回。反复到干净。

- [ ] **Step 4: 跑回归锁测试，必须仍绿**

Run: `pnpm exec vitest run packages/tools/src/builtin-tools.test.ts`
Expected: PASS（6 个用例）——证明重构后工具集与顺序与重构前逐一致。
> 任一用例变红即行为漂移，停下修实现（不是改测试）。

- [ ] **Step 5: Commit**

```bash
git add packages/tools/src/builtin-tools.ts packages/tools/src/index.ts
git commit -m "refactor(tools): createDefaultRegistry loops BUILTIN_TOOL_MODULES (R3 self-registration)"
```

---

## Task 6: enabled() 真值表单测（补新行为的直接覆盖）

**Files:**
- Modify: `packages/tools/src/builtin-tools.test.ts`

- [ ] **Step 1: 追加 describe 块**

```ts
import { toolModule as skillToolModule } from './skills.js'
import { toolModule as websearchToolModule } from './websearch.js'
import { toolModule as lspToolModule } from './lsp/index.js'
import { toolModule as lspInstallToolModule } from './lsp/install.js'
import { toolModule as readToolModule } from './read.js'

describe('toolModule.enabled 真值表', () => {
  it('skill: 空/无 → 关，非空 → 开', () => {
    expect(skillToolModule.enabled!({})).toBe(false)
    expect(skillToolModule.enabled!({ skills: [] })).toBe(false)
    expect(skillToolModule.enabled!({ skills: fakeSkills })).toBe(true)
  })
  it('websearch: 无 → 关，有 → 开', () => {
    expect(websearchToolModule.enabled!({})).toBe(false)
    expect(websearchToolModule.enabled!({ webSearch: fakeWebSearch })).toBe(true)
  })
  it('lsp / lspInstall: 无 lsp → 关，有 → 开', () => {
    expect(lspToolModule.enabled!({})).toBe(false)
    expect(lspInstallToolModule.enabled!({})).toBe(false)
    expect(lspToolModule.enabled!({ lsp: fakeLsp })).toBe(true)
    expect(lspInstallToolModule.enabled!({ lsp: fakeLsp })).toBe(true)
  })
  it('无条件工具无 enabled（缺省启用）', () => {
    expect(readToolModule.enabled).toBeUndefined()
  })
})
```
> `fakeSkills`/`fakeWebSearch`/`fakeLsp` 复用 Task 1 文件顶部已定义的常量（同文件，无需重定义）。

- [ ] **Step 2: 跑测试**

Run: `pnpm exec vitest run packages/tools/src/builtin-tools.test.ts`
Expected: PASS（回归锁 6 + 真值表 4 = 10 用例）。

- [ ] **Step 3: Commit**

```bash
git add packages/tools/src/builtin-tools.test.ts
git commit -m "test(tools): enabled() truth table for conditional tool modules"
```

---

## Task 7: 全量门禁（类型 + 单测 + 构建 + 下游回归）

**Files:** 无（只跑命令）

- [ ] **Step 1: 类型检查**

Run: `pnpm --filter @zuse/tools exec tsc --noEmit`
Expected: 无输出、exit 0。

- [ ] **Step 2: tools 全量单测**

Run: `pnpm exec vitest run packages/tools`
Expected: 全绿（含既有工具测试 + 新增 builtin-tools 测试）。记录通过数。

- [ ] **Step 3: tools 构建（tsup，确认 barrel/re-export 打包无误）**

Run: `pnpm --filter @zuse/tools build`
Expected: 构建成功、无报错。

- [ ] **Step 4: 下游 server 回归（server 依赖 @zuse/tools 的 createDefaultRegistry）**

Run: `pnpm exec vitest run packages/server`
Expected: 与重构前一致（同样的通过/失败集；已知的 flaky-under-load `SessionService` 时序用例若单独跑能过则可豁免——按 CLAUDE.md 以实际输出为准）。

- [ ] **Step 5: 无独立提交**（本任务只验证；如前面各 Task 已提交则工作树应为干净）。

```bash
git status --short   # 期望：干净
```

---

## 自查（spec 覆盖 / 占位符 / 类型一致）

- **spec 覆盖**：ToolModule 契约（Task 2）、DefaultRegistryOptions 迁移（Task 2）、12 工具自声明（Task 3+4）、显式数组循环（Task 5）、index re-export 保 API（Task 5）、回归锁（Task 1+5）、enabled 真值表（Task 6）、构建/下游（Task 7）。全覆盖。
- **占位符**：无 TBD/TODO；每个代码步给了完整代码。
- **类型一致**：`ToolModule.make(opts: DefaultRegistryOptions): Tool`、`enabled?(opts): boolean` 全程一致；工具名字符串与实测值一致；工厂签名与实测一致；`lsp/*` 的 import 路径用 `'../tool-module.js'`。
