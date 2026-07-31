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
}

/**
 * 会话级工具清单：每项把能力上下文映射成一个 Tool。数组顺序即注册顺序。
 * 加会话级工具 = 往这里加一项（并按需给 SessionCapabilityContext 加字段）。
 * ScheduleWakeup 已接入（B2）：能力面暴露的是 scheduleWakeup（安排），投递细节留在 SessionManager。
 */
export const SESSION_CAPABILITY_TOOLS: Array<(ctx: SessionCapabilityContext) => Tool> = [
  // ctx supplies exactly AgentToolDeps' fields (plus setTodos, which createAgentTool ignores).
  (ctx) => createAgentTool(ctx),
  (ctx) => createTodoWriteTool({ onUpdate: ctx.setTodos }),
  // ScheduleWakeup（B2）。**不为 cron 会话开特例** —— R2 的价值就是「一张清单、循环注册」，
  // 按会话类型加 if 等于把特例贴回共享机制。cron 的差异由 CronScheduler 用 deadline 表达。
  // 被拒绝时 throw 而非静默：core 的 runOneTool 会把抛错转成 isError 结果回喂模型
  // （不打断回合），模型因此能看到真实原因并改用 cron，而不是以为自己排上了。
  (ctx) => createScheduleWakeupTool({
    onSchedule: (delayMs, message) => {
      if (!ctx.scheduleWakeup(delayMs, message)) {
        throw new Error('本次定时任务的自唤醒额度已用完（唤醒链上限 1 小时）——需要更长周期的轮询请改用 cron 定时任务。')
      }
    },
  }),
]
