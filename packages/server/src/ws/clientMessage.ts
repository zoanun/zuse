import type { SessionManager } from '../session/SessionManager.js'
import { deliverToSession } from '../session/deliver.js'
import type { ClientMessage } from '@zuse/protocol'
import { normalizePermissionMode } from '@zuse/core'

/** 上行分派器驱动的 SessionManager 子集（便于单测注入 spy）。 */
export type SessionManagerLike = Pick<
  SessionManager,
  'submit' | 'interrupt' | 'steer' | 'resolvePermission' | 'switchModel' | 'reset' | 'revert' | 'retry' | 'compactNow' | 'isBusy' | 'setPermissionMode'
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
        // 刻意不走 deliverToSession(与下面的 'steer' 相反):'send' 意味着客户端认为会话空闲，
        // 此时若真在跑，报错才是本文件顶部写明的契约；用 deliverToSession 会把它静默折进当前回合。
        mgr.submit(msg.text, msg.images, msg.pastedTexts, msg.files, { messageId: msg.messageId }).catch((err) => sendError(err instanceof Error ? err.message : String(err)))
        return
      case 'interrupt':
        mgr.interrupt()
        return
      case 'steer':
        if (typeof msg.text !== 'string') { sendError('steer: "text" must be a string'); return }
        // The client sends 'steer' whenever IT believes a turn is running. If the server is already
        // idle (the steer raced past turn-end), there's no turn to fold into — deliverToSession
        // routes it as a normal echoed turn instead, so the transient "queued" preview resolves.
        deliverToSession(mgr, msg.text, {
          messageId: msg.messageId, images: msg.images, pastedTexts: msg.pastedTexts, files: msg.files,
          onError: sendError,
        })
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
      case 'set-permission-mode': {
        // 校验+归一化边界之一，先例见上面的 VALID_VERDICTS。理由是实证的、不是防御性编程：
        // 用户全局配置 ~/.zuse/settings.jsonc 里长期写着一个当时**非法**的 defaultMode，
        // 而配置读取链全程无校验，它静默落到了 'default' 分支 —— 也就是说野生非法值真实
        // 存在于这个系统里。不校验的话，一个坏 mode 帧会把 defaultMode 写成一个 decide()
        // 认不出的字符串，结果是「界面显示全自主、实际按询问档跑」——最坏的那种分叉。
        //
        // 用 normalizePermissionMode 而不是本地白名单数组：老版本网页（缓存的 bundle、
        // 没刷新的标签页）发上来的仍是老名字 `bypassPermissions`，白名单里漏掉它就等于
        // 让这些客户端的档位开关点了没反应。归一化后再往下传，SessionManager 及以下
        // 只见得到正名。
        const mode = normalizePermissionMode(msg.mode)
        if (!mode) {
          sendError('set-permission-mode: invalid "mode"')
          return
        }
        mgr.setPermissionMode(mode)
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
