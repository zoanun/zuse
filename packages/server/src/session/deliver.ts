import type { SessionManager } from './SessionManager.js'

/** deliverToSession 驱动的 SessionManager 子集（便于单测注入 spy）。 */
export type DeliverTarget = Pick<SessionManager, 'isBusy' | 'steer' | 'submit'>

/**
 * 把一条文本投进会话并驱动一轮。
 *
 * - **忙**（回合进行中）→ `steer`：能折进当前回合就折进去，折不进的由 SessionManager 的
 *   idle-drain 在回合结束后作为独立后续回合排空。直接 submit 会抛「A turn is already in progress」。
 * - **闲** → `submit({ echo: true })`。`echo` 不能省：前端在自己认为「正在跑」时走 steer 路径、
 *   只画一个临时的「排队中」预览，服务端若不回 user-echo，那个预览永远化不成真气泡。
 *
 * ws 上行的 steer 分派与 ScheduleWakeup 的到点投递共用它 —— 两者要的是同一条规则，
 * 各写一遍必然漂移，而漂移的后果是「消息静默丢了」这种最难查的形态。
 */
export function deliverToSession(
  mgr: DeliverTarget,
  text: string,
  opts?: {
    messageId?: string
    images?: Parameters<SessionManager['submit']>[1]
    pastedTexts?: Parameters<SessionManager['submit']>[2]
    files?: Parameters<SessionManager['submit']>[3]
    onError?: (message: string) => void
  },
): void {
  const { messageId, images, pastedTexts, files, onError } = opts ?? {}
  if (mgr.isBusy()) {
    mgr.steer(text, images, pastedTexts, files, { messageId })
    return
  }
  mgr.submit(text, images, pastedTexts, files, { echo: true, messageId }).catch((err: unknown) => {
    onError?.(err instanceof Error ? err.message : String(err))
  })
}
