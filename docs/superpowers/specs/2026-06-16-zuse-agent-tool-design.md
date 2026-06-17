# Agent Tool 设计文档（Phase 15.1）

> **日期**: 2026-06-16
> **状态**: 设计完成，待实现
> **依赖**: agent.ts (runAgent)、tool.ts (Tool/ToolRegistry)、model-client.ts (createModelClient)、settings.ts (getProviderConfig)

---

## 1. 目标

让模型能**自主决定**派遣一个隔离的子 Agent 去执行子任务，结果回填父循环。

典型场景：
- 探索性搜索（大范围 grep/glob，中间过程不污染父上下文）
- 可并行的独立子任务（未来 Workflow 的基础）
- 需要不同模型处理的子任务（便宜模型做简单活）

对标 Claude Code 的 Agent tool（supervisor 模式）。

## 2. 工具接口

### 2.1 Input Schema

```typescript
interface AgentToolInput {
  /** 子任务描述，作为子 Agent 的 user message。 */
  prompt: string
  /** UI 短标签（3-10 字），展示在工具块标题 ● Agent(description)。 */
  description: string
  /** 模型覆盖，格式 "providerId/modelName"。缺省继承父级模型。 */
  model?: string
  /**
   * 子 Agent 可用工具白名单。缺省继承父级全集（去掉 Agent 自身）。
   * 出现 "Agent" 时静默过滤（禁止递归）。
   */
  allowedTools?: string[]
}
```

### 2.2 Output

子 Agent 最终的 assistant 文本，作为 `ToolResult.output` 回填父循环。
子 Agent 无文本输出时返回 `"(子 Agent 未产生文本输出)"`，`isError: false`。

### 2.3 JSON Schema（给模型看的）

```json
{
  "type": "object",
  "properties": {
    "prompt": {
      "type": "string",
      "description": "子任务描述，作为子 Agent 的输入。要足够详细让子 Agent 独立完成。"
    },
    "description": {
      "type": "string",
      "description": "3-10 字的短标签，用于 UI 展示。"
    },
    "model": {
      "type": "string",
      "description": "可选，格式 providerId/modelName。用较便宜的模型处理简单子任务。"
    },
    "allowedTools": {
      "type": "array",
      "items": { "type": "string" },
      "description": "可选，限定子 Agent 可用的工具名列表。默认继承全部工具。"
    }
  },
  "required": ["prompt", "description"]
}
```

## 3. 运行机制

### 3.1 执行流程

```
AgentTool.run(input, ctx)
  │
  ├─ 1. 解析 input，校验 prompt/description 非空
  │
  ├─ 2. 构建子 Agent 的 ModelClient
  │     ├─ input.model 存在 → 解析 "providerId/modelName"
  │     │   → getProviderConfig(settings, providerId)
  │     │   → createModelClient(providerConfig, modelName)
  │     └─ input.model 缺省 → 复用父级 client
  │
  ├─ 3. 构建子 Agent 的 ToolRegistry
  │     ├─ 从父级 registry 克隆
  │     ├─ 移除 "Agent" 工具（禁止递归）
  │     └─ 若有 allowedTools → 过滤只保留白名单内的工具
  │
  ├─ 4. 构建子 Agent 的 system prompt
  │     └─ 父级 system prompt + 追加：
  │        "你是一个被派遣执行子任务的 Agent。你的最终文本回复会作为结果
  │         返回给调用方，不是给用户看的消息。简洁、结构化地回答。"
  │
  ├─ 5. 新建空 Conversation，调 runAgent()
  │     ├─ userText = input.prompt
  │     ├─ maxTurns = 10（子 Agent 默认上限，低于父级 50）
  │     ├─ signal = ctx.signal（父级中断时子 Agent 也中断）
  │     ├─ settings = 父级 settings（权限体系继承）
  │     ├─ tracker = 父级 tracker（read-before-edit 共享）
  │     ├─ sessionAllow = 父级 sessionAllow（权限覆盖层继承）
  │     ├─ canUseTool = 父级 canUseTool（ask 弹框继承）
  │     └─ onCwdChange = 不回写父级（子 Agent 的 cd 隔离）
  │
  ├─ 6. 消费子 runAgent() 的全部 StreamEvent
  │     └─ 提取最后一条 assistant message 的文本
  │
  └─ 7. return { output: finalText, isError: false }
```

### 3.2 model 字段解析

格式：`"providerId/modelName"`，用第一个 `/` 分割。

- 合法示例：`"anthropic/claude-sonnet-4-20250514"`、`"dashscope/qwen-max"`
- 不合法（无 `/`、providerId 找不到）→ 返回 `{ output: "Invalid model: ...", isError: true }`

### 3.3 allowedTools 处理

1. 缺省 → 父级全集去掉 `"Agent"`
2. 指定 → 只保留白名单内且父级 registry 中存在的工具；白名单含 `"Agent"` 时静默忽略
3. 白名单中有父级不存在的工具名 → 静默忽略（不报错，同 CC 行为）

## 4. 安全兜底

| 风险 | 防御 |
|------|------|
| 无限递归 | 子 Agent 的 registry 不含 Agent 工具，物理上不可嵌套 |
| 子 Agent 失控 | maxTurns=10 硬上限；继承父级 abort signal |
| 权限绕过 | 子 Agent 继承完整权限体系（settings + sessionAllow + canUseTool） |
| cd 污染 | 子 Agent 的 cwd 变更不回写父级 |
| token 爆炸 | 子 Agent 的 usage 累加进父回合 turnUsage（TUI 可见总消耗） |

## 5. TUI 展示

子 Agent 作为普通工具块展示，与 Bash/Read 等一致：

```
● Agent(搜索 async 导出函数)        ← 运行中时 spinner
  ⎿ 找到 12 个 async 导出函数...    ← 完成后摘要（summarizeOutput 截断）
```

不需要改 TUI 代码——StreamRenderer 已有的 ToolBlock 逻辑自动处理。
toolSummary.ts 的 summarizeOutput 按通用 line/preview 模式截断子 Agent 返回文本。

## 6. 工具描述（给模型看）

```
Launch a sub-agent to handle a complex or exploratory sub-task in an isolated context.
The sub-agent has its own conversation and tool access, and returns its final text as the result.
Use this when: (1) a task involves broad exploration that would pollute the main context,
(2) a sub-task can run independently, or (3) you want to use a different model for a sub-task.
The sub-agent cannot spawn further sub-agents.
```

## 7. 文件结构

```
packages/tools/src/agent-tool.ts       — AgentTool 工厂函数
packages/tools/src/agent-tool.test.ts  — 单测
packages/tools/src/index.ts            — createDefaultRegistry 中注册
```

工厂函数签名（需要外部依赖注入）：

```typescript
interface AgentToolDeps {
  /** 父级 ToolRegistry（子 Agent 从中克隆工具集）。 */
  registry: ToolRegistry
  /** 父级 ModelClient（model 缺省时复用）。 */
  getClient: () => ModelClient
  /** 解析后的设置（权限 + provider 配置）。 */
  settings: ResolvedSettings
  /** 父级系统提示词。 */
  systemPrompt: string
}

function createAgentTool(deps: AgentToolDeps): Tool
```

注册时机：TUI 层的 useConversation 初始化时注册（因为需要 client 和 settings 等
运行时依赖）。`createDefaultRegistry` 不变——AgentTool 在其返回的 registry 上追加注册。
deps 中的 `getClient` 和 systemPrompt 用 getter/ref 延迟取值，这样 `/model` 切换后
子 Agent 自动拿到新模型。

## 8. 测试策略

- **单测**：mock ModelClient + 最小 registry，验证：
  - 基本流程：prompt 传递 → 子 runAgent 执行 → 文本回填
  - model 解析：合法/不合法格式
  - allowedTools 过滤：白名单、含 Agent 时过滤、空白名单
  - 递归禁止：子 registry 不含 Agent
  - maxTurns 兜底
  - abort signal 传递
- **不做 e2e**：不调真实 API（与现有工具测试策略一致）
