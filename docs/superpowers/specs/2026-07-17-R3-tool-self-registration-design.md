# R3 — 内置工具自注册 设计

> **状态**: 设计待用户确认 → writing-plans。
> **归属**: 可扩展性重构总纲（`2026-07-17-extensibility-refactor-roadmap.md`）第一块 R3。
> **依据**: 逐行读 `packages/tools/src/index.ts`（现状 `createDefaultRegistry`）+ `Tool`/`ToolRegistry`（`packages/core/src/tool.ts`）。

## 目标

把 `createDefaultRegistry` 里硬编码的一长串 `registry.register(...)` 改成"**每个工具模块自声明启用条件与构造、一个显式索引循环注册**"。达到:
- **加内置工具** = 新建工具文件（含 `toolModule` 声明）+ 在 barrel 索引里加一行 import/数组项。
- **删内置工具** = 删该文件 + 去掉索引那一行（TS 报错会指引你去掉）。
- **不再需要改 `createDefaultRegistry` 函数体**，工具的启用条件搬回它自己文件里。

**纯内部重构**：`createDefaultRegistry(opts)` 的签名、产出的工具集与启用条件**完全不变**，所有调用方零改动。

## 非目标

- 不做 codegen / 构建期 glob 自动收集（用户已定：显式数组。保确定性、tree-shake、类型安全、可调试）。
- 不碰会话级工具（Agent / TodoWrite / ScheduleWakeup 走 `registerExtraTools`/`SessionManager`）——那是 R2。
- 不改任何工具的行为、不改 `Tool`/`ToolRegistry` 接口。
- 不引运行时目录扫描。

## 现状（实证，`packages/tools/src/index.ts:74-94`）

`createDefaultRegistry(opts: DefaultRegistryOptions)` 现在硬编码：
- 无条件纯对象工具：`ReadTool` `WriteTool` `EditTool` `GlobTool` `GrepTool` `BashTool` `WebFetchTool`（均为 `Tool` 纯对象）。
- 无条件工厂：`createMemoryTool(opts.memoryProject ?? '')`。
- 条件工厂：`createSkillTool(opts.skills)`（`opts.skills?.length > 0`）、`createWebSearchTool(opts.webSearch)`（`opts.webSearch` 非空）、`createLspTool(opts.lsp)` + `createLspInstallTool()`（`opts.lsp` 传入）。

`DefaultRegistryOptions`（`index.ts:58-67`）：`{ webSearch?, lsp?, memoryProject?, skills? }` —— 这些是构造输入，保持不变。

## 设计

### 1. 模块契约（新文件 `packages/tools/src/tool-module.ts`）

把 `DefaultRegistryOptions` 从 `index.ts` **移到** `tool-module.ts`（避免 barrel↔工具文件循环依赖：工具文件要 import 这个类型，barrel 又 import 工具文件）。`index.ts` re-export 它，保持对外导出不变。

```ts
import type { Tool } from '@zuse/core'
import type { WebSearchConfig } from '@zuse/core'
import type { LspManager } from './lsp/manager.js'
import type { SkillEntry } from './skills.js'

/** createDefaultRegistry 的可选项（原在 index.ts，迁至此以供工具模块引用）。 */
export interface DefaultRegistryOptions {
  webSearch?: WebSearchConfig | null
  lsp?: LspManager
  memoryProject?: string
  skills?: SkillEntry[]
}

/** 一个内置工具的自声明：如何构造、是否启用。删掉文件即少一个工具。 */
export interface ToolModule {
  /** 构造工具实例。纯对象工具即 `() => ReadTool`；工厂工具从 opts 取所需入参。 */
  make(opts: DefaultRegistryOptions): Tool
  /** 是否在本次注册中启用；缺省 true（无条件工具不实现它）。 */
  enabled?(opts: DefaultRegistryOptions): boolean
}
```

> 注：`make(opts)` 暂收 `DefaultRegistryOptions`。R2 会把它加宽成"会话能力上下文"——届时扩展这个入参类型即可，R3 不预造 R2 的东西。
>
> **循环引用注意**：`tool-module.ts` 对 `SkillEntry`/`LspManager` 用 `import type`，各工具文件对 `ToolModule`/`DefaultRegistryOptions` 也用 `import type`——都是**类型级引用，编译期擦除，无运行时循环**。`toolModule` 的值导出只依赖各文件本地的 `create*` 函数，不回引 `tool-module.ts` 的值。

### 2. 每个工具文件自带 `toolModule` 导出（统一契约名）

每个内置工具文件新增一个 `export const toolModule: ToolModule`。启用条件从中央函数搬回各自文件：

| 文件 | `toolModule` |
|---|---|
| `read.ts` | `{ make: () => ReadTool }` |
| `write.ts` | `{ make: () => WriteTool }` |
| `edit.ts` | `{ make: () => EditTool }` |
| `glob.ts` | `{ make: () => GlobTool }` |
| `grep.ts` | `{ make: () => GrepTool }` |
| `bash.ts` | `{ make: () => BashTool }` |
| `webfetch.ts` | `{ make: () => WebFetchTool }` |
| `memory.ts` | `{ make: (o) => createMemoryTool(o.memoryProject ?? '') }` |
| `skills.ts` | `{ make: (o) => createSkillTool(o.skills!), enabled: (o) => (o.skills?.length ?? 0) > 0 }` |
| `websearch.ts` | `{ make: (o) => createWebSearchTool(o.webSearch!), enabled: (o) => !!o.webSearch }` |
| `lsp/index.ts` | `{ make: (o) => createLspTool(o.lsp!), enabled: (o) => !!o.lsp }` |
| `lsp/install.ts` | `{ make: () => createLspInstallTool(), enabled: (o) => !!o.lsp }` |

> 每个文件导出**同名** `toolModule` —— `grep "export const toolModule"` 即可枚举所有内置工具，可发现性强。

### 3. 显式索引 + 循环注册（`packages/tools/src/builtin-tools.ts`，新文件）

```ts
import { ToolRegistry } from '@zuse/core'
import type { DefaultRegistryOptions, ToolModule } from './tool-module.js'
import { toolModule as readToolModule } from './read.js'
import { toolModule as writeToolModule } from './write.js'
// … edit/glob/grep/bash/webfetch/memory/skills/websearch/lsp/lsp-install

/** 内置工具集，顺序即注册顺序（须与重构前一致）。加/删工具改这个数组 + 对应文件。 */
export const BUILTIN_TOOL_MODULES: ToolModule[] = [
  readToolModule, writeToolModule, editToolModule, globToolModule, grepToolModule,
  bashToolModule, webfetchToolModule, memoryToolModule,
  skillToolModule, websearchToolModule, lspToolModule, lspInstallToolModule,
]

export function createDefaultRegistry(opts: DefaultRegistryOptions = {}): ToolRegistry {
  const registry = new ToolRegistry()
  for (const m of BUILTIN_TOOL_MODULES) {
    if (m.enabled?.(opts) ?? true) registry.register(m.make(opts))
  }
  return registry
}
```

`index.ts` 改为从 `builtin-tools.js` re-export `createDefaultRegistry`、从 `tool-module.js` re-export `DefaultRegistryOptions`（对外 API 不变）。其余现有 re-export 保持。

**注册顺序**必须与重构前逐一致（Read→…→WebFetch→Memory→Skill→WebSearch→Lsp→LspInstall），数组顺序即保证。

## 数据流 / 错误处理

- 无新数据流。`ToolRegistry.register` 遇重名仍抛（`tool.ts:131`）——数组里若不慎重复某模块会在构建注册表时立刻炸，等于多一道保护。
- `enabled` 缺省视为 `true`；条件工具的 `make` 里对已被 `enabled` 保证存在的 opt 用非空断言（`o.webSearch!`），因为只有 `enabled` 通过才会 `make`。

## 测试

- **每模块单测**：条件工具的 `enabled(opts)` 真值表（skills 空/非空、webSearch 有/无、lsp 有/无）；`make(opts)` 返回的 `Tool.name` 符合预期。
- **回归锁**（关键安全网）：跨 opts 组合断言 `createDefaultRegistry` 产出的**工具名列表与顺序**同重构前逐一致：
  - `{}` → `[Read,Write,Edit,Glob,Grep,Bash,WebFetch,Memory]`
  - `{ skills:[…] }` → 追加 `Skill`
  - `{ webSearch:{…} }` → 追加 `WebSearch`
  - `{ lsp:manager }` → 追加 `Lsp,LspInstall`
- **构建/类型**：`pnpm --filter @zuse/tools exec tsc --noEmit` 干净；`pnpm --filter @zuse/tools build`（tsup）通过。
- 不涉及 web/server 行为改动；但因 `@zuse/tools` 被 server 依赖，跑一遍 server 单测确认无回归。

## 涉及文件

- 新增：`packages/tools/src/tool-module.ts`（`ToolModule` + 迁入的 `DefaultRegistryOptions`）、`packages/tools/src/builtin-tools.ts`（`BUILTIN_TOOL_MODULES` + `createDefaultRegistry`）。
- 改：各工具文件加 `export const toolModule`（read/write/edit/glob/grep/bash/webfetch/memory/skills/websearch/lsp/index/lsp/install）。
- 改：`packages/tools/src/index.ts`（删掉 `createDefaultRegistry` 本体与 `DefaultRegistryOptions` 定义，改为 re-export；保留其余导出）。
- 测试：`builtin-tools.test.ts`（回归锁 + enabled 真值表）。
