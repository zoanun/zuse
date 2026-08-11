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

/**
 * 分组（§2.4b / §6.2）。
 *
 * 这些测试**刻意落在工具层**，不落在面板层：TodoWrite 是「整份覆盖」语义，模型每一轮都从
 * **回给它的那串文本**重建整张表。回显里若没有分组，模型手上最新最显眼的记录就是平表，
 * 下一次调用极可能退回去 —— 整个功能白做。面板层的同类测试是空跑（测试自己造带 group 的
 * 数组、再断言渲染出这些 group，无论实现对错都绿）。
 */
describe('TodoWrite 的分组', () => {
  const run = async (todos: unknown[]) => {
    let received: TodoItem[] = []
    const tool = createTodoWriteTool({ onUpdate: (t) => { received = t } })
    const result = await tool.run({ todos }, dummyCtx)
    return { received, output: (result as { output: string }).output }
  }

  it('全部无 group 时，回显一字不变（今天的格式）', async () => {
    const { output } = await run([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'pending' },
    ])
    expect(output).toBe('✓ a\n○ b\n(1/2 completed)')
  })

  it('全部有 group 时，按首次出现顺序分段（不是字典序）', async () => {
    // **组名必须让两种排序给出不同结果**，否则这条测试是弱的：初版用了「甲、乙」，
    // 而它们按拼音排序恰好也是甲在前 —— 把实现改成字典序，这条照样绿（变异验证抓到的）。
    // 现在用 zebra/apple：首次出现 = zebra 在前，字典序 = apple 在前，两者必然分道扬镳。
    const { output } = await run([
      { content: 'z1', status: 'completed', group: 'zebra' },
      { content: 'a1', status: 'pending', group: 'apple' },
      { content: 'z2', status: 'in_progress', group: 'zebra' },
    ])
    // 同名分组不连续（zebra、apple、zebra）也必须归拢成一段。
    expect(output).toBe('[zebra]\n✓ z1\n● z2\n[apple]\n○ a1\n(1/3 completed)')
  })

  it('混合：未分组的在前且不带标题，其后才是各 [组名] 段', async () => {
    // §2.4b 第三档。没定义这一档时，实现者最容易把未分组那截吞掉或错位。
    const { output } = await run([
      { content: 'g1', status: 'pending', group: '甲' },
      { content: 'plain', status: 'pending' },
    ])
    expect(output).toBe('○ plain\n[甲]\n○ g1\n(0/2 completed)')
  })

  it('group 先 trim 再判空：纯空白视为未填', async () => {
    const { received, output } = await run([
      { content: 'a', status: 'pending', group: '   ' },
      { content: 'b', status: 'pending', group: ' 甲 ' },
    ])
    expect(received[0]!.group).toBeUndefined()
    expect(received[1]!.group).toBe('甲')   // trim 后保留
    expect(output).toBe('○ a\n[甲]\n○ b\n(0/2 completed)')
  })

  it('非字符串 group 落入隐式桶，不炸', async () => {
    const { received } = await run([{ content: 'a', status: 'pending', group: 123 }])
    expect(received).toEqual([{ content: 'a', status: 'pending' }])
  })

  it('组名超 60 字截断', async () => {
    const long = '组'.repeat(80)
    const { received } = await run([{ content: 'a', status: 'pending', group: long }])
    expect(received[0]!.group).toHaveLength(60)
  })

  it('收尾那行 (n/m completed) 必须留在最末 —— 挪走它，最后一个 [组名] 会被 TUI 静默剥掉', async () => {
    // toolSummary.ts 的 TRAILING_NOTE_RE 会剥掉输出末尾的方括号注记。
    const { output } = await run([{ content: 'a', status: 'pending', group: '甲' }])
    expect(output.split('\n').at(-1)).toBe('(0/1 completed)')
  })
})
