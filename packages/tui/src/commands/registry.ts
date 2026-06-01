import type { SlashCommand } from './types.js'

/** Parsed slash input. null means "not a command — treat as a chat message". */
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

/** The command table. Adding a command = one entry here (data-driven). */
export const COMMANDS: SlashCommand[] = [help, clear]

/** Split raw input into command name + args, or null if it isn't a slash command. */
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
