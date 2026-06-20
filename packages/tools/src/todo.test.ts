import { describe, it, expect } from 'vitest'
import { createTodoWriteTool, type TodoItem } from './todo.js'

const dummyCtx = { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } }

describe('TodoWriteTool', () => {
  it('calls onUpdate with validated todos', async () => {
    let received: TodoItem[] = []
    const tool = createTodoWriteTool({ onUpdate: (t) => { received = t } })

    await tool.run({
      todos: [
        { content: 'task 1', status: 'completed' },
        { content: 'task 2', status: 'in_progress' },
        { content: 'task 3', status: 'pending' },
      ],
    }, dummyCtx)

    expect(received).toEqual([
      { content: 'task 1', status: 'completed' },
      { content: 'task 2', status: 'in_progress' },
      { content: 'task 3', status: 'pending' },
    ])
  })

  it('returns summary counts', async () => {
    const tool = createTodoWriteTool({ onUpdate: () => {} })
    const result = await tool.run({
      todos: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'completed' },
        { content: 'c', status: 'pending' },
      ],
    }, dummyCtx)

    expect(result.output).toContain('2/3 completed')
    expect(result.output).toContain('✓ a')
    expect(result.output).toContain('○ c')
  })

  it('filters invalid items silently', async () => {
    let received: TodoItem[] = []
    const tool = createTodoWriteTool({ onUpdate: (t) => { received = t } })

    await tool.run({
      todos: [
        { content: 'valid', status: 'pending' },
        { content: '', status: 'pending' },
        { content: 'bad status', status: 'unknown' },
        { status: 'pending' },
        null,
        { content: 'also valid', status: 'completed' },
      ],
    }, dummyCtx)

    expect(received).toEqual([
      { content: 'valid', status: 'pending' },
      { content: 'also valid', status: 'completed' },
    ])
  })

  it('returns error for non-array todos', async () => {
    const tool = createTodoWriteTool({ onUpdate: () => {} })
    const result = await tool.run({ todos: 'not array' }, dummyCtx)
    expect(result.isError).toBe(true)
  })

  it('handles empty array', async () => {
    let received: TodoItem[] | null = null
    const tool = createTodoWriteTool({ onUpdate: (t) => { received = t } })
    const result = await tool.run({ todos: [] }, dummyCtx)

    expect(received).toEqual([])
    expect(result.output).toContain('0 completed')
  })
})
