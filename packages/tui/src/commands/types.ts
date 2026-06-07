import type { Conversation, ResolvedSettings, ModelSelection, ToolRegistry } from '@zuse/core'

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
  /** 本会话实际生效的三层合并设置（供 /config 等只读展示用）。 */
  settings: ResolvedSettings
  /** 当前选中的 model 名（用于 /model 列表标星）。 */
  currentModel: string
  /** 当前选中的 provider id —— 与 currentModel 配对，避免重名模型在不同 provider 下被同时标星。 */
  currentProviderId: string
  /** 切换 model；persist=true 时写盘。返回给用户看的提示串。 */
  switchModel: (sel: ModelSelection, persist: boolean) => string
  /** 打开 /model 交互式选择器（无参 /model 调用）。呈现层在 App 里渲染。 */
  openModelSelector: () => void
  /** 工具登记表（供 /tools 列出暴露给模型的工具，按 settings.tools 过滤后）。 */
  registry: ToolRegistry
  /** 把历史视口滚到最早处（供 /history）。滚动 state 由 App 持有，命令经此回调触发。 */
  showHistory: () => void
}

export interface SlashCommand {
  /** 以 `/<name>` 调用。这里不带前导斜杠。 */
  name: string
  description: string
  run: (ctx: CommandContext) => void | Promise<void>
}
