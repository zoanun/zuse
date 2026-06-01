import type { Conversation } from '@zuse/core'

/**
 * What a slash command is handed when it runs. The hook owns the actual state;
 * commands only act through these capabilities, so they stay decoupled from React.
 */
export interface CommandContext {
  /** Everything after the command name, trimmed. e.g. "/save foo" → "foo". */
  args: string
  /** Emit a local notice into the transcript (rendered as a dim system line). */
  print: (text: string) => void
  /** Wipe the conversation (history + usage) and the UI. */
  clear: () => void
  /** The live committed history — read it (e.g. to serialize for /save). */
  conversation: Conversation
  /** Replace the live conversation and rebuild the UI from it (for /load). */
  load: (conversation: Conversation) => void
}

export interface SlashCommand {
  /** Invoked as `/<name>`. No leading slash here. */
  name: string
  description: string
  run: (ctx: CommandContext) => void | Promise<void>
}
