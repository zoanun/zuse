import { describe, it, expect, afterEach } from 'vitest'
import { useState } from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { Rail } from './Rail.js'
import { __resetActivePreview, type ActiveRun } from './activePreview.js'
import type { TurnSteps } from '../components/turnSteps.js'

afterEach(() => { __resetActivePreview(); cleanup() })

const run: ActiveRun = { id: 'r1', sessionId: 's1', kind: 'tsx', code: 'export default () => null' }

const steps = (n: number): TurnSteps[] =>
  Array.from({ length: n }, (_, i) => ({
    turnId: 'u' + i, index: i + 1, label: 'q' + i,
    parts: [{ msgId: 'a' + i, part: { kind: 'tool-use' as const, id: 't' + i, name: 'Bash', input: {} } }],
  }))

/**
 * 这个文件回答一个具体问题：**把 `StepsDrawer` 放在 `RailRun` 之前 / 做成条件槽位，
 * 会不会让 `PreviewFrame` 重挂？**
 *
 * 判据是 iframe 的 **DOM 节点同一性**：重挂 = 新节点 = 新 document = 预览里的 demo 归零。
 *
 * 敏感性（变异验证）：给 `RailRun` 加一个会变的 `key` 时，下面三条**全部变红**
 * （实测 `Tests 3 failed (3)`）。所以它们绿不是因为测不出来。
 */
describe('Rail 的固定槽位：StepsDrawer 出现/消失不该重挂 PreviewFrame', () => {
  it('steps 从空变成非空 —— iframe 必须是同一个 DOM 节点', () => {
    const { container, rerender } = render(
      <Rail run={run} todos={[]} messages={[]} backgroundAgents={[]} steps={[]} selectedTurn={null} onSelectTurn={() => {}} />,
    )
    const before = container.querySelector('iframe')
    expect(before).not.toBeNull()
    expect(container.querySelector('.steps')).toBeNull()

    rerender(
      <Rail run={run} todos={[]} messages={[]} backgroundAgents={[]} steps={steps(3)} selectedTurn={null} onSelectTurn={() => {}} />,
    )
    expect(container.querySelector('.steps')).not.toBeNull()
    expect(container.querySelector('iframe')).toBe(before)
  })

  it('steps 从非空变回空 —— iframe 仍是同一个 DOM 节点', () => {
    const { container, rerender } = render(
      <Rail run={run} todos={[]} messages={[]} backgroundAgents={[]} steps={steps(3)} selectedTurn={null} onSelectTurn={() => {}} />,
    )
    const before = container.querySelector('iframe')
    rerender(
      <Rail run={run} todos={[]} messages={[]} backgroundAgents={[]} steps={[]} selectedTurn={null} onSelectTurn={() => {}} />,
    )
    expect(container.querySelector('iframe')).toBe(before)
  })
})

/**
 * **JSX 的静态子节点列表按「槽位」对齐，不是按「非 null 的孩子」对齐。**
 *
 * Rail.tsx 里那条注释说：把条件槽位放在 `RailRun` 前面，会让 `RailRun` 的下标
 * 「在 2/3 之间跳变」→ 重挂。下面两条用同一形状的最小复现证明**这个机制不存在**：
 * `{cond ? <X/> : null}` 无论 cond 真假都占住它那一格，`null` 也占一格，
 * 后面兄弟的下标是**常数**。
 *
 * 结论不是"所以可以随便挪"——现有写法（无条件 StepsDrawer 排在 RailRun 之后）
 * 依然是最稳妥的、也符合用户定的上下顺序；只是那条注释给出的**理由**是错的。
 * 真正会重挂的是别的写法：`{[...].filter(Boolean)}`（数组长度真的会变）、
 * 按宽度分叉出第二棵子树、或给 `RailRun` 加会变的 `key` —— 后者已在上面变异验证过。
 */
describe('JSX 静态槽位：条件孩子在前也不会挪动后面兄弟的下标', () => {
  // 条件槽位在**前**（正是 Rail.tsx 注释说会出事的那种写法）
  function CondFirst() {
    const [n, setN] = useState(0)
    return (
      <div>
        <button type="button" onClick={() => setN((v) => v + 1)}>go</button>
        {n > 0 ? <span data-testid="cond" /> : null}
        <iframe data-testid="stable" title="t" />
      </div>
    )
  }
  // 条件槽位在**后**（现有 Rail 的写法）
  function CondLast() {
    const [n, setN] = useState(0)
    return (
      <div>
        <button type="button" onClick={() => setN((v) => v + 1)}>go</button>
        <iframe data-testid="stable" title="t" />
        {n > 0 ? <span data-testid="cond" /> : null}
      </div>
    )
  }

  for (const [name, C] of [['条件槽位在前', CondFirst], ['条件槽位在后', CondLast]] as const) {
    it(`${name}：条件孩子 null→有 之后，稳定兄弟仍是同一个 DOM 节点`, () => {
      const { container, getByText } = render(<C />)
      const before = container.querySelector('[data-testid=stable]')
      expect(before).not.toBeNull()
      expect(container.querySelector('[data-testid=cond]')).toBeNull()
      fireEvent.click(getByText('go'))
      expect(container.querySelector('[data-testid=cond]')).not.toBeNull()
      expect(container.querySelector('[data-testid=stable]')).toBe(before)
    })
  }
})
