import { useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeHighlight from 'rehype-highlight'
import { taskMarker, type TaskStatus } from './taskMarker.js'

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
    }
    // Preserve GFM's `task-list-item` class so its native [x]/[ ] checkbox keeps styling.
    return <li className={className}>{children}</li>
  },
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="text">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
        {normalizeTaskGlyphs(text)}
      </ReactMarkdown>
    </div>
  )
}
