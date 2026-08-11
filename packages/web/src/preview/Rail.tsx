import { useState } from 'react'
import type { TodoItemLite } from '@zuse/protocol'
import { closeRun, type ActiveRun } from './activePreview.js'
import { PreviewFrame } from './PreviewFrame.js'
import { ConsolePanel } from './ConsolePanel.js'
import type { ConsoleEntry } from './types.js'
import { TodosPanel } from '../components/TodosPanel.js'
import { AgentsPanel } from '../components/AgentsPanel.js'
import { StepsDrawer } from '../components/StepsDrawer.js'
import type { TurnSteps } from '../components/turnSteps.js'
import type { Message } from '../state/types.js'

/**
 * 预览那一段（PR1 的原 Rail 主体）。**单独一个组件是为了它的 `entries` 生命周期**：
 * run 关掉时整段卸载，控制台记录跟着走干净；而右栏本身现在会因为待办继续挂着。
 *
 * 两个不变量，改这里之前先读：
 *
 * 1. **绝不能按视口/容器宽度分叉出第二棵子树**（设计 §4.3 / P0-4）。
 *    `narrow ? <Overlay><PreviewFrame/></Overlay> : <PreviewFrame/>` 会在跨断点那一刻
 *    让 PreviewFrame 换位置 → `token`（`useMemo(...,[])`）重生 → 新 document → demo 归零。
 *    窄屏形态**只由 CSS 的 `@container` 换外观**，DOM 结构一个字不动。
 * 2. **不要给 PreviewFrame 加 `key`**。切换到另一段代码时 `run.id` 会变，加了 key 就等于
 *    每次换 run 都重建 document；不加则走 eval 通道就地替换，控制台与主题都不掉。
 */
function RailRun({ run }: { run: ActiveRun }) {
  // `entries` 提升到这里（设计 §5.2）：ConsolePanel 因此和 PreviewFrame 是兄弟，
  // 右栏可以给 iframe `flex:1`、给控制台一个固定上限高度。
  const [entries, setEntries] = useState<ConsoleEntry[]>([])
  return (
    <>
      <PreviewFrame
        spec={{ kind: run.kind, code: run.code }}
        fitMode="fill"
        setEntries={setEntries}
        onClose={() => closeRun(run.id)}
      />
      <ConsolePanel entries={entries} onClear={() => setEntries([])} />
    </>
  )
}

/**
 * 右侧工作栏（设计 §4 / §8）。
 *
 * 收益的九成在这一条：**预览与待办不再跟着聊天一起滚走**。所以它必须是 `.main-body` 的
 * 直接子节点、`.chat` 的兄弟，而不是消息流里的元素。
 *
 * **四个子节点是固定槽位，不要改成数组/条件拼接**：`TodosPanel`/`AgentsPanel`/`StepsDrawer`
 * 自己返回 null 时槽位仍在，React 按位置对齐，`RailRun` 因此不会因为「上面那块出现了」
 * 而被重挂（重挂 = iframe 换 document = demo 归零）。
 *
 * **注意上面这条的适用边界**（评审用可跑的最小复现纠正过一次，见
 * `probe.railSlot.test.tsx`）：JSX 的**静态**子节点列表按槽位对齐，`{cond ? <X/> : null}`
 * 不论真假都占住它那一格，`null` 也占一格 —— 所以「在 `RailRun` 前面多一个条件孩子」
 * 本身**不会**挪动它的下标，这里曾经写着的"下标从 2 变成 3"是想当然，不成立。
 *
 * 真正会重挂的是这几种写法，它们才是这段注释要拦的：
 *   - `{[a, b, c].filter(Boolean)}` —— 数组长度真的会变，后面的 key/下标跟着变；
 *   - 按视口/容器宽度分叉出**第二棵子树**（设计 §4.3 / P0-4）；
 *   - 给 `RailRun` 或 `PreviewFrame` 加一个会变的 `key`（这条已做过变异验证：
 *     加上去之后 railSlot 那三条测试全红）。
 *
 * `StepsDrawer` 仍然**无条件渲染、排在 `RailRun` 之后**，但理由是别的两条：
 * ① 用户定的上下顺序是「任务在上、步骤在下」；
 * ② styles.css 里 `.rail > .preview-console + .steps` 这条相邻选择器依赖这个顺序画分隔线。
 * 顺序真要改，先把那条 CSS 一起改，并重新在浏览器里量一遍高度分配。
 *
 * 「让任务一直挂到全部完成再消失」也是用户拍的板 —— 而它本来就是这个行为
 * （`hasVisibleTodos` = 有任何一条没完成就显示），不需要改。
 */
export function Rail({ run, todos, messages, backgroundAgents, steps, selectedTurn, onSelectTurn }: {
  run: ActiveRun | null
  todos: TodoItemLite[]
  messages: Message[]
  backgroundAgents: string[]
  steps: TurnSteps[]
  selectedTurn: string | null
  onSelectTurn: (turnId: string) => void
}) {
  return (
    <aside className="rail" aria-label="工作栏">
      <TodosPanel todos={todos} />
      <AgentsPanel messages={messages} backgroundAgents={backgroundAgents} />
      {run ? <RailRun run={run} /> : null}
      {/* 无条件渲染（turns 为空时它自己 `return null`），排在 `RailRun` 之后。
          理由见上面的注释 —— **不是**因为下标会跳变（那条已被最小复现证伪），
          而是用户定的上下顺序 + `.preview-console + .steps` 那条 CSS 依赖这个顺序。 */}
      <StepsDrawer turns={steps} selectedId={selectedTurn} onSelect={onSelectTurn} />
    </aside>
  )
}
