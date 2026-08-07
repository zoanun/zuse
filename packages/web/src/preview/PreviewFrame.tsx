import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { ConsoleEntry, GuestMessage, HostMessage, PreviewSpec } from './types.js'
import { compile } from './compile/index.js'
import { buildHtmlSrcdoc, buildShellSrcdoc } from './runtime/shell.js'
import { useTheme } from '../theme.js'

/**
 * sandbox token 集。
 *
 * **绝对不能加回 `allow-same-origin`。** srcdoc 文档继承父页 origin，一旦同源，
 * 预览里的代码就能带着父页的认证 cookie 直接打已认证 API（真浏览器实测确认）：
 * - `GET /api/sessions` → 200 + 全部会话内容
 * - `PUT /api/files/content` → 改本机任意文件
 * - `POST /api/mcp` → 注册一个 command 任意的 stdio server，下次 daemon 重启就执行
 *
 * 而这条 HTTP 路径**一个权限提示都不弹**。曾经写在这里的理由「BashTool 本来就能执行
 * 任意命令，浏览器沙箱挡不住任何本来挡得住的东西」是**事实错误**：BashTool 的每一次
 * 执行都要过 `canUseTool` 弹框，同源 iframe 里的 fetch 不用。沙箱挡住的正是
 * **「绕过权限提示的无人值守提权」** —— 那恰恰是它本来就挡得住、也值得挡的东西。
 *
 * 摘掉它的唯一代价（同样是真浏览器实测出来的）：guest 变成 opaque origin，取
 * `/preview-vendor/*` 变成跨源请求，所以那条静态路由必须带
 * `Access-Control-Allow-Origin: *`（只有那一条，见 packages/server/src/http/server.ts）。
 * 高度上报（guest 内 ResizeObserver）与 postMessage（`targetOrigin:'*'` + source/token
 * 鉴别）本来就不依赖同源，不受影响。详见设计文档 §5。
 */
export const SANDBOX_TOKENS = [
  'allow-scripts',
  'allow-forms',
  'allow-modals',
  'allow-popups',
  'allow-pointer-lock',
].join(' ')

/**
 * 编译防抖窗口。设计 §4 承诺过「只在围栏闭合后编译，并加防抖」，初版只做了前半句。
 * 模型逐 token 吐代码时每个 delta 编译一次纯属白烧 CPU（Vue 那条还要拖 374 KB 的
 * compiler-sfc）。窗口取小值：它是防抖不是节流，超过它的停顿会立刻编译，用户感知不到。
 */
export const COMPILE_DEBOUNCE_MS = 120

let seq = 0

/**
 * 高度模型（设计 §5.1）。
 * - `content`：iframe 高度跟着 guest 上报的内容高度走（代码块内联展开时的老行为）。
 * - `fill`：iframe 吃满容器剩余高度。右栏用这个 —— 一个上报 50px 的计数器 demo 塞进
 *   `flex:1` 的右栏，`content` 模式下会变成「一个 80px 的框 + 800px 空白」，第一眼就是做坏了。
 *
 * **两种模式都保留 guest 的 resize 上报通道**（preamble.ts:65-73）：那条通道是刻意设计的
 * （沙箱摘掉 allow-same-origin 之后父页读不到 guest 的 scrollHeight），删掉就再也补不回来；
 * `fill` 只是不拿它驱动布局。
 */
export type PreviewFitMode = 'content' | 'fill'

export function PreviewFrame({ spec, onClose, fitMode = 'content', setEntries }: {
  spec: PreviewSpec
  onClose: () => void
  fitMode?: PreviewFitMode
  /**
   * 控制台条目的写入口（设计 §5.2：entries 提出 PreviewFrame，由父级持有，
   * ConsolePanel 因此能和本组件成为兄弟节点，在右栏里各自占一块高度）。
   *
   * **类型刻意是 useState 的 setter 而不是两个回调**（onLog/onClear）：`push` 进了编译 effect
   * 的依赖数组（见下方 `[kind, code, push, send]`），依赖里的回调身份一抖就重新编译、重下发
   * eval、清空控制台 —— 正是 PreviewFrame.test.tsx「不该重跑的时候绝不重跑」那组锁住的 bug。
   * useState 的 setter 由 React 保证恒等，父级不可能不小心把它写抖。
   */
  setEntries: Dispatch<SetStateAction<ConsoleEntry[]>>
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const readyRef = useRef(false)
  /**
   * 最近一次成功的编译产物 / 最近一次主题。**由 ready 分支统一重放。**
   *
   * 这是「预览永久空白且零报错」那个 bug 的根治点：srcdoc 一变就是一个**全新
   * document**，它不可能知道上一轮 eval 过什么，只会重新发一次 ready。
   *
   * 为什么不是原来那个 `pendingRef` 单槽缓冲：它只存得下**一条**消息，theme 与 eval
   * 会互相覆盖、被覆盖的那条静默丢失；而且它在 srcdoc 的 reset effect 里被清空，
   * 新 document 的 ready 到达时槽里已经是空的 —— 正是 P0-1 的现场。
   */
  const lastEvalRef = useRef<HostMessage | null>(null)
  const [height, setHeight] = useState(160)
  const theme = useTheme()
  const lastThemeRef = useRef<HostMessage>({ type: 'theme', theme })

  // 每次挂载一个新 token：父页据此丢弃上一个 iframe 的迟到消息。
  const token = useMemo(() => `pv-${++seq}-${Math.random().toString(36).slice(2, 8)}`, [])

  /**
   * srcdoc 只依赖 token/kind（HTML 额外依赖 code，它整个就是 document）——
   * **不依赖 code（非 HTML）**，否则流式吐字会疯狂重建 iframe；
   * **也不依赖 theme**：主题有独立的 postMessage 通道（preamble 收到后改 data-theme），
   * 把它塞进依赖里等于「切一次主题 = 换一个 document = demo 状态全丢」。
   * 初值从 ref 取，之后一律走消息。
   */
  const initialThemeRef = useRef(theme)
  const srcdoc = useMemo(
    () => (spec.kind === 'html'
      ? buildHtmlSrcdoc(spec.code, token, initialThemeRef.current)
      : buildShellSrcdoc(token, initialThemeRef.current)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上：故意不依赖 spec.code / theme
    [spec.kind, spec.kind === 'html' ? spec.code : '', token],
  )

  const push = useCallback((e: Omit<ConsoleEntry, 'id'>) => {
    setEntries((prev) => [...prev.slice(-199), { ...e, id: ++seq }])
  }, [setEntries])

  // 没就绪就直接丢，**不缓冲**：ready 到达时下面那个分支会把 theme 与最近一次 eval
  // 一起重放。缓冲只会制造「单槽互相覆盖 → 静默丢消息」。
  const send = useCallback((msg: HostMessage) => {
    const win = frameRef.current?.contentWindow
    if (!win || !readyRef.current) return
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
          // 重放。新 document 什么都不知道：主题与最近一次产物都得补给它，
          // 否则「iframe 在、里面永远空白、控制台零报错」。
          send(lastThemeRef.current)
          if (lastEvalRef.current) send(lastEvalRef.current)
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
  //
  // **依赖必须是 `spec.kind` / `spec.code` 两个原始值，不能是 `spec` 对象。**
  // 调用方（Markdown.tsx 的 CodeBlock）每次渲染都新建 `{ kind, code }` 字面量，
  // 依赖对象身份 = 一次无关重渲染就重编译、重下发 eval、还 setEntries([]) 清空控制台。
  // 真浏览器实测过的现场：点一下代码块的「复制」按钮（useCopy 的 setCopied(true)
  // 触发重渲染），demo 计数器从 3 归 0，1.5 秒后 setCopied(false) 再来一遍。
  // 指望调用方去 useMemo 不牢靠 —— 约束该由这里自己守住。
  const { kind, code } = spec
  useEffect(() => {
    if (kind === 'html') return
    let cancelled = false
    // 防抖（设计 §4）：流式吐字时每个 delta 编译一次是纯浪费。
    const timer = setTimeout(() => {
      setEntries([])
      void compile({ kind, code }).then((r) => {
        if (cancelled) return
        for (const e of r.errors) push({ level: 'error', text: e, source: 'compile' })
        if (r.errors.length > 0) {
          // 编译失败就把上一次的产物作废：否则 document 一重建就重放旧代码，
          // 界面显示的是早已改过的版本，比空白更误导。
          lastEvalRef.current = null
          return
        }
        const msg: HostMessage = { type: 'eval', js: r.js, styles: r.styles }
        lastEvalRef.current = msg
        send(msg)
      })
    }, COMPILE_DEBOUNCE_MS)
    return () => { cancelled = true; clearTimeout(timer) }
    // setEntries 是 useState 的 setter，React 保证恒等 —— 放进依赖不会引起重编译。
  }, [kind, code, push, send, setEntries])

  // guest 是独立 document，不会继承 <html data-theme>，主题要显式下发（设计 §6.5）。
  useEffect(() => {
    const msg: HostMessage = { type: 'theme', theme }
    lastThemeRef.current = msg // 记下来，新 document 就绪时要重放
    send(msg)
  }, [theme, send])

  // srcdoc 变了 = 换了一个新 document，就绪状态必须重置。
  //
  // **不能挂在 iframe 的 onLoad 上**（踩过）：guest 的 preamble 在文档**解析期间**就
  // 发出 ready，那早于 load 事件。挂 onLoad 会把已经到达的 ready 重置掉，之后 send()
  // 因为 readyRef 为假而一律丢弃，且再也不会有下一个 ready 来触发重放 ——
  // 现象是预览框出来了但里面永远空白，且无任何报错。
  // 放在 effect 里则顺序确定：commit 同一批同步执行，必然早于 guest 脚本所在的下一个任务。
  //
  // **只重置 readyRef，不要碰 lastEvalRef** —— 那份产物正是新 document 要重放的东西。
  useEffect(() => {
    readyRef.current = false
  }, [srcdoc])

  return (
    // `.preview-bar` 就是右栏的头部 —— **不要在右栏里另造一条 `.rail-head`**，
    // 否则同一块面板上会出现两个关闭按钮（设计 §5）。
    <div className={'preview preview-' + fitMode}>
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
        // fill 模式下高度交给 flex，内联 style 必须让位（内联优先级高于任何类选择器）。
        style={fitMode === 'fill' ? undefined : { height }}
      />
    </div>
  )
}
