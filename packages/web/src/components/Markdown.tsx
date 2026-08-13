import { createContext, useContext, useMemo, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeHighlight from 'rehype-highlight'
import { taskMarker, type TaskStatus } from './taskMarker.js'
import { useCopy } from '../state/useCopy.js'
import { detectKind, detectExec } from '../preview/detect.js'
import { closeRun, openRun, useIsRunOpen } from '../preview/activePreview.js'
import { closeExec, openExec, useExecState } from '../preview/activeExec.js'

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

/**
 * 当前会话 id。由 `Shell` 在聊天区外层提供，`CodeBlock` 在点「运行」时把它盖进 `ActiveRun`，
 * 右栏据此判断这条 run 是不是自己这个会话的（设计 §3.3 / P0-2）。
 *
 * 用 context 而不是把 sessionId 一层层当 prop 传下来（Shell → MessageList → Message → Markdown）：
 * 它一个会话内恒定不变，且 `components` 表是 hoist 出来的、不依赖它 —— 与 `StreamingContext`
 * 同一个套路。默认空串让不在 Shell 里渲染的调用方（导出、单测）行为可预期。
 */
export const SessionContext = createContext('')

/**
 * 代码块身份的上下文。`CodeBlock` 用它算出**跨挂载稳定**的 runId。
 *
 * **为什么不能再用 `useId()`（设计 §3.4 / P0-3）**：`useId()` 是**位置派生**的，
 * 实测同一个代码块在 plain / share / filtered 三种渲染下分别是 `_R_0_` / `_R_2_` / `_R_2_`。
 * `MessageList.tsx:99`/`:108` 进出分享模式时 `label` ↔ `div` 互换会整体重挂，`:79` 的
 * shareMode 过滤还会改列表长度。后果：预览跑着 → 点「分享」→ 按钮从「停止」翻回「运行」
 * → 再点一下就用新 id 顶掉旧 run → iframe 重挂、demo 归零。
 *
 * 改用 `messageId + 代码块在本条消息里的序号`。序号由**内容**推出（数这块围栏之前有几个围栏），
 * 不由渲染位置推出，所以 share / 非 share 两条路算出来的是同一个数：
 * 非 share 是「每个 text part 的每个非 think 段各渲染一个 <Markdown>」，share 是
 * 「所有非 think 段拼成一个 <Markdown>」—— 代码块的**文档顺序完全一致**（think 段里没有
 * CodeBlock，它是纯文本渲染），差的只是被切成几段，而 `blockBase` 把切口补回来了。
 */
interface BlockIdCtx {
  messageId: string
  /** 本 <Markdown> 之前，同一条消息里已经出现过多少个代码块。 */
  base: number
  /** 交给 ReactMarkdown 的那份文本（归一化之后的），用来数围栏。 */
  source: string
}
const BlockIdContext = createContext<BlockIdCtx>({ messageId: '', base: 0, source: '' })

/**
 * 数一段 markdown 里有几个代码围栏。**数开栏**：未闭合的围栏照样被 react-markdown
 * 渲染成一个 `<pre>`（Markdown.tsx 顶部注释里实测过），漏数它序号就会错位。
 * 扫描规则与 `normalizeTaskGlyphs` 保持一致（同一个 /^\s*```/），两者对「什么算围栏」
 * 必须是同一套判断，否则归一化前后数出来的个数会对不上。
 */
export function countCodeFences(md: string): number {
  let n = 0
  let inFence = false
  for (const line of md.split('\n')) {
    if (!/^\s*```/.test(line)) continue
    if (!inFence) n++
    inFence = !inFence
  }
  return n
}

/** hast 节点在源文本里的起始偏移；拿不到时返回 undefined（见 CodeBlock 里的降级说明）。 */
function nodeOffset(node: unknown): number | undefined {
  const off = (node as { position?: { start?: { offset?: number } } } | undefined)?.position?.start?.offset
  return typeof off === 'number' ? off : undefined
}

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
  const sessionId = useContext(SessionContext)
  const { messageId, base, source } = useContext(BlockIdContext)
  // 代码正文只在需要判定时取一次；DOM 尚未挂载时（首帧）拿不到，故也接受 undefined。
  const [code, setCode] = useState('')
  const kind = detectKind(node, code)
  // 可预览与可执行是**互斥的两条路**：前者在 iframe 里跑给你看，后者在**你的机器上真的跑**。
  // 一个代码块只可能是其中一种（detect 的两张表没有交集）。
  const execKind = kind ? null : detectExec(node)
  // 序号 = 本 <Markdown> 之前的存量 + 本块之前的围栏数。offset 拿不到时（理论上不会：
  // react-markdown v9 的 hast 节点带 position，已实测）退化成只用 base —— 同一条消息里
  // 会撞号，但绝不会崩，也不会跨 share/非 share 漂移。
  const off = nodeOffset(node)
  const ordinal = base + (off === undefined ? 0 : countCodeFences(source.slice(0, off)))
  const runId = `${messageId}#${ordinal}`
  const previewOpen = useIsRunOpen(runId)
  const execState = useExecState(runId)
  const open = previewOpen || execState !== 'idle'
  // 预览已展开时按钮常驻（否则鼠标一移开就找不到「停止」）。
  // 原来靠 CSS 的 `.code-wrap:has(.preview)`，预览搬去右栏后那个选择器永不命中、会**静默失效**，
  // 所以改由 React 打这个类（设计 §5.3 / P1-6）。`kind` 也要判：无语言的缩进代码块没有
  // 运行按钮，却可能和相邻围栏算出同一个序号。
  const running = open && (!!kind || !!execKind)

  return (
    <div className={'code-wrap' + (running ? ' running' : '')}>
      <div className="code-actions">
        {kind || execKind ? (
          <button
            type="button"
            className="code-run"
            // 流式中禁用而非隐藏：隐藏会让按钮在流结束瞬间跳出来，造成布局抖动。
            // **执行那条路更需要它**：半截的 Python 跑起来只会报语法错，白白在用户机器上起一个进程。
            disabled={streaming}
            title={streaming ? '等模型写完再运行' : execKind ? '在你的电脑上真的运行这段代码' : undefined}
            onClick={() => {
              if (open) return execKind ? closeExec(runId) : closeRun(runId)
              // code 是**快照**：点下去这一刻的正文冻进 store，之后代码再变也不跟
              // （设计 §3.2）。活推会把流式抖动广播给每一个订阅者，反而制造重渲染风暴。
              if (execKind) openExec({ id: runId, source: 'snippet', kind: execKind, code, sessionId })
              else if (kind) openRun({ id: runId, kind, code, sessionId })
            }}
          >
            {/* **跑完之后不能还写「停止」** —— 点下去的实际行为是关掉面板，
                文案和行为对不上，还让人以为进程还在跑。真浏览器点一遍才发现的。 */}
            {execState === 'running' ? '停止'
              : execState === 'done' ? '收起输出'
              : previewOpen ? '停止'
              : execKind ? '在本机运行' : '运行'}
          </button>
        ) : null}
        <button type="button" className="code-copy" onClick={() => copy(ref.current?.textContent ?? '')} aria-label="复制代码">
          {copied ? '✓ 已复制' : '复制'}
        </button>
      </div>
      <pre
        ref={(el) => {
          ref.current = el
          // **detach 时（el 为 null）必须直接返回。别顺手删掉这一行。**
          //
          // 当初的理由是「内联箭头每次渲染都是新身份，React 先 ref(null) 再 ref(el)，
          // 少了这行 code 每次重渲染都要 TEXT → '' → TEXT 抖一圈，把 PreviewFrame 的编译
          // effect 踢一脚」。**这条理由在 React 19.2 上实测已经不成立**：仅仅函数身份变了
          // React 不再解绑重绑（实测连续 5 次重渲染，code 长度恒为 12，`ref(null)` 一次没来）。
          //
          // 但这行**仍然必要，只是换了个理由**：代码块**真的被移走**（内容换掉 / 组件卸载）时
          // React 确实会 `ref(null)`，删掉这行就是 `TypeError: Cannot read properties of null`
          // ——实测过，见 Markdown.test.tsx「内容换掉 / 卸载时不得抛」。
          // 另外 `ref.current = el` 必须留在这行**之前**：「复制」按钮读的就是它。
          if (!el) return
          const text = el.textContent ?? ''
          if (text !== code) setCode(text)
        }}
        {...rest}
      />
      {/* 预览**不再渲染在这里**：它在 `Rail`（`.main-body` 的兄弟节点）。留在消息流里
          会跟着聊天一起滚走，那正是 PR1 要解决的事。 */}
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

export function Markdown({ text, streaming = false, messageId = '', blockBase = 0 }: {
  text: string
  streaming?: boolean
  /** 本段文本属于哪条消息。与 blockBase 一起构成代码预览的稳定身份，见 BlockIdContext。 */
  messageId?: string
  /** 同一条消息里，本段文本之前已经出现过多少个代码块。 */
  blockBase?: number
}) {
  // 顺手 memo：原来每次渲染都要 split/join 一遍整段文本（流式期每个 delta 一次）。
  const source = useMemo(() => normalizeTaskGlyphs(text), [text])
  const blockCtx = useMemo<BlockIdCtx>(() => ({ messageId, base: blockBase, source }), [messageId, blockBase, source])
  return (
    <div className="text">
      <BlockIdContext.Provider value={blockCtx}>
        <StreamingContext.Provider value={streaming}>
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
            {source}
          </ReactMarkdown>
        </StreamingContext.Provider>
      </BlockIdContext.Provider>
    </div>
  )
}
