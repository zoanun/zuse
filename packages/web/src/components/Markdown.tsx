import { useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeHighlight from 'rehype-highlight'

type TaskStatus = 'done' | 'doing' | 'todo'

// The model writes task items two ways, neither of which GFM renders as a checkbox:
//   1. status syntax [-]/[~]/[/] for "in progress"
//   2. literal status glyphs as the bullet (✓ √ ● ○ …)
// Map both to the SAME markers the Tasks panel uses: default checkbox (done/todo,
// only re-tinted) + a solid square (in-progress). GFM's own [x]/[ ] already render a
// native checkbox (we just re-tint it) so they fall through to the default below.
const IN_PROGRESS = /^\[[-~/]\]\s+/
const GLYPH = /^([✓✔☑√●◐○◯☐□])\s+/
const GLYPH_STATUS: Record<string, TaskStatus> = {
  '✓': 'done', '✔': 'done', '☑': 'done', '√': 'done',
  '●': 'doing', '◐': 'doing',
  '○': 'todo', '◯': 'todo', '☐': 'todo', '□': 'todo',
}

/** The marker for a task status: a re-tinted default checkbox, or a solid square (in-progress). */
function taskMarker(status: TaskStatus): ReactNode {
  if (status === 'doing') return <span className="cbx doing" aria-hidden="true" />
  return <input type="checkbox" className="cbx-native" defaultChecked={status === 'done'} disabled aria-hidden="true" />
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
function CodeBlock({ node, ...rest }: ComponentPropsWithoutRef<'pre'> & { node?: unknown }) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    const text = ref.current?.textContent ?? ''
    if (!text) return
    void navigator.clipboard?.writeText(text).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1500) },
      () => {},
    )
  }
  return (
    <div className="code-wrap">
      <button type="button" className="code-copy" onClick={copy} aria-label="Copy code">
        {copied ? '✓ Copied' : 'Copy'}
      </button>
      <pre ref={ref} {...rest} />
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
      const g = first.match(GLYPH)
      if (g) return markedLi(GLYPH_STATUS[g[1]!]!, [first.slice(g[0].length), ...kids.slice(1)])
    }
    // Preserve GFM's `task-list-item` class so its native [x]/[ ] checkbox keeps styling.
    return <li className={className}>{children}</li>
  },
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="text">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
