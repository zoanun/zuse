import type { Conversation } from '@zuse/core'

/**
 * 斜杠命令运行时被交予的东西。真正的 state 由 hook 持有；命令只通过这些
 * 能力来行动，因此与 React 解耦。
 */
export interface CommandContext {
  /** 命令名之后的全部内容，已 trim。例如 "/save foo" → "foo"。 */
  args: string
  /** 向对话记录发出一条本地通知（渲染成一行暗色的 system 行）。 */
  print: (text: string) => void
  /** 清空会话（历史 + 用量）和 UI。 */
  clear: () => void
  /** 实时的已提交历史 —— 读取它（例如为 /save 序列化）。 */
  conversation: Conversation
  /** 替换实时会话并据此重建 UI（用于 /load）。 */
  load: (conversation: Conversation) => void
}

export interface SlashCommand {
  /** 以 `/<name>` 调用。这里不带前导斜杠。 */
  name: string
  description: string
  run: (ctx: CommandContext) => void | Promise<void>
}
