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

/**
 * 分组渲染（设计 §2.1）。
 *
 * 最重要的一条在最前：**全部无 group 时 DOM 必须与加这个功能之前一样**。
 * 断言写成「`.todos` 的子节点序列恰好是 [.th, .ti × N]」而不是「渲染结果一致」——
 * 后者无论实现对错都绿。这条同时钉死了「分组不得引入包裹元素」（用 Fragment）。
 */
describe('TodosPanel 分组', () => {
  const childTags = (c: HTMLElement) =>
    [...(c.querySelector('.todos')?.children ?? [])].map((e) => e.className)

  it('全部无 group → 子节点恰好是 [th, ti×N]，不多出任何元素', () => {
    const { container } = render(<TodosPanel todos={[
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'pending' },
    ]} />)
    expect(childTags(container)).toEqual(['th', 'ti done', 'ti todo'])
  })

  it('有 group → 每组一行组标题，顺序按首次出现（不是字典序）', () => {
    const { container } = render(<TodosPanel todos={[
      { content: 'z1', status: 'pending', group: '乙' },
      { content: 'a1', status: 'pending', group: '甲' },
      { content: 'z2', status: 'completed', group: '乙' },
    ]} />)
    // 乙 先出现 → 乙 在前；同名不连续（乙、甲、乙）必须归拢成一段。
    expect(childTags(container)).toEqual([
      'th', 'gh', 'ti todo', 'ti done', 'gh', 'ti todo',
    ])
    const heads = [...container.querySelectorAll('.gh')].map((e) => e.textContent)
    expect(heads[0]).toContain('乙')
    expect(heads[0]).toContain('1 / 2')   // 该组小计
    expect(heads[1]).toContain('甲')
    expect(heads[1]).toContain('0 / 1')
  })

  it('混合 → 未分组的在最前且不带组标题', () => {
    const { container } = render(<TodosPanel todos={[
      { content: 'g', status: 'pending', group: '甲' },
      { content: 'plain', status: 'pending' },
    ]} />)
    expect(childTags(container)).toEqual(['th', 'ti todo', 'gh', 'ti todo'])
  })

  it('某组全完成、别组没完 → 该组仍然显示（刻意不做「做完就隐藏」）', () => {
    // 设计 §2.2 明确不做这条。防后人「顺手优化」掉 —— 分组中途消失比多占几行更让人困惑。
    const { container } = render(<TodosPanel todos={[
      { content: 'a', status: 'completed', group: '甲' },
      { content: 'b', status: 'pending', group: '乙' },
    ]} />)
    const heads = [...container.querySelectorAll('.gh')].map((e) => e.textContent)
    expect(heads.some((h) => h?.includes('甲'))).toBe(true)
  })
})
