import type { Tool } from '@zuse/core'

const MIN_DELAY = 1
const MAX_DELAY = 3600

export interface ScheduleWakeupDeps {
  onSchedule: (delayMs: number, message: string) => void
}

export function createScheduleWakeupTool(deps: ScheduleWakeupDeps): Tool {
  return {
    name: 'ScheduleWakeup',
    // 会话级：onSchedule 给**父会话**排唤醒、吃父会话的额度。见 Tool.sessionScoped。
    sessionScoped: true,
    description:
      'Schedule a delayed self-wakeup. After delaySeconds, the message is injected as a ' +
      'user message and triggers a new agent turn. Use this to poll external state (CI, ' +
      'deploy, build) without blocking. Only one pending wakeup at a time — a new call ' +
      'replaces the previous one.',
    inputSchema: {
      type: 'object',
      properties: {
        delaySeconds: {
          type: 'number',
          description: `Delay in seconds (${MIN_DELAY}-${MAX_DELAY}). After this time, the agent wakes up automatically.`,
        },
        message: {
          type: 'string',
          description: 'Text injected as a user message when the wakeup fires, triggering a new agent turn.',
        },
      },
      required: ['delaySeconds', 'message'],
    },
    async run(input: unknown) {
      const { delaySeconds, message } = input as { delaySeconds?: unknown; message?: unknown }

      if (typeof delaySeconds !== 'number' || !isFinite(delaySeconds)) {
        return { output: 'ScheduleWakeup requires a numeric "delaySeconds".', isError: true }
      }
      if (typeof message !== 'string' || message === '') {
        return { output: 'ScheduleWakeup requires a non-empty "message" string.', isError: true }
      }

      const clamped = Math.max(MIN_DELAY, Math.min(MAX_DELAY, Math.round(delaySeconds)))
      deps.onSchedule(clamped * 1000, message)

      return { output: `Wakeup scheduled in ${clamped}s: ${message}` }
    },
  }
}
