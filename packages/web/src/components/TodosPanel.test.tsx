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
  /**
   * 真实事故回归锁：面板里某一行明明是「未开始」，勾却是打上的。
   *
   * 两处叠加造成：`taskMarker` 用 `defaultChecked`（**非受控**，只在挂载那一次生效），
   * 而本组件用下标当 key —— 状态变了 React 认为还是同一个 `<input>` 就复用它，
   * 于是那个勾再也摘不掉。用户看到的是「已完成」，真值是 pending，且**无法自愈**
   * （除非行数变化触发重建）。这类 bug 单次 render 的测试一条都抓不到，
   * 必须**重渲染同一棵树**才会暴露 —— 这正是它此前漏网的原因。
   */
  it('同一行的状态改了，勾必须跟着变（非受控 checkbox 的回归锁）', () => {
    const { rerender, container } = render(<TodosPanel todos={[
      { content: '第一行', status: 'completed' },
      { content: '第二行', status: 'pending' },
    ]} />)
    expect(container.querySelectorAll('input[type=checkbox]')[0]).toBeChecked()

    // **文案必须一字不改**，只翻状态 —— 这才是事故形态（TodoWrite 改的是 status，
    // 内容不动），也只有这样 React 才会复用同一个 input 节点、把非受控的勾暴露出来。
    // 早先这里顺手换了文案，配上当时 key 里带 content 的写法，节点被卸载重挂，
    // `defaultChecked` 在新节点上自然正确 —— 这条测试于是变成空跑，什么都没验到。
    rerender(<TodosPanel todos={[
      { content: '第一行', status: 'pending' },
      { content: '第二行', status: 'pending' },
    ]} />)
    const boxes = container.querySelectorAll('input[type=checkbox]')
    expect(boxes[0]).not.toBeChecked()
    expect(boxes[1]).not.toBeChecked()
  })

  it('反向也钉住：pending 改成 completed 时勾要出现', () => {
    const { rerender, container } = render(<TodosPanel todos={[
      { content: 'x', status: 'pending' },
      { content: 'y', status: 'pending' },
    ]} />)
    rerender(<TodosPanel todos={[
      { content: 'x', status: 'completed' },
      { content: 'y', status: 'pending' },
    ]} />)
    const boxes = container.querySelectorAll('input[type=checkbox]')
    expect(boxes[0]).toBeChecked()
    expect(boxes[1]).not.toBeChecked()
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
