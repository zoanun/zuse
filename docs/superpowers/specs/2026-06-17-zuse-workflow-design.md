# Workflow 编排 API 设计文档（Phase 15.2）

> **日期**: 2026-06-17
> **状态**: 设计完成，待实现
> **依赖**: agent.ts (runAgent)、agent-tool.ts (createAgentTool)、conversation.ts、tool.ts

---

## 1. 目标

提供 `parallel` / `pipeline` / `agent` 三个 TypeScript API，用于确定性地编排多个子 Agent 并发或流水线执行。

这是代码侧 API（供 skill、hook、未来的 Workflow Tool 调用），不是模型直接调用的工具。对标 CC 的 Workflow 中 `parallel()` / `pipeline()` / `agent()` 原语的核心子集。

## 2. API 设计

### 2.1 agent()

```typescript
interface AgentOpts {
  /** UI / 日志用的短标签。 */
  label?: string
  /** 子 Agent 可用工具白名单，缺省继承全集（去掉 Agent）。 */
  allowedTools?: string[]
  /** 模型覆盖，格式 "providerId/modelName"。 */
  model?: string
  /** 子 Agent 最大轮次，缺省 10。 */
  maxTurns?: number
}

/**
 * 发起一个隔离的子 Agent 执行任务，返回其最终文本。
 * 内部复用 runAgent，等价于 AgentTool.run() 的无 Tool 版本。
 */
async function agent(prompt: string, opts?: AgentOpts): Promise<string | null>
```

返回子 Agent 的最终文本；子 Agent 出错或被中断时返回 `null`。

### 2.2 parallel()

```typescript
/**
 * 并发执行一组 thunk，等全部完成后返回结果数组（barrier）。
 * 并发数受信号量限制（默认 min(8, cpuCount - 2)）。
 * 单个 thunk 抛错 → 该位置为 null，不影响其余。
 */
async function parallel<T>(thunks: Array<() => Promise<T>>): Promise<(T | null)[]>
```

### 2.3 pipeline()

```typescript
type Stage<In, Out> = (input: In, originalItem: any, index: number) => Promise<Out>

/**
 * 流水线：每个 item 依次通过所有 stage，item 间无 barrier。
 * Item A 可以在 stage 3 而 Item B 还在 stage 1。
 * 某 item 在某 stage 抛错 → 后续 stage 跳过，该 item 结果为 null。
 */
async function pipeline<T>(
  items: T[],
  ...stages: Array<(input: any, originalItem: T, index: number) => Promise<any>>
): Promise<any[]>
```

### 2.4 WorkflowContext

三个 API 需要共享运行时依赖（ToolRegistry、ModelClient、settings 等）。用一个 context 对象注入：

```typescript
interface WorkflowContext {
  registry: ToolRegistry
  getClient: () => ModelClient
  settings: ResolvedSettings
  getSystemPrompt: () => string
  signal: AbortSignal
  cwd: string
  tracker: FileReadTracker
  sessionAllow?: string[]
  canUseTool?: (req: PermissionRequest) => Promise<PermissionVerdict>
  /** 并发上限，缺省 min(8, cpuCount - 2)。 */
  concurrency?: number
  /** 单次 workflow 总 agent 调用数兜底上限，缺省 100。 */
  maxAgents?: number
}

/**
 * 创建一个绑定了运行时依赖的 workflow scope。
 * 返回的 agent/parallel/pipeline 共享同一个信号量和 agent 计数器。
 */
function createWorkflow(ctx: WorkflowContext): {
  agent: (prompt: string, opts?: AgentOpts) => Promise<string | null>
  parallel: <T>(thunks: Array<() => Promise<T>>) => Promise<(T | null)[]>
  pipeline: <T>(items: T[], ...stages: Function[]) => Promise<any[]>
}
```

使用示例：

```typescript
const wf = createWorkflow({ registry, getClient, settings, ... })

const results = await wf.parallel([
  () => wf.agent('查 core 的导出函数', { allowedTools: ['Grep'] }),
  () => wf.agent('查 tools 的导出函数', { allowedTools: ['Grep'] }),
  () => wf.agent('查 tui 的导出组件', { allowedTools: ['Grep'] }),
])

const verified = await wf.pipeline(
  ['file1.ts', 'file2.ts', 'file3.ts'],
  (file) => wf.agent(`分析 ${file} 的公共 API`),
  (analysis, file) => wf.agent(`验证 ${file} 的分析是否正确：${analysis}`),
)
```

## 3. 并发控制

### 3.1 信号量

`createWorkflow` 内部创建一个计数信号量（Semaphore），上限为 `ctx.concurrency ?? min(8, os.cpus().length - 2)`（至少 1）。

所有 `agent()` 调用在执行前先 acquire 信号量，执行完 release。`parallel` 和 `pipeline` 共享同一个信号量实例——不会因嵌套调用而死锁（信号量是公平的 FIFO 队列，不是可重入锁）。

### 3.2 总 agent 数兜底

`createWorkflow` 内部维护一个 `agentCount` 计数器。每次 `agent()` 调用前检查：

```
if (agentCount >= maxAgents) throw new Error('Workflow agent limit reached')
```

调用方通过 `parallel` / `pipeline` 的 null 容错拿到错误。缺省上限 100，足够任何合理 workflow，防止 bug 导致的无限循环。

### 3.3 abort 传递

`ctx.signal` 传递给每个子 `runAgent()`。workflow scope 外部 abort 时，所有在飞的子 Agent 都会被中断。

## 4. 错误处理

| 场景 | 行为 |
|------|------|
| agent() 内部 runAgent 出错 | 捕获，返回 null |
| agent() 超过 maxAgents | 抛 Error（被 parallel/pipeline 捕获为 null） |
| signal aborted | 子 Agent 中断，agent() 返回 null |
| parallel 中某 thunk 抛错 | 该位置为 null，其余继续 |
| pipeline 中某 item 某 stage 抛错 | 该 item 后续 stage 跳过，最终为 null |

## 5. 文件结构

```
packages/core/src/workflow.ts       — createWorkflow + Semaphore
packages/core/src/workflow.test.ts  — 单测
packages/core/src/index.ts          — 导出
```

## 6. 不做的（YAGNI）

- JS 脚本 runtime / eval
- Workflow Tool（模型调用）
- resume / 断点续跑
- token budget 管理
- structured output / schema 校验
- worktree 隔离
- phase() / log() 进度展示
- TUI 展示（子 Agent 的工具调用不冒泡）

这些留给未来迭代。当前 API 足够被未来的 Workflow Tool 包装。

## 7. 测试策略

- **Semaphore**: 验证并发上限、FIFO 顺序
- **agent()**: mock runAgent，验证 prompt 传递、opts 应用、错误返回 null
- **parallel()**: 验证并发执行、单个失败不影响其余、全部结果收集
- **pipeline()**: 验证多 stage 串联、item 间无 barrier、错误跳过后续 stage
- **maxAgents**: 验证超限报错
- **abort**: 验证 signal 传递中断
