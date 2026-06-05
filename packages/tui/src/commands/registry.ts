import type { SlashCommand } from './types.js'
import { saveConversation, loadConversation } from './sessionStore.js'

/** 解析后的斜杠输入。null 表示"不是命令 —— 当作一条聊天消息处理"。 */
interface ParsedCommand {
  name: string
  args: string
}

const help: SlashCommand = {
  name: 'help',
  description: 'List available commands',
  run: ({ print }) => {
    const lines = COMMANDS.map((c) => `  /${c.name.padEnd(6)} ${c.description}`)
    print(['Available commands:', ...lines].join('\n'))
  },
}

/** apiKey 打码：仅留首 6 + 末 4，足以辨认是哪把 key 又不泄露全文。 */
function maskKey(key: string | undefined): string {
  if (!key) return '(未设置)'
  if (key.length <= 12) return '*** (已设置)'
  return `${key.slice(0, 6)}…${key.slice(-4)} (已设置)`
}

const config: SlashCommand = {
  name: 'config',
  description: 'Show the effective settings (merged from all layers)',
  run: ({ settings, print }) => {
    const p = settings.permissions
    const t = settings.tools
    const fmt = (arr: string[]): string => (arr.length ? arr.join(', ') : '(空)')
    const tools =
      t.enabled || t.disabled
        ? `enabled=${t.enabled?.join(', ') ?? '全部'}; disabled=${t.disabled?.join(', ') ?? '无'}`
        : '(全部启用)'
    print(
      [
        '当前生效配置（三层合并后）:',
        `  model:       ${settings.model ?? '(默认)'}`,
        `  maxTokens:   ${settings.maxTokens ?? '(默认)'}`,
        `  baseURL:     ${settings.baseURL ?? '(默认)'}`,
        `  apiKey:      ${maskKey(settings.apiKey)}`,
        `  defaultMode: ${p.defaultMode}`,
        `  allow:       ${fmt(p.allow)}`,
        `  ask:         ${fmt(p.ask)}`,
        `  deny:        ${fmt(p.deny)}`,
        `  tools:       ${tools}`,
      ].join('\n'),
    )
  },
}

const clear: SlashCommand = {
  name: 'clear',
  description: 'Clear the conversation history',
  run: ({ clear, print }) => {
    clear()
    print('Conversation cleared.')
  },
}

const save: SlashCommand = {
  name: 'save',
  description: 'Save the conversation: /save <name>',
  run: async ({ args, conversation, print }) => {
    if (!args) {
      print('Usage: /save <name>')
      return
    }
    const path = await saveConversation(args, conversation)
    print(`Saved to ${path}`)
  },
}

const load: SlashCommand = {
  name: 'load',
  description: 'Load a saved conversation: /load <name>',
  run: async ({ args, load: replaceConversation, print }) => {
    if (!args) {
      print('Usage: /load <name>')
      return
    }
    const conv = await loadConversation(args)
    replaceConversation(conv)
    print(`Loaded "${args}" (${conv.length} messages).`)
  },
}

/** 命令表。新增一个命令 = 在这里加一条（数据驱动）。 */
const COMMANDS: SlashCommand[] = [help, config, clear, save, load]

/** 把原始输入拆成命令名 + 参数；若不是斜杠命令则返回 null。 */
export function parseInput(input: string): ParsedCommand | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const space = trimmed.indexOf(' ')
  if (space === -1) return { name: trimmed.slice(1), args: '' }
  return { name: trimmed.slice(1, space), args: trimmed.slice(space + 1).trim() }
}

export function findCommand(name: string): SlashCommand | undefined {
  return COMMANDS.find((c) => c.name === name)
}
