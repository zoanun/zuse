/**
 * 「精简视图」开关的持久化。
 *
 * 存 localStorage 而不是跟着会话走：它是**这台机器上这个人的观感偏好**，
 * 不是会话的属性 —— 同一个会话在手机上和在大屏上想看的详略程度并不一样。
 *
 * 默认**开**：用户要的就是这个形态（「主画面只显示我输入的内容，和最终返回的内容」）。
 * 但它必须可关 —— 不给逃生口的话，精简出问题时用户只能干等着修。
 */
const KEY = 'zuse-clean-view'

export function getCleanView(): boolean {
  try {
    // 只有显式存过 '0' 才算关。没存过 = 没表过态 = 用默认（开）。
    return localStorage.getItem(KEY) !== '0'
  } catch {
    return true   // 隐私模式等拿不到 localStorage 时，退回默认而不是崩
  }
}

export function setCleanView(on: boolean): void {
  try { localStorage.setItem(KEY, on ? '1' : '0') } catch { /* ignore */ }
}
