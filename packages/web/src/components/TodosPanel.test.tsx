import { describe, it, expect } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { TodoItemLite } from '@zuse/protocol'
import { TodosPanel, hasVisibleTodos } from './TodosPanel.js'

describe('TodosPanel', () => {
  it('renders three states with a done count', () => {
    render(<TodosPanel todos={[
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ]} />)
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
    expect(screen.getByText('a')).toBeInTheDocument()
    expect(screen.getByText('b')).toBeInTheDocument()
  })
  it('renders nothing when empty', () => {
    const { container } = render(<TodosPanel todos={[]} />)
    expect(container.firstChild).toBeNull()
  })
  it('renders nothing once every task is completed', () => {
    const { container } = render(<TodosPanel todos={[
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
    ]} />)
    expect(container.firstChild).toBeNull()
  })
})

/**
 * 谓词与组件必须**永远同答案**（设计 §8）。
 *
 * 右栏的显示条件调用 `hasVisibleTodos`，面板自己 return null 也调它。这条测试是这份
 * 「同一个真相」的锁：只要有人为了图快在某一侧写死一个判据（比如把组件里改回
 * `if (!todos.length) return null`，丢掉「全完成也消失」那条），右栏就会留下一个空壳，
 * 而这里立刻变红。
 */
describe('hasVisibleTodos —— 谓词与组件渲染结果一致', () => {
  const t = (status: TodoItemLite['status']): TodoItemLite => ({ content: 'x-' + status, status })
  const cases: Array<{ name: string; todos: TodoItemLite[] }> = [
    { name: '空表', todos: [] },
    { name: '全部 completed', todos: [t('completed'), t('completed')] },
    { name: '只有一条 completed', todos: [t('completed')] },
    { name: '有 pending', todos: [t('completed'), t('pending')] },
    { name: '有 in_progress', todos: [t('in_progress')] },
    { name: '混合', todos: [t('completed'), t('in_progress'), t('pending')] },
  ]
  for (const c of cases) {
    it(c.name, () => {
      const predicate = hasVisibleTodos(c.todos)
      const { container } = render(<TodosPanel todos={c.todos} />)
      const rendered = container.querySelector('.todos') !== null
      expect(rendered).toBe(predicate)
      // 反向也钉住：谓词说可见就必须真有内容，否则「一致」可以靠两边都返回 false 空跑达成。
      if (predicate) expect(container.querySelectorAll('.ti').length).toBe(c.todos.length)
      cleanup()
    })
  }
})
