# R4 — provider 注册表 设计

> **日期**: 2026-08-06
> **总纲**: [可扩展性重构总纲](2026-07-17-extensibility-refactor-roadmap.md) §4 R4
> **性质**: 轻量 spec（机械重构，行为不变）。不单独出实现计划，TDD 直接做。
> **前置**: 无（R4 在总纲里标为独立块，任意时点可插空）

---

## 1. 痛点（file:line 实证）

加一个模型协议，今天要改**三个中央位置**：

| 位置 | 现状 |
|---|---|
| `packages/core/src/types.ts:115` | `export type ProviderProtocol = 'anthropic' \| 'openai'` —— 闭合联合 |
| `packages/core/src/model-client.ts:32-43` | `switch (provider.protocol)` + `never` 穷尽检查 |
| `packages/core/src/model-client.ts:3-4` | 顶部静态 `import` 两个具体 client 类 |

总纲 §4 R4 的验收标准是「加一个 provider 协议**只写新 client + 一行注册**」，当前形态达不到。

## 2. 方案选择

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A（采纳）** | 显式索引数组 + 协议放宽为 `string` | 真正纯追加；代价是丢掉联合类型的编译期约束 |
| B | 保留联合，注册表只做运行时分发 | 类型安全不丢，但加协议仍要改中央 union —— **达不到验收标准** |
| C | 各 client 文件里副作用 `import` 自注册 | 加文件即生效，但依赖 import 副作用，tree-shaking 不友好、顺序敏感，与总纲 §6「不引运行时目录扫描，保持确定性、可 tree-shake」的精神相悖 |

**采纳 A。放宽联合的实际代价接近零**，理由是实证的，不是推断的：

- `ProviderProtocol` 全仓只出现在 `types.ts` 的 3 处（第 115 行定义 + 137、153 两处字段声明），**没有任何消费方**。
- `protocol` 的真实来源是 settings.jsonc，而 `settings.ts:405` 是 `protocol: raw.protocol ?? 'anthropic'` —— 一个**无校验的运行时透传**。配置里把协议名拼错，今天也是运行时才炸，联合类型对外部输入从来没有保护作用。
- R4 之后 core 内不再有任何地方 `switch` 协议，穷尽检查随之失去意义。

**明确接受的代价**：IDE 里手写 `protocol:` 字面量不再有自动补全。用「未知协议时把已知协议列表打进错误信息」来补偿——这对真实故障场景（配置写错）比补全更有用。

## 3. 设计

### 3.1 形状对齐 R3

直接复用 R3 已跑通的形状（`packages/tools/src/tool-module.ts` + `builtin-tools.ts`），不发明新范式。

```
packages/core/src/
  provider-module.ts      新增：ProviderModule 接口
  builtin-providers.ts    新增：BUILTIN_PROVIDER_MODULES 显式数组
  anthropic-client.ts     + export const providerModule
  openai-client.ts        + export const providerModule
  model-client.ts         switch → 查表；删掉对具体 client 类的 import
  types.ts                ProviderProtocol: 联合 → string
```

### 3.2 接口契约

```ts
// provider-module.ts
export interface ProviderModule {
  /** 协议标识，即 settings 里 providers[].protocol 的取值。 */
  protocol: string
  /** 构造该协议的 client。 */
  make(provider: ProviderConfig, model: string): ModelClient
}
```

`ProviderModule` 单独成文件（不塞进 `model-client.ts`），是为了让各 client 文件能 type-only 引用它而不反向依赖工厂——与 `model-client.ts` 现有注释「clients 仅 type-only 依赖本文件，无运行时环」的约束保持一致。

### 3.3 索引与查表

```ts
// builtin-providers.ts
export const BUILTIN_PROVIDER_MODULES: ProviderModule[] = [
  anthropicProviderModule,
  openaiProviderModule,
]
```

`createModelClient` 的签名**一个字不改**（`(provider: ProviderConfig, model: string) => ModelClient`），只把 switch 换成按 `protocol` 查表：

- 表在模块加载时由数组构建一次（`Map<string, ProviderModule>`），不是每次调用重建。
- 数组里协议名重复 = 编程错误，构表时直接抛，不静默后者覆盖前者。
- 查不到 → 抛 `Unknown provider protocol "x". Known protocols: anthropic, openai`。

签名不变是硬约束：`createModelClient` 有 **8 处调用点**——
`core/settings.ts:424`、`core/workflow.ts:180`、`server/createSession.ts:89,100`、`server/SessionManager.ts:301`、`server/startServer.ts:128`、`tools/agent-tool.ts:285`、`tui/useConversation.ts:817,1001`。它们**零改动**。

## 4. 验收

1. 加一个协议 = 新建 `xxx-client.ts`（导出 class + `providerModule`）+ 在 `builtin-providers.ts` 加一行 import、一行数组项。**不碰** `types.ts`、**不碰** `model-client.ts`。
2. `anthropic` / `openai` 行为逐字不变：`createModelClient` 对两种协议仍返回对应 class 的实例，`getModel()` 结果不变。
3. 全仓 6 个包 typecheck 绿、单测绿。

## 5. 测试

在现有 `model-client.test.ts` 上扩：

- 保留：两条「协议 → 正确 class 实例」的断言（就是验收 2 的回归锁）。
- 改写：未知协议的断言从 `'Unknown provider protocol: grpc'` 改为新文案，并断言**错误信息里列出了已知协议**（否则「补偿补全」这个理由就是空话）。
- 新增：重复协议名的索引数组 → 构表抛错。
- 新增：**可扩展性本身的锁**——用一个自造的 `ProviderModule` 走公开 API 注入，断言无需改动 core 任何既有文件就能拿到自定义 client。这条是 R4 唯一真正的价值证明；没有它，这次重构就只是把 switch 换了个写法。

> 注：第 4 条要求 `createModelClient` 能接受外部传入的模块表。为不破坏 8 处调用点的签名，用**可选第三参**（`modules?: ProviderModule[]`，缺省 `BUILTIN_PROVIDER_MODULES`）而不是全局可变注册表——全局可变状态会让测试互相污染，且与 core「无隐式全局」的现状不符。

## 6. 非目标

- **不**给 provider 加 `enabled?` 条件注册。工具需要它是因为有 key/配置门槛（WebSearch 没 key 就不暴露），协议没有这种门槛。
- **不**动 settings 解析与校验（`raw.protocol ?? 'anthropic'` 保持原样）。
- **不**做第三方/外部 provider 的运行时加载（总纲 §6 非目标：不做插件市场）。
- **不**顺手重构 `AnthropicClient` / `OpenAIClient` 内部。
