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
 * ## 放在 `RailRun` **之后**是必须的
 *
 * `Rail` 的子节点是固定槽位（见 Rail.tsx 的注释）。React 按位置对齐，插在 `RailRun`
 * 前面会让它的下标漂移 → PreviewFrame 重挂 → iframe 换 document → 预览里的 demo 归零。
 * 追加到最后不改变任何既有槽位的下标，是安全的。
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
  const bodyRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<HTMLElement>(null)
  const active = turns.find((t) => t.turnId === selectedId) ?? turns[turns.length - 1]

  // 换一轮就把步骤区滚回顶部 —— 否则读第 5 轮时停在半腰，点到第 2 轮还停在那个位置。
  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = 0 }, [active?.turnId])

  // 轮次列表限了高，选中项可能在可视区外。默认是"跟随最新"，不滚的话第 6 轮起用户
  // 得先手动往下拖才能看到自己当前在哪一轮 —— 一个默认行为却要手动找，是说不通的。
  //
  // 两个坑，都是实测出来的：
  // 1. **必须 rAF。** `.turn-tabs` 的限高是 `max-height: 30%`（相对 `.steps` 的高度），
  //    首帧 effect 跑的时候右栏刚挂上、高度还没定下来，nav 尚未溢出 → 滚了个寂寞，
  //    等布局稳定了也不会自己补一次。实测首屏选中第 8 轮时 scrollTop 恒为 0，
  //    而它在 156px 可视区外的 210px 处。
  // 2. **不用 `scrollIntoView`。** 它会沿途滚动**所有**可滚祖先 —— 这一列外面就是
  //    `.stream`（实测 scrollTop 2655），一次误滚就把用户读到一半的对话拽走了。
  //    下面这段是 `block:'nearest'` 的语义，但只作用在 nav 自己身上。
  useEffect(() => {
    const nav = tabsRef.current
    if (!nav) return
    const id = requestAnimationFrame(() => {
      const on = nav.querySelector<HTMLElement>('.turn-tab.on')
      if (!on) return
      const nb = nav.getBoundingClientRect()
      const ob = on.getBoundingClientRect()
      if (ob.top < nb.top) nav.scrollTop += ob.top - nb.top
      else if (ob.bottom > nb.bottom) nav.scrollTop += ob.bottom - nb.bottom
    })
    return () => cancelAnimationFrame(id)
  }, [active?.turnId, turns.length])

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
        <>
          {/* 轮次列表：一行一轮、**横排文字**。上一版是 40px 宽的竖排字条，实测每格 120px 高，
              7 轮就已经在滚了；横排每行约 30px，同样高度能放 26 行 —— 密度差 4 倍，
              而且竖排的 12 字标签在连续追问下根本认不出是哪一轮。 */}
          <nav className="turn-tabs" aria-label="按轮次查看中间步骤" ref={tabsRef}>
            {turns.map((t) => (
              <button
                key={t.turnId}
                type="button"
                className={'turn-tab' + (t.turnId === active?.turnId ? ' on' : '')}
                aria-current={t.turnId === active?.turnId}
                title={`第 ${t.index} 轮：${t.label}`}
                onClick={() => onSelect(t.turnId)}
              >
                <span className="tt-n">{t.index}</span>
                <span className="tt-label">{t.label}</span>
                <span className="tt-c">{t.parts.filter((p) => p.part.kind === 'tool-use').length}</span>
              </button>
            ))}
          </nav>
          <div className="steps-body" ref={bodyRef}>
            {active ? renderParts(active.parts) : null}
          </div>
        </>
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
