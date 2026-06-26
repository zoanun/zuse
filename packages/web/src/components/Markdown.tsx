import { useRef, useState, type ComponentPropsWithoutRef } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeHighlight from 'rehype-highlight'

// GFM only recognises [ ] and [x]. The model also emits [-]/[~]/[/] for "in progress",
// which GFM leaves as literal text. Render those as an in-progress task item (● accent),
// mirroring the TodosPanel. Recognised [ ]/[x] items are untouched (their first child is
// the GFM <input>, not a string, so they never match here).
const IN_PROGRESS = /^\[[-~/]\]\s+/
// The model sometimes writes task lists using literal status glyphs as the bullet
// (✓ / ● / ○ …). Those are plain list items, so the browser ALSO draws its default
// disc → a doubled "• ✓ text". When a line already leads with a status glyph, drop the
// disc (the glyph is the marker) by tagging it task-list-item (list-style: none).
const STATUS_GLYPH = /^[✓✔☑●◐○◯☐]\s/
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
    const { children } = props
    const kids = Array.isArray(children) ? children : [children]
    const first = kids[0]
    if (typeof first === 'string') {
      const m = first.match(IN_PROGRESS)
      if (m) {
        const rest = [first.slice(m[0].length), ...kids.slice(1)]
        return <li className="task-list-item in-progress"><span className="tl-ip">●</span>{rest}</li>
      }
      if (STATUS_GLYPH.test(first)) {
        return <li className="task-list-item">{children}</li>
      }
    }
    return <li>{children}</li>
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
