import type { SlashCommand } from './types.js'
import { saveConversation, loadConversation } from './sessionStore.js'

/** 解析后的斜杠输入。null 表示"不是命令 —— 当作一条聊天消息处理"。 */
export interface ParsedCommand {
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
export const COMMANDS: SlashCommand[] = [help, clear, save, load]

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
