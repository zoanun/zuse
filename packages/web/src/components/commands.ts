import type { ClientMessage } from '@zuse/protocol'
import type { ManagePanel } from './ManageDrawer.js'

/** Capabilities a slash command may invoke. Shell builds a concrete ctx and passes it to run(). */
export interface CommandContext {
  send: (msg: ClientMessage) => void
  newSession: () => void
  openPanel: (panel: ManagePanel) => void
  focusHistorySearch: () => void
  showHelp: () => void
  openDirPicker: () => void
}

export interface SlashCommand {
  name: string // e.g. '/compact'
  desc: string // one-line menu description
  run: (ctx: CommandContext) => void
}

// Web slash commands. Two kinds share one shape: server commands call ctx.send(uplink); frontend
// commands drive existing UI (new session / open a manage panel / focus history search / open the
// dir picker). Adding a command = one entry here. Deliberately NOT included: /tools /revert /save —
// they have no clean web target (revert is a per-message icon, save is the share-selection flow).
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/compact', desc: '压缩当前上下文', run: (c) => c.send({ type: 'compact' }) },
  { name: '/clear', desc: '新建会话（清空上下文）', run: (c) => c.newSession() },
  { name: '/help', desc: '列出所有命令', run: (c) => c.showHelp() },
  { name: '/memory', desc: '打开记忆管理', run: (c) => c.openPanel('memory') },
  { name: '/prompts', desc: '打开人设/提示词', run: (c) => c.openPanel('prompts') },
  { name: '/skills', desc: '打开技能管理', run: (c) => c.openPanel('skills') },
  { name: '/mcp', desc: '打开 MCP 管理', run: (c) => c.openPanel('mcp') },
  { name: '/usage', desc: '打开用量面板', run: (c) => c.openPanel('usage') },
  { name: '/files', desc: '打开文件浏览器', run: (c) => c.openPanel('files') },
  { name: '/history', desc: '搜索历史消息', run: (c) => c.focusHistorySearch() },
  { name: '/work', desc: '切换工作目录', run: (c) => c.openDirPicker() },
]

/** Menu candidates for the current input: prefix-match on name (case-insensitive) when input
 * starts with '/'; otherwise no menu. A bare '/' lists everything. */
export function filterCommands(input: string, commands: SlashCommand[]): SlashCommand[] {
  if (!input.startsWith('/')) return []
  const q = input.toLowerCase()
  return commands.filter((c) => c.name.toLowerCase().startsWith(q))
}
