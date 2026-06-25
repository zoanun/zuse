import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

// GFM only recognises [ ] and [x]. The model also emits [-]/[~]/[/] for "in progress",
// which GFM leaves as literal text. Render those as an in-progress task item (● accent),
// mirroring the TodosPanel. Recognised [ ]/[x] items are untouched (their first child is
// the GFM <input>, not a string, so they never match here).
const IN_PROGRESS = /^\[[-~/]\]\s+/
const components: Components = {
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
    }
    return <li>{children}</li>
  },
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="text">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
