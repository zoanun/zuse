import { useEffect, useRef, useState } from 'react'
import type { Part } from '../state/types.js'
import { ToolCall } from './ToolCall.js'
import type { TurnSteps } from './turnSteps.js'

/**
 * 「中间步骤」区：右栏最下面的一段，装本轮/选中那一轮的工具调用。
 *
 * ## 为什么在 `.rail` 里面，而不是自己一列（这一版推翻了上一版）
 *
 * 上一版把它做成 `.main-body` 的第三列、`.rail` 的兄弟。实测下来三列是**过约束**的：
 * `.chat` 有 `min-width: 560px`、`.rail` 是 `flex: none`，于是所有挤压全由这一列承担 ——
 * 1400 屏开着预览时它只剩 182px 宽，命令输出每行都要横向拖滚动条；同时正文列从 726px
 * 掉到 510px（-30%），而"正文列一格不动"正是 PR1 白纸黑字的承诺。窄屏下更糟：
 * 它和 `.rail` 都绝对定位贴右缘，`.rail` 更宽、z-index 更高，把 tab 条完全盖住 ——
 * 主画面已经把工具收走了，这里再点不到就是彻底够不着（styles.css 里那句
 * 「绝不允许两边都没有」说的就是它）。
 *
 * 所以并回右栏：**右侧只有一栏**，任务在上、步骤在下。
 *
 * ## 放在 `RailRun` 之后
 *
 * 这里曾经写着"插在 `RailRun` 前面会让它的下标漂移 → PreviewFrame 重挂"。
 * **那是想当然，已被最小复现证伪**（`preview/probe.railSlot.test.tsx`）：JSX 静态子节点
 * 按槽位对齐，`{cond ? <X/> : null}` 真假都占一格，条件孩子在前不会挪动后面兄弟的下标。
 * 真实的顺序理由写在 Rail.tsx 上（用户定的上下顺序 + 一条相邻选择器的 CSS），
 * 改顺序前先读那段。
 */
export function StepsDrawer({ turns, selectedId, onSelect, defaultCollapsed = false }: {
  turns: TurnSteps[]
  /** 当前选中的轮次 id；null = 跟随最新。 */
  selectedId: string | null
  onSelect: (turnId: string) => void
  /** 窄行回退位用：默认收成一行，别在本来就矮的窗口里挤掉聊天。 */
  defaultCollapsed?: boolean
}) {
  // 收起后只剩一行标题。这是**宽屏唯一的逃生口**：上一版只有窄屏能收，宽屏想让步骤
  // 别占地方就只能去 Header 关掉整个精简视图（顺带改变主画面的过滤），等于没有逃生口。
  // 开着预览时尤其需要它 —— 预览和步骤在同一栏里抢高度，总得有一个能让位。
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const listRef = useRef<HTMLDivElement>(null)
  const active = turns.find((t) => t.turnId === selectedId) ?? turns[turns.length - 1]

  // 用户主动收起的那一轮。**记 id 而不是记一个布尔**，是为了不打断「自动跟随最新」：
  // 收起第 5 轮之后来了第 6 轮，`active` 变成第 6 轮而 closedId 还停在第 5 轮，
  // 新一轮照常展开。若记布尔，收起过一次就再也不会自动展开了。
  const [closedId, setClosedId] = useState<string | null>(null)
  const openId = active && active.turnId !== closedId ? active.turnId : null

  const toggle = (turnId: string): void => {
    // 点已经展开的那一行 = 收起它。**刻意不调 onSelect** —— 收起是本地的视觉动作，
    // 不该顺手把主画面滚到别处去（点开才滚，是"我要看这一轮"；收起只是"看完了"）。
    if (openId === turnId) { setClosedId(turnId); return }
    setClosedId(null)
    onSelect(turnId)
  }

  // 展开的那一行要在可视区里。默认是"跟随最新"，不滚的话第 6 轮起用户得先手动往下拖
  // 才能看到自己当前在哪一轮 —— 一个默认行为却要手动找，是说不通的。
  //
  // 两个坑，都是实测出来的：
  // 1. **必须 rAF。** 列表的高度来自 flex 分配，首帧 effect 跑的时候右栏刚挂上、
  //    高度还没定下来，容器尚未溢出 → 滚了个寂寞，等布局稳定了也不会自己补一次。
  //    实测首屏选中第 8 轮时 scrollTop 恒为 0，而它在 156px 可视区外的 210px 处。
  // 2. **不用 `scrollIntoView`。** 它会沿途滚动**所有**可滚祖先 —— 这一列外面就是
  //    `.stream`（实测 scrollTop 2655），一次误滚就把用户读到一半的对话拽走了。
  //    下面这段是 `block:'nearest'` 的语义，但只作用在列表自己身上。
  //    滚的目标是**行头**不是整个展开项：一轮调了十几次工具时，把整项塞进视野
  //    会把行头顶出上边缘，反而看不见自己点的是哪一行。
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const id = requestAnimationFrame(() => {
      const on = list.querySelector<HTMLElement>('.turn-tab.on')
      if (!on) return
      const nb = list.getBoundingClientRect()
      const ob = on.getBoundingClientRect()
      if (ob.top < nb.top) list.scrollTop += ob.top - nb.top
      else if (ob.bottom > nb.bottom) list.scrollTop += ob.bottom - nb.bottom
    })
    return () => cancelAnimationFrame(id)
  }, [openId, turns.length])

  if (turns.length === 0) return null

  return (
    <section className={'steps' + (collapsed ? ' collapsed' : '')} aria-label="中间步骤">
      <button
        type="button"
        className="steps-head"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className="sh-caret" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        <span className="sh-title">中间步骤</span>
        <span className="sh-count">{turns.length} 轮</span>
      </button>
      {collapsed ? null : (
        /*
          折叠列表（QQ 好友分组那种）：一行一轮，点哪行就**在原地**展开哪行的内容。
          上一版是「列表在上、内容在下」的两段式，代价是每次都要把视线从行跳到下面那块，
          而且列表和内容各占一半高度、两边都不够用。原地展开只有一处滚动区，
          行与内容永远贴在一起。

          **同时只展开一行**（手风琴）而不是多行随意展开：这一列窄，多行同时展开时
          光是找"我刚点的那行在哪"就得滚半天；而且单开正好对上外面 `selectedTurn`
          那套"跟随最新 / 点了就锁定"的语义，不用再造第二套状态。
        */
        <div className="steps-list" ref={listRef}>
          {turns.map((t) => {
            const open = t.turnId === openId
            return (
              <div key={t.turnId} className={'turn-item' + (open ? ' open' : '')}>
                <button
                  type="button"
                  className={'turn-tab' + (open ? ' on' : '')}
                  aria-expanded={open}
                  title={t.index ? `第 ${t.index} 轮：${t.label}` : `会话开头：${t.label}`}
                  onClick={() => toggle(t.turnId)}
                >
                  <span className="tt-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
                  {/* index 0 = 不属于任何轮次（排在第一条提问之前）。显示「0 轮」会骗人 —— 没有第 0 轮。 */}
                  <span className="tt-n">{t.index || '·'}</span>
                  <span className="tt-label">{t.label}</span>
                  <span className="tt-c">{t.parts.filter((p) => p.part.kind === 'tool-use').length}</span>
                </button>
                {/* 收起的那些**不渲染内容**，不是 display:none 藏起来。几十轮的会话里
                    每轮十几张工具卡片，全挂在 DOM 上白白吃内存、也让列表的滚动计算变重。 */}
                {open ? <div className="turn-panel">{renderParts(t.parts)}</div> : null}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

/**
 * 把一轮的工具调用按原顺序渲染，复用现成的 `ToolCall`（不新写一套）。
 *
 * tool-result 要**并到它对应的 tool-use 上**（`ToolCall` 一次吃一对），否则结果会
 * 变成一张没有头的孤卡。配对按 part 的 id，不按相邻位置 —— 结果不一定紧跟着调用。
 */
function renderParts(parts: { msgId: string; part: Part }[]) {
  const results = new Map<string, Extract<Part, { kind: 'tool-result' }>>()
  for (const { part } of parts) if (part.kind === 'tool-result') results.set(part.id, part)
  return parts.map(({ msgId, part }, i) => {
    if (part.kind !== 'tool-use') return null   // tool-result 已并进对应的 tool-use；正文不在这儿
    return <ToolCall key={`${msgId}:${i}`} use={part} result={results.get(part.id)} />
  })
}
