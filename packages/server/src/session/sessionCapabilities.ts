import { createAgentTool, createTodoWriteTool, type TodoItem } from '@zuse/tools'
import type {
  Tool,
  ModelClient,
  ToolRegistry,
  ResolvedSettings,
  PermissionRequest,
  PermissionVerdict,
} from '@zuse/core'

/**
 * 会话作用域能力面：会话级工具从它构造所需依赖。传输无关（无 WS/HTTP 概念）。
 * getClient/getSystemPrompt 是取值函数：failover 热替换 client、prompt 变更后，
 * 调用时总取当前值。sessionAllow 为共享引用（本会话累积的 allow_session 规则）。
 */
export interface SessionCapabilityContext {
  registry: ToolRegistry
  getClient: () => ModelClient
  getSystemPrompt: () => string
  settings: ResolvedSettings
  sessionAllow: string[]
  canUseTool: (req: PermissionRequest) => Promise<PermissionVerdict>
  setTodos: (todos: TodoItem[]) => void
}

/**
 * 会话级工具清单：每项把能力上下文映射成一个 Tool。数组顺序即注册顺序。
 * 加会话级工具 = 往这里加一项（并按需给 SessionCapabilityContext 加字段）。
 * ScheduleWakeup 待 C1（需 ctx 加「注入消息+触发回合」的能力）。
 */
export const SESSION_CAPABILITY_TOOLS: Array<(ctx: SessionCapabilityContext) => Tool> = [
  // ctx supplies exactly AgentToolDeps' fields (plus setTodos, which createAgentTool ignores).
  (ctx) => createAgentTool(ctx),
  (ctx) => createTodoWriteTool({ onUpdate: ctx.setTodos }),
]
