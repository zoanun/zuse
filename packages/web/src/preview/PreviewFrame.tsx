import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConsoleEntry, GuestMessage, HostMessage, PreviewSpec } from './types.js'
import { compile } from './compile/index.js'
import { buildHtmlSrcdoc, buildShellSrcdoc } from './runtime/shell.js'
import { useTheme } from '../theme.js'
import { ConsolePanel } from './ConsolePanel.js'

/**
 * sandbox token 集。
 *
 * **`allow-scripts` 与 `allow-same-origin` 同时给 = 没有沙箱**，这是有意的，不是疏忽：
 * srcdoc 继承父页 origin，guest 能拿到 parent.document → 找到自己这个 iframe →
 * 删掉 sandbox 属性 → reload → 解放自己（真浏览器实测过，Vue 官方 REPL 同样如此）。
 *
 * 为什么可以接受：zuse 的 Bash 工具本来就能在本机执行任意命令，浏览器沙箱挡不住任何
 * 本来挡得住的东西，只会挡住功能。真隔离的唯一办法是独立 origin（daemon 另开端口），
 * 代价与收益严重不匹配。详见设计文档 §5。
 *
 * **别顺手摘掉 `allow-same-origin`** —— 有一条测试盯着这两个 token 同时存在，
 * 摘了会红。那不是安全测试，是防误改测试。
 */
export const SANDBOX_TOKENS = [
  'allow-scripts',
  'allow-same-origin',
  'allow-forms',
  'allow-modals',
  'allow-popups',
  'allow-pointer-lock',
].join(' ')

let seq = 0

export function PreviewFrame({ spec, onClose }: { spec: PreviewSpec; onClose: () => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const readyRef = useRef(false)
  const pendingRef = useRef<HostMessage | null>(null)
  const [entries, setEntries] = useState<ConsoleEntry[]>([])
  const [height, setHeight] = useState(160)
  const theme = useTheme()

  // 每次挂载一个新 token：父页据此丢弃上一个 iframe 的迟到消息。
  const token = useMemo(() => `pv-${++seq}-${Math.random().toString(36).slice(2, 8)}`, [])

  // HTML 走整页 srcdoc（用户的 <head>/<script> 要原样生效）；其余走 shell + eval 通道。
  // srcdoc 只依赖 token/theme/kind —— **不依赖 code**，否则流式吐字会疯狂重建 iframe。
  const srcdoc = useMemo(
    () => (spec.kind === 'html' ? buildHtmlSrcdoc(spec.code, token, theme) : buildShellSrcdoc(token, theme)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上：故意不依赖 spec.code
    [spec.kind, spec.kind === 'html' ? spec.code : '', token, theme],
  )

  const push = useCallback((e: Omit<ConsoleEntry, 'id'>) => {
    setEntries((prev) => [...prev.slice(-199), { ...e, id: ++seq }])
  }, [])

  const send = useCallback((msg: HostMessage) => {
    const win = frameRef.current?.contentWindow
    if (!win) return
    if (!readyRef.current) { pendingRef.current = msg; return }
    win.postMessage(msg, '*')
  }, [])

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      // 鉴别只认 source + token。**不能**用 ev.origin —— opaque origin 下它恒为 "null"。
      if (ev.source !== frameRef.current?.contentWindow) return
      const data = ev.data as GuestMessage | undefined
      if (!data || data.token !== token) return
      switch (data.type) {
        case 'ready':
          readyRef.current = true
          if (pendingRef.current) { send(pendingRef.current); pendingRef.current = null }
          break
        case 'log':
          push({ level: data.level, text: data.args.join(' '), source: 'runtime' })
          break
        case 'error':
          push({ level: 'error', text: data.stack ?? data.message, source: 'runtime' })
          break
        case 'resize':
          setHeight(Math.min(Math.max(data.height + 8, 80), 900))
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [token, push, send])

  // 编译 → 注入。HTML 不走这条（它整个就是 document）。
  useEffect(() => {
    if (spec.kind === 'html') return
    let cancelled = false
    setEntries([])
    void compile(spec).then((r) => {
      if (cancelled) return
      for (const e of r.errors) push({ level: 'error', text: e, source: 'compile' })
      if (r.errors.length === 0) send({ type: 'eval', js: r.js, styles: r.styles })
    })
    return () => { cancelled = true }
  }, [spec, push, send])

  // guest 是独立 document，不会继承 <html data-theme>，主题要显式下发（设计 §6.5）。
  useEffect(() => { send({ type: 'theme', theme }) }, [theme, send])

  // srcdoc 变了 = 换了一个新 document，就绪状态必须重置。
  //
  // **不能挂在 iframe 的 onLoad 上**（踩过）：guest 的 preamble 在文档**解析期间**就
  // 发出 ready，那早于 load 事件。挂 onLoad 会把已经到达的 ready 重置掉，之后 eval
  // 被永远缓存在 pendingRef 里 —— 现象是预览框出来了但里面永远空白，且无任何报错。
  // 放在 effect 里则顺序确定：commit 同一批同步执行，必然早于 guest 脚本所在的下一个任务。
  useEffect(() => {
    readyRef.current = false
    pendingRef.current = null
  }, [srcdoc])

  return (
    <div className="preview">
      <div className="preview-bar">
        <span className="preview-kind">{spec.kind}</span>
        <button type="button" className="preview-close" onClick={onClose}>收起预览</button>
      </div>
      <iframe
        ref={frameRef}
        className="preview-frame"
        title="代码预览"
        sandbox={SANDBOX_TOKENS}
        srcDoc={srcdoc}
        style={{ height }}
      />
      <ConsolePanel entries={entries} onClear={() => setEntries([])} />
    </div>
  )
}
