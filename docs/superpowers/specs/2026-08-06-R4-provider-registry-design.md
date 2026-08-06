# R4 — provider 注册表 设计

> **日期**: 2026-08-06
> **总纲**: [可扩展性重构总纲](2026-07-17-extensibility-refactor-roadmap.md) §4 R4
> **性质**: 轻量 spec（机械重构，行为不变）。不单独出实现计划，TDD 直接做。
> **前置**: 无（R4 在总纲里标为独立块，任意时点可插空）
> **评审**: 已经独立子代理评审一轮，8 条 findings 全部采纳，本文为修订版。

---

## 1. 痛点（file:line 实证）

加一个模型协议，今天要改**三个中央位置**：

| 位置 | 现状 |
|---|---|
| `packages/core/src/types.ts:115` | `export type ProviderProtocol = 'anthropic' \| 'openai'` —— 闭合联合 |
| `packages/core/src/model-client.ts:32-43` | `switch (provider.protocol)` + `never` 穷尽检查 |
| `packages/core/src/model-client.ts:3-4` | 顶部静态 `import` 两个具体 client 类 |

总纲 §4 R4 的验收标准是「加一个 provider 协议**只写新 client + 一行注册**」，当前形态达不到。

> 顺带订正：总纲 §3.4 引用的 `types.ts:111` 是错的，实际在 115 行。

## 2. 方案选择

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A（采纳）** | 显式索引数组 + 协议放宽为 `string` | 真正纯追加；代价是丢掉联合类型对**内部字面量**的编译期约束 |
| B | 保留联合，注册表只做运行时分发 | 类型安全不丢，但加协议仍要改中央 union —— **达不到验收标准** |
| C | 各 client 文件里副作用 `import` 自注册 | 加文件即生效，但依赖 import 副作用，tree-shaking 不友好、顺序敏感，与总纲 §6「不引运行时目录扫描，保持确定性、可 tree-shake」的精神相悖 |

**采纳 A。** 放宽联合的代价小，但**不是零**——下面把代价如实列全：

**代价确实小的部分**：`protocol` 的真实来源是 settings.jsonc，而 `settings.ts:405` 是 `protocol: raw.protocol ?? 'anthropic'` —— 一个**无校验的运行时透传**（全仓无 zod/JSON schema）。配置里把协议名拼错，今天也是运行时才炸，联合类型对**外部输入**从来没有保护作用。R4 之后 core 内不再有 `switch` 协议，穷尽检查随之失去意义。

**必须承认的代价**（初稿漏了，评审指出）：

1. **内部字面量失去 typo 保护**。`settings.ts:385`、`:405` 手写的 `'anthropic'` 字面量，以及各包测试 fixture 里的 `protocol: 'openai'`，放宽后拼错不再被编译器拦。量小（2 处生产代码），但确实存在。
2. **`ProviderProtocol` 类型名无消费方 ≠ protocol 值无消费方**。初稿把这两件事混为一谈。protocol 这个**值**有一处真实的硬编码判断：`packages/server/src/voice/VoiceService.ts:193` 的 `if (provider.protocol !== 'openai')`。它的存在说明本次重构的价值主张是**打折的**——见 §6 非目标第 1 条。

## 3. 设计

### 3.1 形状对齐 R3，但**不能照抄导出名**

复用 R3 已跑通的形状（`packages/tools/src/tool-module.ts` + `builtin-tools.ts`），不发明新范式。

**一处关键差异（评审 P1，硬伤）**：R3 能让 12 个工具文件都叫 `export const toolModule`，是因为 `packages/tools/src/index.ts` **全程具名 re-export、一条 `export *` 都没有**（见该文件 52-53 行）。而 `packages/core/src/index.ts:5-6` 是：

```
5	export * from './anthropic-client.js'
6	export * from './openai-client.js'
```

**`export *` 体质下两个文件导出同名成员会撞 TS2308**。所以 core 侧导出名必须全局唯一：`anthropicProviderModule` / `openaiProviderModule`，**不用** R3 的「同名 + import 时 alias」写法。

```
packages/core/src/
  provider-module.ts      新增：ProviderModule 接口（**纯类型，无运行时导出**）
  builtin-providers.ts    新增：BUILTIN_PROVIDER_MODULES 显式数组
  anthropic-client.ts     + export const anthropicProviderModule
  openai-client.ts        + export const openaiProviderModule
  model-client.ts         switch → buildProviderIndex + 查表；删掉对具体 client 类的 import
  types.ts                ProviderProtocol: 联合 → string
  index.ts                + export * 两个新文件（评审 P6：新 client 的作者要 import ProviderModule，必须是公开 API）
```

### 3.2 接口契约

```ts
// provider-module.ts
export interface ProviderModule {
  /** 协议标识，即 settings 里 providers[].protocol 的取值。 */
  protocol: string
  /** 构造该协议的 client。**必须是闭包**，见下方约束。 */
  make(provider: ProviderConfig, model: string): ModelClient
}

// model-client.ts —— 注意**不在** provider-module.ts，理由见约束 1
/** 由模块数组建索引；协议名重复即抛（编程错误，不静默覆盖）。 */
export function buildProviderIndex(modules: ProviderModule[]): Map<string, ProviderModule>
```

两条约束：

1. **`ProviderModule` 单独成文件且保持纯类型**，让各 client 文件能 type-only 引用它而不反向依赖工厂——与 `model-client.ts` 现有注释「clients 仅 type-only 依赖本文件，无运行时环」一致。`tsconfig.base.json` 的 `verbatimModuleSyntax: true` 会把「不小心写成值导入」变成编译错误，这条约束是编译器强制的，不靠注释。
   **`buildProviderIndex` 因此放 `model-client.ts` 而不是 `provider-module.ts`**（评审二轮）：往 provider-module.ts 里塞一个运行时函数就把纯类型模块变成了运行时模块，虽然不产生环（回边被 `verbatimModuleSyntax` 强制成 type-only），但白白多一层要想清楚的东西。放进 `model-client.ts` 后，该文件正好是「1 个导出纯函数 + 1 个顶层 INDEX + 4 行 `createModelClient`」，**残留硬编码的物理落脚点本身就没了**。它会经 `index.ts:4` 的 `export *` 自动进公开 API —— 这没坏处，但是个有意识的决定。
2. **`make` 必须是闭包，禁止在模块顶层直接持类引用**（评审 P7）。`{ protocol: 'anthropic', ctor: AnthropicClient }` 这种写法，若常量声明在 `class AnthropicClient`（`anthropic-client.ts:107`）之前，会在模块求值期踩 class 的 TDZ 抛 ReferenceError。`make(p, m) => new AnthropicClient(p, m)` 把引用推迟到调用时，天然免疫。

### 3.3 查表

`createModelClient` 的签名**一个字不改**（`(provider: ProviderConfig, model: string) => ModelClient`），只把 switch 换成查表：

```ts
const INDEX = buildProviderIndex(BUILTIN_PROVIDER_MODULES)  // 模块加载时一次
```

- 查不到 → 抛 `Unknown provider protocol "x". Known protocols: anthropic, openai`（协议名由 `INDEX` 的键实时生成，不硬写）。
- **不给 `createModelClient` 加注入参数**。理由见 §5 的测试策略：扩展性由 `buildProviderIndex` 这个纯函数证明，不需要为测试拓宽全仓被调用最多的工厂的公开签名。

签名不变是硬约束。`createModelClient` 全仓 **9 处引用**（初稿写 8 处、行号有误，评审 P2 订正）：

| 位置 | 说明 |
|---|---|
| `core/settings.ts:424` | 调用 |
| `core/workflow.ts:180` | 调用 |
| `server/createSession.ts:89,100` | 调用 |
| `server/SessionManager.ts:301` | **函数值引用**（`this.createClient = opts.createClient ?? createModelClient`），真正调用在 `:757` 与 `:1351`。签名声明在 `:148` |
| `server/startServer.ts:128` | 调用 |
| `tools/agent-tool.ts:285` | 调用 |
| `tui/useConversation.ts:818,1002` | 调用 |
| `scripts/ping-api.ts:11` | 调用，**deep import**（`../packages/core/src/model-client.js`，绕开 index），且**不在任何 tsconfig 的 include 里** —— `pnpm typecheck` 覆盖不到它，改完须手跑 `pnpm api:ping` 验证 |

以上**全部零改动**。

## 4. 验收

1. **机制上纯追加**：加一个协议 = 新建 `xxx-client.ts`（导出 class + 唯一命名的 `xxxProviderModule`）+ 在 `builtin-providers.ts` 加一行 import、一行数组项。**不碰** `types.ts`、**不碰** `model-client.ts`。

   但「加协议」这个动作的完整 DoD 不止这两个文件——下面两项**不是机制耦合**，却必须一起做，写在这里防止验收 1 被读成「全部工作就 2 个文件」：
   - **文档面需同步**：`packages/tools/src/builtin-skills.ts:59` 的协议枚举（随包发给模型）、`docs/voice.md:34,39,55`。
   - **能力面**：新协议默认**不**获得 voice（`packages/server/src/voice/VoiceService.ts:193` 硬编码 `!== 'openai'`），见非目标 1。
2. `anthropic` / `openai` 行为逐字不变：`createModelClient` 对两种协议仍返回对应 class 的实例，`getModel()` 结果不变。
3. 全仓 6 个包 typecheck 绿、单测绿；额外手跑 `pnpm api:ping`（typecheck 盖不到的第 9 处）。

## 5. 测试

| # | 文件 | 断言 | 锁住什么 |
|---|---|---|---|
| 1 | `model-client.test.ts` | anthropic/openai → 对应 class 实例 + `getModel()` | 验收 2 的行为回归锁 |
| 2 | `model-client.test.ts` | 未知协议抛错，且 message **含已知协议清单** | 否则 §2「用错误信息补偿 IDE 补全」就是空话 |
| 3 | `model-client.test.ts` | `BUILTIN_PROVIDER_MODULES.map(m => m.protocol)` === `['anthropic','openai']` | R3 同款全集回归锁（对齐 `builtin-tools.test.ts:23`）；防误删/误序 |
| 4 | `model-client.test.ts` | `buildProviderIndex([重复 protocol])` 抛错 | 查重；纯函数，不需要模块顶层抛 |
| 5 | `model-client.test.ts` | `anthropicProviderModule.make()` 与 `new AnthropicClient()` 等价 | 模块本身被直接覆盖，不只靠默认路径间接覆盖 |
| 6 | **新文件** `provider-registry.test.ts` | `vi.mock` 掉 `builtin-providers.js` 换成假表 → 自造协议可解析 **且 `'anthropic'` 必须抛** | **验收 1 —— 默认路径数据驱动、无残留硬编码** |

第 6 条是本次唯一真正证明价值主张的锁，评审二轮已做**变异测试**验证：干净的 4 行查表实现 `2 passed`；把
`if (provider.protocol === 'anthropic') return new AnthropicClient(...)` 这种残留兜底塞回去 → `1 failed | 1 passed`。

> 初稿曾断言「这条测不住、只能靠 review」，**是错的**，已推翻。顺带记一条推理教训：曾考虑的「给 `createModelClient` 加注入第三参」方案，其测试**同样锁不住验收 1** —— 它证明的是注入路径数据驱动，而验收 1 说的是**默认路径**。所以删掉第三参不是「牺牲测试换 API 干净」，是把假锁换成真锁。

**实现第 6 条的三个坑**（评审实测踩过，照抄可省时间）：

1. **`vi.mock` 工厂必须自包含**。把假模块提到文件顶层会炸 `ReferenceError: Cannot access 'fakeModule' before initialization`（`vi.mock` 被 hoist 到 import 之上）。假模块要内联在工厂里。
2. **必须单独一个测试文件**。`vi.mock` 是文件级的，跟第 1/2 条放同一文件会让那两条解析到假表上直接崩。`model-client.test.ts` 保持不 mock。
3. **不是新范式**，仓库已有先例：`packages/tui/src/components/InputBox.test.ts:260`。（`packages/web` 里用得更多，但根 `vitest.config.ts` 的 `exclude` 把 `packages/web/**` 排除在根 run 之外，不算数。）

**这条锁的边界（这部分才真的靠 review）**：它锁的是「**按 protocol 分发这条路径**是纯数据驱动的」。锁不住另一类特例——比如有人改按 `provider.id` 或 `baseURL` 加分支。这是个窄得多的 review 残留，跟「整条价值主张都靠 review」不是一个量级。

## 6. 非目标

1. **不修 voice 的 openai-only 判断**。`VoiceService.ts:193` 硬编码 `protocol !== 'openai'`，意味着**新加的协议默认不获得 voice 能力**（会被 warnOnce 提示后静默禁用）。这是本次范围外的既有约束，如实记在这里，避免验收 1 被读成比实际更强。
2. **不改 `builtin-skills.ts:59`**。该处内置技能正文写死了「`protocol`（`anthropic` 或 `openai`）」，是随包发给模型的事实陈述。关键在于：**R4 合并的那一刻这行字仍然是对的**——R4 只搬机制，协议仍是两个。它变错的时刻恰恰是「有人加第三个协议」的时刻，所以它不是 R4 引入的缺陷，而是「加协议」这个动作的 DoD 清单项（已写进验收 1）。

   现在动它反而负收益：改成「anthropic、openai 等」会让今天读到它的模型失去精确枚举，写 settings 时更容易瞎猜。

   也**否掉**「把枚举插值成 `BUILTIN_PROVIDER_MODULES.map(...)`」这个看起来更聪明的选项：机械上一行就能做（`ZUSE_CONFIG_BODY` 是普通模板字面量，`packages/tools` 本就 value-import `@zuse/core`），但它把一段发给模型的 prompt 变成运行时可变值，并且开了坏头——那段 body 里还有权限模式、MCP 形状、cron 路径一堆同类硬编码事实，按同一逻辑都该插值，就没边了。为一个几年不变一次的枚举引入这层间接性是 YAGNI。
3. **不**给 provider 加 `enabled?` 条件注册。工具需要它是因为有 key/配置门槛（WebSearch 没 key 就不暴露），协议没有这种门槛。
4. **不**动 settings 解析与校验（`raw.protocol ?? 'anthropic'` 保持原样）。
5. **不**做第三方/外部 provider 的运行时加载（总纲 §6 非目标：不做插件市场）。
6. **不**顺手重构 `AnthropicClient` / `OpenAIClient` 内部。
