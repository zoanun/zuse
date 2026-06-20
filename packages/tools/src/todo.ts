import type { Tool } from '@zuse/core'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  status: TodoStatus
}

export interface TodoWriteDeps {
  onUpdate: (todos: TodoItem[]) => void
}

export function createTodoWriteTool(deps: TodoWriteDeps): Tool {
  return {
    name: 'TodoWrite',
    description:
      'Create and manage a structured task list. Pass the full updated list each time. ' +
      'Use to track progress on multi-step tasks. Mark tasks in_progress before starting, ' +
      'completed when done. Only one task should be in_progress at a time. ' +
      'Write task content in the same language the user uses.',
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Task description' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: 'Task status',
              },
            },
            required: ['content', 'status'],
          },
          description: 'Full task list (replaces the entire list on each call)',
        },
      },
      required: ['todos'],
    },
    async run(input: unknown) {
      const { todos } = input as { todos?: unknown }

      if (!Array.isArray(todos)) {
        return { output: 'TodoWrite requires a "todos" array.', isError: true }
      }

      const validated: TodoItem[] = []
      for (const item of todos) {
        const { content, status } = (item ?? {}) as { content?: unknown; status?: unknown }
        if (typeof content !== 'string' || content === '') continue
        if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue
        validated.push({ content, status })
      }

      deps.onUpdate(validated)

      const icons: Record<TodoStatus, string> = { completed: '✓', in_progress: '●', pending: '○' }
      const lines = validated.map((t) => `${icons[t.status]} ${t.content}`)
      const counts = {
        completed: validated.filter((t) => t.status === 'completed').length,
        total: validated.length,
      }

      return {
        output: `${lines.join('\n')}\n(${counts.completed}/${counts.total} completed)`,
      }
    },
  }
}
