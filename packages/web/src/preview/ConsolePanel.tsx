import type { ConsoleEntry } from './types.js'

/**
 * 预览的控制台。**编译错误与运行时错误要能分辨** —— 前者是我们的编译管线报的
 * （代码根本没跑），后者是 guest 抛的（跑了但炸了）。混在一起会让人查错方向都找不对。
 */
export function ConsolePanel({ entries, onClear }: { entries: ConsoleEntry[]; onClear: () => void }) {
  if (entries.length === 0) return null
  return (
    <div className="preview-console">
      <div className="preview-console-bar">
        <span>控制台 · {entries.length}</span>
        <button type="button" onClick={onClear}>清空</button>
      </div>
      <ul className="preview-console-list">
        {entries.map((e) => (
          <li key={e.id} className={`pc-${e.level}`}>
            {e.source === 'compile' ? <span className="pc-tag">编译</span> : null}
            <span className="pc-text">{e.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
