# Zuse Phase 6 · 多 Provider 设计

> 状态：已定稿，待写实现计划。
> 上游：[phase-roadmap.md](../plans/phase-roadmap.md) Phase 6；主设计文档 §4（架构）、§5（Phase 6 路线）。
> 关联补充：[2026-05-23-zuse-design-supplement.md](2026-05-23-zuse-design-supplement.md) 三（Cache 优化）。

## 1. 目标与范围

让 zuse 能在运行时面向**多个模型 provider**工作，覆盖两套 wire 协议，并引入 prompt 缓存以降本提速。

**本期做：**

- **Provider registry**：数据驱动的多 provider 配置（加 provider = 一条配置 + 一个 env var，零业务逻辑改动）。
- **`OpenAIClient`（手搓）**：用 `openai` SDK 实现 `ModelClient`，亲手处理 OpenAI 协议与 Anthropic 协议的 tool_call 格式 / 流式 / usage 差异。这是本阶段的核心学习点（roadmap：「Anthropic vs OpenAI tool_use 格式差异」）。
- **Local Ollama**：作为 `OpenAIClient` 的一条配置复用，不写第二个 client。
- **`/model` 切换**：运行时在已配置的 provider × model 间切换；session 生效，`--save` 可写盘持久化。
- **Anthropic Prompt Caching**：在 system / 工具 / 历史尾部打 `cache_control` 断点；两套协议都把 cache 命中 token 捞出来在 footer 显示。

**本期不做（YAGNI）：**

- 不引入 Vercel AI SDK 统一协议（见 §2 选型理由）。
- 不做缓存 TTL 管理、不做「哪块该缓存」的动态决策——只用固定断点。
- 不为 OpenAI 模拟 Anthropic 的 cache 写入统计。
- 不对真实 provider API 打集成测试（留手工验证）。
- 不测 Ink 渲染。

## 2. 选型：手搓两个 client，不用统一 SDK

**决策：在现有 `ModelClient` 接口下放两个具体实现（`AnthropicClient`、`OpenAIClient`），用工厂按 `protocol` 分发。**

考虑过的替代：

- **Vercel AI SDK（`ai` + `@ai-sdk/*`）统一两套协议。** 代码量小、边界稳、未来加 provider 近零成本，若 zuse 定位为生产工具应选它。**否决理由**：它恰好把本阶段要学的三样东西全藏起来——`ModelClient` 抽象、两套 tool_use 格式差异、手搓 provider 层；且与全仓「手搓」基调（ripgrep 封装、glob 递归、权限文法皆手写）不一致；DashScope `/apps/anthropic` 是非标端点，自写 `@anthropic-ai/sdk` 反而稳。
- **单 client 内部按 protocol 分支。** 否决：违反单一职责，两套协议的流式 / 工具模型差异够大，合并会缠成一团。

**可换性保留**：`ModelClient` 这个 seam 就是为换实现留的。将来若要图省事，把两个 client 换成 AI SDK 适配器是局部改动——接口、agent loop、TUI 全不动。（记入 BACKLOG。）

## 3. 配置模型（Provider Registry）

### 3.1 形状

`RawSettings` / `ResolvedSettings` 增加 `providers` map，每条自包含：

```jsonc
{
  "model": "qwen/qwen3-coder-plus",        // "<providerId>/<model>" —— 当前选中项
  "providers": {
    "qwen":     { "protocol": "anthropic", "baseURL": "https://dashscope.aliyuncs.com/apps/anthropic", "apiKey": "sk-...", "models": ["qwen3-coder-plus", "qwen3-max"] },
    "deepseek": { "protocol": "openai",    "baseURL": "https://api.deepseek.com/v1", "apiKey": "sk-...", "models": ["deepseek-chat"] },
    "ollama":   { "protocol": "openai",    "baseURL": "http://localhost:11434/v1", "apiKey": "ollama", "models": ["qwen2.5-coder"] }
  }
}
```

`ProviderConfig` 字段：

| 字段 | 说明 |
| --- | --- |
| `protocol` | `'anthropic' \| 'openai'`。决定用哪个 client。 |
| `baseURL` | 端点。Anthropic 兼容端点（DashScope）也走 `anthropic`。 |
| `apiKey` | 字面量写本地层（gitignore）。Ollama 用占位串 `"ollama"`。 |
| `models` | 该 provider 下可选模型，仅作 `/model` 列表与补全提示，**不做硬约束**（允许 `/model` 自由输入未列出的 model）。 |

### 3.2 `model` 引用解析

- `"<providerId>/<model>"` → `{ providerId, model }`。
- 裸字符串（无 `/`）→ default provider 下该 model（向后兼容）。

### 3.3 向后兼容（优雅降级）

若 settings 无 `providers`：把现有扁平 `baseURL` / `apiKey` / `model` 包成一个合成的 `default` provider，`protocol` 取 `'anthropic'`。旧 `settings.local.jsonc` 原样可用。

> 迁移动作：把现有 `.zuse/settings.local.jsonc`、`.zuse/settings.local.json.example`、`.env.example` 一并迁到 registry 结构，演示新写法。

### 3.4 层合并

`providers` 按 **id 深合并**三层（用户 < 项目 < 本地）：同 id 的 provider 字段逐个高层覆盖低层。这样项目层可定义 provider 骨架、本地层只补 `apiKey`。其余标量（`model` 等）沿用既有「高层覆盖」语义。

### 3.5 Key 来源与校验

优先级：`ZUSE_API_KEY_<ID>`（id 大写）环境变量 > provider 字面量 `apiKey`。遗留 `ZUSE_API_KEY` 仍覆盖**当前选中** provider 的 key。

缺 key 时报错并指明是哪个 provider；但占位 key（如 Ollama 的 `"ollama"`）视为合法、不算缺失。

## 4. 两个 Client + 工厂

### 4.1 接口与工厂

`ModelClient` 接口不变（`sendMessages` + `getModel`）。新增：

```typescript
interface ProviderConfig {
  id: string
  protocol: 'anthropic' | 'openai'
  baseURL?: string
  apiKey: string
  models: string[]
}

interface ModelSelection { providerId: string; model: string }

function createModelClient(provider: ProviderConfig, model: string): ModelClient {
  switch (provider.protocol) {
    case 'anthropic': return new AnthropicClient(provider, model)
    case 'openai':    return new OpenAIClient(provider, model)
  }
}
```

旧入口 `createAnthropicClient(settings)` 改造成 `createClientFromSettings(settings)`：解析 `model` 引用 → 取 `ProviderConfig` → 调工厂。

### 4.2 `AnthropicClient` 改动

构造函数从 `(ClientConfig, defaultModel)` 收敛为 `(ProviderConfig, model)`。stream → `finalMessage()` 拼 tool_use 的逻辑原样保留。§6 在此加 cache_control。

### 4.3 `OpenAIClient`（核心手搓）

用 `openai` SDK 实现 `ModelClient`。**SDK 实例可注入**（构造函数收一个可选 client / 工厂），以便单测传 mock、不打真网。三处翻译：

**① 出站消息：zuse `Message[]` → OpenAI `messages[]`**

- `ModelConfig.system` → 开头一条 `{ role: 'system', content }`。
- text block → `content` 字符串。
- assistant 的 `tool_use` block → `{ role:'assistant', tool_calls:[{ id, type:'function', function:{ name, arguments: JSON.stringify(input) } }] }`。
- `tool_result` block → 独立顶层一条 `{ role:'tool', tool_call_id, content }`（**与 Anthropic 最大的结构差异**：OpenAI 把工具结果当顶层 message，不塞进 user content）。

**② 工具声明：zuse `ToolDefinition` → OpenAI `tools`**

- `{ type:'function', function:{ name, description, parameters: inputSchema } }`（Anthropic 用 `input_schema`，OpenAI 用 `function.parameters`）。

**③ 入站流式：OpenAI delta → zuse `StreamEvent`**

- 首 chunk → `message-start`（id / model 取自 chunk）。
- `delta.content` → `text-delta`。
- `delta.tool_calls[i].function.arguments` → **按 index 累积分片字符串**；流结束（`finish_reason`）时 `JSON.parse` 拼好的参数，逐个发 `tool-use`。（等价于 Anthropic SDK 的 `finalMessage()`，但要手写按 index 攒。）
- `finish_reason` 映射 stop_reason：`tool_calls` → `'tool_use'`、`stop` → `'end_turn'`。
- usage：请求带 `stream_options:{ include_usage:true }`，末 chunk 的 `usage` → `message-stop`。
- try/catch → `error` 事件，与 `AnthropicClient` 一致。

**不变量**：两个 client 对外只产出 `StreamEvent`，agent loop / TUI 不知底层协议（保持 spec §4.4「UI 完全 provider-agnostic」）。

## 5. `/model` 命令与切换

### 5.1 命令行为（数据驱动，注册进 `COMMANDS` 表）

- `/model`（无参）→ 列出所有 `providers` 的 `<providerId>/<model>` 组合，标出当前项。
- `/model <providerId/model>` → 切换。校验 provider 存在；model 不做硬约束（列表仅作提示，允许自由输入）。
- `/model <model>`（无 `/`）→ 在**当前 provider** 下换模型。
- `/model <x> --save` → 切换并把顶层 `model` 写进 `settings.local.json`（见 5.3）。

### 5.2 Client 热替换

client 所有权从 `App.tsx` 启动局部变量挪进 `useConversation` hook：

- hook 持 `clientRef` + `activeSelection` state（`{ providerId, model }`）。
- 切换 → `createModelClient(provider, model)` 重建 `clientRef.current`，更新 `activeSelection`（驱动 footer 重渲染）。
- **切换不清空会话历史**（历史是 provider 无关的 `Message[]`，换 provider 后带上下文继续）。
- `CommandContext` 增 `switchModel(selection)` 能力，由 hook 注入；命令只通过它行动（沿用 `clear` / `load` 模式）。

### 5.3 持久化（session + 可选写盘）

- `/model <x>` → 仅本 session（改内存 `activeSelection`）。
- `/model <x> --save` → 额外把顶层 `model` 写进 `settings.local.json`，下次启动默认即新模型。
- 新增 `setModelInSettings(model, localPath?)`：复用 jsonc-parser 的 `modify` / `applyEdits`，**只改 `model` 一处**，保留注释与格式，幂等（沿用 `appendAllowRule` 范式）。

footer 已有 `model={client.getModel()}`，热替换后自动显示新模型，`UsageFooter` 不动。

## 6. Prompt Caching 与 cache token 统计

### 6.1 Anthropic 侧（cache_control 打标）

稳定前缀 = system + 工具定义；可变尾部 = 对话历史。固定断点策略：

- **tools**：最后一个 tool 定义挂 `cache_control: { type: 'ephemeral' }` → 整个 tools 块进缓存。
- **system**：以块形式 `system: [{ type:'text', text, cache_control:{type:'ephemeral'} }]` 打标。
- **历史滚动断点**：在「当前 staged 之前的最后一条历史消息」挂断点 → 每轮把上一轮为止的历史缓存住，下轮命中。
- DashScope 等兼容端点不认 `cache_control` 时会忽略，无害。

### 6.2 OpenAI 侧（自动缓存，不打标）

OpenAI 协议缓存由服务端自动完成（≥1024 token 前缀），不打标，只**读** `usage.prompt_tokens_details.cached_tokens`。Ollama / DeepSeek 不返回该字段时当 0。

### 6.3 Usage 扩展与展示

```typescript
interface Usage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number     // Anthropic: cache_read_input_tokens；OpenAI: cached_tokens
  cache_creation_input_tokens?: number  // Anthropic 专有；OpenAI 留空
}
```

- 两个 client 各自从自家 usage 字段填入。
- `conversation.addUsage` 累加两个新字段。
- footer 增量显示缓存命中（如 `cache: 12.3k read`），呼应补充文档「Cache 命中监控」。

## 7. 测试策略

**core 侧全程 TDD**（沿用 settings / permission / agent 传统）；**TUI 侧手工验证**。

### 7.1 core 单测

- **`settings.test.ts` 扩充**：`providers` 三层按 id 深合并；`model` 引用解析；无 `providers` 时合成 `default`；key 优先级（`ZUSE_API_KEY_<ID>` > 字面量；遗留 `ZUSE_API_KEY` 覆盖当前）；缺 key 报错但占位 key 合法。
- **`openai-client.test.ts`（新）**：三处翻译纯函数化测试。出站（tool_use → tool_calls、tool_result → 顶层 tool、system → 开头）、工具声明（input_schema → function.parameters）、入站流式（喂含**分片 tool_call.arguments** 的假 chunk，断言拼出完整 JSON、按 index 发 tool-use、finish_reason 映射、usage 含 cached_tokens 落到 Usage）。SDK client 以 mock 注入。
- **`model-client-factory.test.ts`（新）**：工厂按 protocol 选对实现。
- **`anthropic-client` cache 断言**：打标逻辑抽成纯函数，断言断点贴在 system / 最后一个 tool / 历史滚动位置。
- **`setModelInSettings`**：只改 `model`、保留注释格式、幂等。

### 7.2 TUI 手工验证清单（写进 plan）

- `/model` 列出组合并标当前项；`/model <x>` 切换后 footer 模型名变、历史不清空、可继续对话。
- `/model <x> --save` 后 `settings.local.json` 的 `model` 被改、注释仍在；重启默认是新模型。
- 真连一个 OpenAI 协议端点（DeepSeek 或本地 Ollama）跑通一轮**带工具调用**的对话。
- Anthropic 端多轮对话观察 footer cache_read 上升。

## 8. 影响面 / 文件清单

- **core**
  - `types.ts`：`Usage` 加两个 cache 字段；新增 `ProviderConfig` / `ModelSelection`；`ResolvedSettings` 加 `providers`。
  - `settings.ts`：`providers` 深合并、`model` 引用解析、向后兼容合成、`setModelInSettings`。
  - `env.ts` → 改造 key 来源 / provider 解析；`getClientConfig` 演进为按 provider 取配置。
  - `model-client.ts`：保留接口，加 `createModelClient` 工厂。
  - `anthropic-client.ts`：构造签名收敛 + cache_control 打标。
  - `openai-client.ts`（新）。
  - `index.ts`：导出新符号。
- **tui**
  - `App.tsx`：client 所有权下移到 hook。
  - `hooks/useConversation.ts`：`clientRef` / `activeSelection` / `switchModel`。
  - `commands/registry.ts` + `commands/types.ts`：`/model` 命令 + `switchModel` 能力。
  - `components/UsageFooter.tsx`：显示 cache 命中（小改）。
- **配置 / 文档**
  - 迁移 `.zuse/settings.local.jsonc`、`.zuse/settings.local.json.example`、`.env.example` 到 registry 结构。
  - `BACKLOG.md`：记「未来可换 Vercel AI SDK」。
  - `package.json`（core）：加 `openai` 依赖。
  - README / roadmap：Phase 6 完成后更新状态。

## 9. 待解决 / 风险

- OpenAI 流式中**多个并发 tool_call** 的 index 攒接：需确保按 `index` 而非数组顺序累积（断言覆盖）。
- DashScope `/apps/anthropic` 对 `cache_control` 的实际行为未知——按「不认则忽略」处理，不阻断。
- Ollama 工具调用支持依模型而定（新版 + 支持 tools 的模型才有 `tool_calls`），写入文档 caveat。
