import { useState } from 'react'
import { closeRun, type ActiveRun } from './activePreview.js'
import { PreviewFrame } from './PreviewFrame.js'
import { ConsolePanel } from './ConsolePanel.js'
import type { ConsoleEntry } from './types.js'

/**
 * 右侧工作栏（设计 §4 / PR1）。
 *
 * 收益的九成在这一条：**预览不再跟着聊天一起滚走**。所以它必须是 `.main-body` 的兄弟节点，
 * 而不是消息流里的一个元素。
 *
 * 两个不变量，改这里之前先读：
 *
 * 1. **本组件绝不能按视口/容器宽度分叉出第二棵子树**（设计 §4.3 / P0-4）。
 *    `narrow ? <Overlay><PreviewFrame/></Overlay> : <PreviewFrame/>` 会在跨断点那一刻
 *    让 PreviewFrame 换位置 → `token`（`useMemo(...,[])`）重生 → 新 document → demo 归零。
 *    窄屏覆盖式**只由 CSS 的 `@container` 换外观**，DOM 结构一个字不动。
 * 2. **不要给 PreviewFrame 加 `key`**。切换到另一段代码时 `run.id` 会变，加了 key 就等于
 *    每次换 run 都重建 document；不加则走 eval 通道就地替换，控制台与主题都不掉。
 *
 * `entries` 提升到这里（设计 §5.2）：ConsolePanel 因此和 PreviewFrame 是兄弟，
 * 右栏可以给 iframe `flex:1`、给控制台一个固定上限高度。
 */
export function Rail({ run }: { run: ActiveRun }) {
  const [entries, setEntries] = useState<ConsoleEntry[]>([])
  return (
    <aside className="rail" aria-label="预览工作栏">
      <PreviewFrame
        spec={{ kind: run.kind, code: run.code }}
        fitMode="fill"
        setEntries={setEntries}
        onClose={() => closeRun(run.id)}
      />
      <ConsolePanel entries={entries} onClear={() => setEntries([])} />
    </aside>
  )
}
