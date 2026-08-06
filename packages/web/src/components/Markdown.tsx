import { createContext, useContext, useId, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeHighlight from 'rehype-highlight'
import { taskMarker, type TaskStatus } from './taskMarker.js'
import { useCopy } from '../state/useCopy.js'
import { detectKind } from '../preview/detect.js'
import { closePreview, openPreview, useIsPreviewOpen } from '../preview/activePreview.js'
import { PreviewFrame } from '../preview/PreviewFrame.js'

/**
 * 本条消息是否仍在流式输出。
 *
 * 为什么必须显式传：`CodeBlock` **无法自己判断**代码围栏是否已闭合 —— 实测未闭合的
 * ```` ```vue ```` 围栏，react-markdown 照样渲染成结构完全相同的 `<pre>` 且带
 * `language-vue`。没有这个信号，运行按钮会在模型刚吐出半个组件时就可点。
 *
 * 用 context 而不是 prop：`components` 表是 hoist 出来的（见下方注释），
 * 塞 prop 会迫使它随状态重建，那正是 hoist 要避免的事。context 的默认值 false
 * 让不传的调用方（如导出路径）行为不变。
 */
const StreamingContext = createContext(false)

// "In progress" status syntax [-]/[~]/[/], which GFM leaves as literal text.
const IN_PROGRESS = /^\[[-~/]\]\s+/

// Models often write a "todo list" as glyph-led lines (✓ √ ● ○ …) — with or without
// a `- ` bullet — which GFM never renders as a checkbox. Rewrite such lines to GFM task
// syntax up front (✓→[x], ●→[-], ○→[ ]) so list AND prose forms converge on the same
// markers (the Tasks panel's). Lines inside ``` fences are left alone.
const GLYPH_CHARS = /[✓✔☑√●◐○◯☐□]/
const GLYPH_TO_MD: Record<string, string> = {
  '✓': '[x] ', '✔': '[x] ', '☑': '[x] ', '√': '[x] ',
  '●': '[-] ', '◐': '[-] ',
  '○': '[ ] ', '◯': '[ ] ', '☐': '[ ] ', '□': '[ ] ',
}
const GLYPH_LINE = /^(\s*)(?:[-*+]\s+)?([✓✔☑√●◐○◯☐□])\s+(.+)$/
function normalizeTaskGlyphs(md: string): string {
  if (!GLYPH_CHARS.test(md)) return md // fast path: nothing to rewrite
  let inFence = false
  return md
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) { inFence = !inFence; return line }
      if (inFence) return line
      const m = line.match(GLYPH_LINE)
      return m ? `${m[1]}- ${GLYPH_TO_MD[m[2]!]}${m[3]}` : line
    })
    .join('\n')
}

function markedLi(status: TaskStatus, content: ReactNode[]): ReactNode {
  return <li className={`task-list-item task-mark ${status}`}>{taskMarker(status)}{content}</li>
}
// Hoisted so they keep a stable identity across renders (new arrays each render
// would make react-markdown reprocess on every parent re-render — e.g. per delta).
const REMARK_PLUGINS = [remarkGfm, remarkBreaks]
const REHYPE_PLUGINS = [rehypeHighlight]
// Wrap each fenced code block (<pre>) with a hover-reveal "Copy" button. The code
// text is read from the rendered <pre>'s textContent on click, so it works
// regardless of how rehype-highlight split the tokens into child spans.
// `node` 必须保留、不能解构后丢掉：react-markdown v9 传给 `pre` 的 props 里 className 为
// null，**语言只存在于 node.children[0].properties.className**（形如 language-jsx）。
function CodeBlock({ node, ...rest }: ComponentPropsWithoutRef<'pre'> & { node?: unknown }) {
  const ref = useRef<HTMLPreElement>(null)
  const { copied, copy } = useCopy()
  const streaming = useContext(StreamingContext)
  const id = useId()
  const open = useIsPreviewOpen(id)
  // 代码正文只在需要判定时取一次；DOM 尚未挂载时（首帧）拿不到，故也接受 undefined。
  const [code, setCode] = useState('')
  const kind = detectKind(node, code)

  return (
    <div className="code-wrap">
      <div className="code-actions">
        {kind ? (
          <button
            type="button"
            className="code-run"
            // 流式中禁用而非隐藏：隐藏会让按钮在流结束瞬间跳出来，造成布局抖动。
            disabled={streaming}
            title={streaming ? '等模型写完再运行' : undefined}
            onClick={() => (open ? closePreview(id) : openPreview(id))}
          >
            {open ? '停止' : '运行'}
          </button>
        ) : null}
        <button type="button" className="code-copy" onClick={() => copy(ref.current?.textContent ?? '')} aria-label="复制代码">
          {copied ? '✓ 已复制' : '复制'}
        </button>
      </div>
      <pre
        ref={(el) => {
          ref.current = el
          const text = el?.textContent ?? ''
          if (text !== code) setCode(text)
        }}
        {...rest}
      />
      {open && kind ? <PreviewFrame spec={{ kind, code }} onClose={() => closePreview(id)} /> : null}
    </div>
  )
}

const components: Components = {
  pre: CodeBlock,
  li(props) {
    const { children, className } = props
    const kids = Array.isArray(children) ? children : [children]
    const first = kids[0]
    if (typeof first === 'string') {
      const ip = first.match(IN_PROGRESS)
      if (ip) return markedLi('doing', [first.slice(ip[0].length), ...kids.slice(1)])
    }
    // Preserve GFM's `task-list-item` class so its native [x]/[ ] checkbox keeps styling.
    return <li className={className}>{children}</li>
  },
}

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="text">
      <StreamingContext.Provider value={streaming}>
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
          {normalizeTaskGlyphs(text)}
        </ReactMarkdown>
      </StreamingContext.Provider>
    </div>
  )
}
