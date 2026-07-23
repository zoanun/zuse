import type { SessionManager } from '../session/SessionManager.js'
import type { ClientMessage } from '@zuse/protocol'

/** 上行分派器驱动的 SessionManager 子集（便于单测注入 spy）。 */
export type SessionManagerLike = Pick<
  SessionManager,
  'submit' | 'interrupt' | 'steer' | 'resolvePermission' | 'switchModel' | 'reset' | 'revert' | 'retry' | 'compactNow' | 'isBusy'
>

/**
 * 解析一条上行 WS 文本帧并分派到 SessionManager。
 * 对不可解析/非法/未知帧、以及被拒绝的 submit（如回合进行中），调用 sendError(message)。
 * 绝不抛错（消息泵不能被一条坏帧打断）。
 */
export function applyClientMessage(
  mgr: SessionManagerLike,
  raw: string,
  sendError: (message: string) => void,
): void {
  let msg: ClientMessage
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { type?: unknown }).type !== 'string') {
      sendError('malformed message: expected an object with a string "type"')
      return
    }
    msg = parsed as ClientMessage
  } catch {
    sendError('malformed message: invalid JSON')
    return
  }

  try {
    switch (msg.type) {
      case 'send':
        if (typeof msg.text !== 'string') { sendError('send: "text" must be a string'); return }
        mgr.submit(msg.text, msg.images, msg.pastedTexts, msg.files, { messageId: msg.messageId }).catch((err) => sendError(err instanceof Error ? err.message : String(err)))
        return
      case 'interrupt':
        mgr.interrupt()
        return
      case 'steer':
        if (typeof msg.text !== 'string') { sendError('steer: "text" must be a string'); return }
        // The client sends 'steer' whenever IT believes a turn is running. If the server is already
        // idle (the steer raced past turn-end), there's no turn to fold into — queuing it would let
        // it bleed into a later, unrelated turn. Deliver it as a normal turn instead, echoed so the
        // client's transient "queued" preview resolves into a real message.
        if (mgr.isBusy()) mgr.steer(msg.text, msg.images, msg.pastedTexts, msg.files, { messageId: msg.messageId })
        else mgr.submit(msg.text, msg.images, msg.pastedTexts, msg.files, { echo: true, messageId: msg.messageId }).catch((err) => sendError(err instanceof Error ? err.message : String(err)))
        return
      case 'permission-reply': {
        if (typeof msg.id !== 'string') { sendError('permission-reply: "id" must be a string'); return }
        const VALID_VERDICTS = ['allow', 'deny', 'allow_session', 'allow_persist']
        if (!VALID_VERDICTS.includes(msg.verdict as string)) {
          sendError('permission-reply: invalid "verdict"')
          return
        }
        mgr.resolvePermission(msg.id, msg.verdict)
        return
      }
      case 'switch-model':
        if (typeof msg.providerId !== 'string' || typeof msg.model !== 'string') {
          sendError('switch-model: "providerId" and "model" must be strings')
          return
        }
        mgr.switchModel(msg.providerId, msg.model)
        return
      case 'reset-session':
        mgr.reset()
        return
      case 'revert':
        if (typeof msg.checkpointId !== 'string') { sendError('revert: "checkpointId" must be a string'); return }
        mgr.revert(msg.checkpointId).catch((err) => sendError(err instanceof Error ? err.message : String(err)))
        return
      case 'retry':
        mgr.retry().catch((err) => sendError(err instanceof Error ? err.message : String(err)))
        return
      case 'compact':
        mgr.compactNow().catch((err) => sendError(err instanceof Error ? err.message : String(err)))
        return
      default:
        sendError(`unknown message type: ${(msg as { type: string }).type}`)
    }
  } catch (err) {
    sendError(err instanceof Error ? err.message : String(err))
  }
}
