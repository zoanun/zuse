import { useEffect, useRef, useState } from 'react'
import type { Part } from '../state/types.js'
import { ToolCall } from './ToolCall.js'
import { Markdown } from './Markdown.js'
import type { TurnSteps } from './turnSteps.js'

/**
 * 右侧的「中间步骤」抽屉：一条竖向 tab 贴最右边、通高，左边是选中那一轮的步骤。
 *
 * **整块在 `.rail` 外面，与它平级。** 不能塞进 `.rail` 当子节点 —— 那里的三个槽位是
 * 固定的（见 Rail.tsx 的注释），多一个条件子节点会让 `RailRun` 位置漂移、
 * PreviewFrame 重挂、预览里的 demo 归零。也因此 `hasRail` 一个字不用改：
 * 这一列自己决定何时出现。
 */
export function StepsDrawer({ turns, selectedId, onSelect }: {
  turns: TurnSteps[]
  /** 当前选中的轮次 id；null = 跟随最新。 */
  selectedId: string | null
  onSelect: (turnId: string) => void
}) {
  // 窄屏下这一列变成覆盖式：默认收起，点 tab 展开。宽屏恒展开（CSS 控制，见 styles.css）。
  const [open, setOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const active = turns.find((t) => t.turnId === selectedId) ?? turns[turns.length - 1]

  // 换一轮就把步骤区滚回顶部 —— 否则读第 5 轮时停在半腰，点到第 2 轮还停在那个位置。
  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = 0 }, [active?.turnId])

  if (turns.length === 0) return null

  return (
    <section className={'steps' + (open ? ' open' : '')} aria-label="中间步骤">
      <div className="steps-body" ref={bodyRef}>
        {active ? (
          <>
            <div className="steps-head">第 {active.index} 轮 · {active.label}</div>
            {renderParts(active.parts)}
          </>
        ) : null}
      </div>
      {/* 竖条贴最右、通高。顺序从旧到新（自上而下），与主画面滚动方向一致。 */}
      <nav className="turn-tabs" aria-label="按轮次查看中间步骤">
        {turns.map((t) => (
          <button
            key={t.turnId}
            className={'turn-tab' + (t.turnId === active?.turnId ? ' on' : '')}
            aria-current={t.turnId === active?.turnId}
            title={`第 ${t.index} 轮：${t.label}`}
            onClick={() => { onSelect(t.turnId); setOpen(true) }}
          >
            <span className="tt-n">{t.index}</span>
            <span className="tt-label">{t.label}</span>
          </button>
        ))}
      </nav>
    </section>
  )
}

/**
 * 把一轮的步骤按原顺序渲染：工具调用复用现成的 `ToolCall`（不新写一套），
 * 中间正文按 markdown 渲染。
 *
 * tool-result 要**并到它对应的 tool-use 上**（`ToolCall` 一次吃一对），否则结果会
 * 变成一张没有头的孤卡。配对按 part 的 id，不按相邻位置 —— 结果不一定紧跟着调用。
 */
function renderParts(parts: { msgId: string; part: Part }[]) {
  const results = new Map<string, Extract<Part, { kind: 'tool-result' }>>()
  for (const { part } of parts) if (part.kind === 'tool-result') results.set(part.id, part)
  return parts.map(({ msgId, part }, i) => {
    if (part.kind === 'tool-result') return null   // 已并进对应的 tool-use
    if (part.kind === 'tool-use') {
      return <ToolCall key={`${msgId}:${i}`} use={part} result={results.get(part.id)} />
    }
    return <div key={`${msgId}:${i}`} className="steps-text"><Markdown text={part.text} /></div>
  })
}
