import {
  createAgentTool,
  createScheduleWakeupTool,
  createTodoWriteTool,
  type TodoItem,
} from '@zuse/tools'
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
  /**
   * 安排一次自唤醒（B2）。返回 false = 被唤醒链的 deadline 拒绝（cron 会话额度用完）。
   * 暴露的是「安排」而非「投递」：到点怎么投（忙则 steer / 闲则 submit）是 SessionManager 的内部细节。
   */
  scheduleWakeup: (delayMs: number, message: string) => boolean
  /**
   * 登记一个后台 Agent（B1），返回完成回调。超并发上限时 throw。
   * 与 scheduleWakeup 同形：暴露的是「登记」而非「投递」——到点怎么投（忙则 steer /
   * 闲则 submit）是 SessionManager 的内部细节。
   */
  startBackgroundAgent: (description: string) => (result: string) => void
}

/**
 * 会话级工具清单：每项把能力上下文映射成一个 Tool。数组顺序即注册顺序。
 * 加会话级工具 = 往这里加一项（并按需给 SessionCapabilityContext 加字段）。
 */
export const SESSION_CAPABILITY_TOOLS: Array<(ctx: SessionCapabilityContext) => Tool> = [
  // ctx 是能力面，字段名按会话侧的含义取；这里显式映射到 AgentToolDeps 的对应字段。
  // （ctx 的其余字段正好覆盖 AgentToolDeps 所需；多出来的 setTodos/scheduleWakeup 被忽略。）
  (ctx) => createAgentTool({ ...ctx, onBackground: ctx.startBackgroundAgent }),
  (ctx) => createTodoWriteTool({ onUpdate: ctx.setTodos }),
  // ScheduleWakeup（B2）。**不为 cron 会话开特例** —— 按会话类型加 if 等于把特例贴回共享机制，
  // 正是这张清单要消灭的东西；cron 的差异由 CronScheduler 用 deadline 表达。
  // 措辞也刻意不提 cron：设额度的一方将来可能不止 cron，而上限值只住在 CronScheduler 里。
  (ctx) => createScheduleWakeupTool({
    onSchedule: (delayMs, message) => {
      if (!ctx.scheduleWakeup(delayMs, message)) {
        throw new Error('本会话的自唤醒额度已用完 —— 需要更长周期的轮询请改用 cron 定时任务。')
      }
    },
  }),
]
