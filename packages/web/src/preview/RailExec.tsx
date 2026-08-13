import { useEffect, useRef, useState } from 'react'
import { closeExec, type ActiveExec } from './activeExec.js'
import { TermBuffer } from '../exec/termText.js'
import { ConfirmDialog } from '../components/ConfirmDialog.js'

/** run 服务推来的事件（与 `@zuse/tools` 的 `RunEvent` 同形；web 够不到那个包，见 types.ts 的说明）。 */
type RunEvent =
  | { type: 'chunk'; stream: 'out' | 'err'; text: string }
  | { type: 'end'; reason: EndReason; exitCode: number | null }

type EndReason = 'exit' | 'wall-clock' | 'idle' | 'killed' | 'detach' | 'output-cap' | 'zombie'

type Phase =
  | { k: 'confirm'; message: string; hint?: string }
  | { k: 'starting' }
  | { k: 'running'; runId: string }
  | { k: 'ended'; text: string; bad: boolean }
  | { k: 'failed'; message: string }

/**
 * 结束原因 → 人话（spec §7）。
 *
 * `run.ts` 把这件事明确推给了 UI：**spawn 失败（没装 uv / 没装 java，首次使用最可能的
 * 失败）表现为「没有任何输出 + exitCode null」** —— 不给它一句专门的话，用户看到的
 * 就是一个空白框加「运行结束」，完全无从下手。
 */
function endText(reason: EndReason, exitCode: number | null, hadOutput: boolean): { text: string; bad: boolean } {
  switch (reason) {
    case 'exit':
      if (exitCode === 0) return { text: '运行结束', bad: false }
      if (exitCode === null && !hadOutput) {
        return { text: '没能启动 —— 本机可能没装 uv（Python）或 java，或者它们不在 PATH 里', bad: true }
      }
      return { text: `运行结束，退出码 ${exitCode}`, bad: true }
    case 'wall-clock': return { text: '跑了 5 分钟还没结束，已停止', bad: true }
    case 'idle': return { text: '一直没有输出，已停止', bad: true }
    case 'output-cap': return { text: '输出太多（超过 20 万字），已停止 —— 上面是被截断的部分', bad: true }
    case 'detach': return { text: '你关掉了运行面板，已停止', bad: false }
    case 'killed': return { text: '已停止', bad: false }
    // 杀不掉的进程必须显眼说出来：这是需要用户自己去任务管理器处理的情况。
    case 'zombie': return { text: '进程没能杀掉，可能还在后台跑 —— 需要你自己去任务管理器结束它', bad: true }
  }
}

/**
 * 右栏的「真跑」那一块（spec §6）。
 *
 * **用 fetch 流而不是 EventSource。** `EventSource` 在服务端关连接时会自动重连（约 3s），
 * 而我们的服务端在 end 之后就 `res.end()` —— 两者相乘是「重连 → 拿到全量 replay + end
 * → 又被关 → 再重连」的无限循环。更糟的是重连窗口内订阅者归零，片段档的
 * `onDetach:'kill'` 会**因为一次网络抖动就把在跑的进程杀掉**。
 * fetch 流不自动重连，读到 end 就主动 abort，语义可控。代价是分帧要自己解。
 *
 * **stdout / stderr 分成两块显示，不合并成一条时间线。** spec §4.4 原本拍的是合并 +
 * err 标红，实现时发现代价更大：两条流各有各的 `TermBuffer` 状态（`\r` 覆盖本行、
 * 半截转义序列），合并成一条时间线就得让 `\r` 跨 segment 往回吃，那是错的。
 * 代价：看不出两条流的时间先后 —— 对「跑一段脚本」这个场景可以接受，
 * stderr 基本就是最后那段报错。
 */
export function RailExec({ exec }: { exec: ActiveExec }) {
  const [phase, setPhase] = useState<Phase>({ k: 'starting' })
  const [out, setOut] = useState('')
  const [err, setErr] = useState('')
  const [pendingConfirm, setPendingConfirm] = useState(false)
  const runIdRef = useRef<string | null>(null)

  // `confirmed` 进 state 是为了让「用户点了确认」能重新触发下面这个 effect。
  const [confirmed, setConfirmed] = useState(false)

  useEffect(() => {
    const ac = new AbortController()
    let alive = true
    runIdRef.current = null
    setOut(''); setErr(''); setPhase({ k: 'starting' })

    const bufs = { out: new TermBuffer(), err: new TermBuffer() }
    let hadOutput = false

    void (async () => {
      let runId: string
      try {
        const res = await fetch('/api/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ exec: { kind: exec.kind, code: exec.code }, sessionId: exec.sessionId, confirmed }),
          signal: ac.signal,
        })
        if (res.status === 409) {
          const b = await res.json() as { error?: { message?: string }; hint?: string }
          if (!alive) return
          return setPhase({ k: 'confirm', message: b.error?.message ?? '这会在你的电脑上真的执行这段代码。', ...(b.hint ? { hint: b.hint } : {}) })
        }
        if (!res.ok) {
          const b = await res.json().catch(() => ({})) as { error?: { message?: string } }
          if (!alive) return
          return setPhase({ k: 'failed', message: b.error?.message ?? `请求失败（${res.status}）` })
        }
        ;({ runId } = await res.json() as { runId: string })
      } catch (e) {
        if (alive && !ac.signal.aborted) setPhase({ k: 'failed', message: String(e) })
        return
      }
      if (!alive) return
      runIdRef.current = runId
      setPhase({ k: 'running', runId })

      // ── SSE 分帧自己解 ──────────────────────────────────────────────
      try {
        const res = await fetch(`/api/runs/${runId}/stream`, { signal: ac.signal })
        const reader = res.body?.getReader()
        if (!reader) return
        const dec = new TextDecoder()
        let carry = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done || !alive) break
          // `stream: true` 是 **decode 的参数**，不是构造器选项（构造器只认 fatal/ignoreBOM）——
          // 写错的话多字节字符会在块边界上碎成 U+FFFD。这个坑步骤 2 踩过一次。
          carry += dec.decode(value, { stream: true })
          const frames = carry.split('\n\n')
          carry = frames.pop() ?? ''
          for (const f of frames) {
            if (!f.startsWith('data: ')) continue
            const ev = JSON.parse(f.slice('data: '.length)) as RunEvent
            if (ev.type === 'chunk') {
              hadOutput = true
              const t = bufs[ev.stream].push(ev.text)
              if (ev.stream === 'out') setOut(t); else setErr(t)
            } else {
              setOut(bufs.out.flush()); setErr(bufs.err.flush())
              setPhase({ k: 'ended', ...endText(ev.reason, ev.exitCode, hadOutput) })
              // 读到 end 就主动断开 —— 不 abort 的话这条连接会一直挂着。
              ac.abort()
              return
            }
          }
        }
      } catch (e) {
        if (alive && !ac.signal.aborted) setPhase({ k: 'failed', message: String(e) })
      }
    })()

    return () => {
      alive = false
      // 卸载 = 断连 = 服务端退订 = 片段档把进程收掉。这是设计意图（v4 §1），不是遗漏。
      ac.abort()
    }
  }, [exec.id, exec.kind, exec.code, exec.sessionId, confirmed])

  const stop = (): void => {
    const id = runIdRef.current
    if (id) void fetch(`/api/runs/${id}`, { method: 'DELETE' })
  }

  const running = phase.k === 'running' || phase.k === 'starting'

  return (
    <section className="rail-exec" aria-label="运行输出">
      <div className="rail-exec-bar">
        <span className="rx-title">{exec.kind === 'python' ? 'Python' : 'Java'}</span>
        {running ? <span className="rx-dot" aria-hidden="true" /> : null}
        <span className="rx-spacer" />
        {running ? <button type="button" onClick={stop}>停止</button> : null}
        <button type="button" onClick={() => closeExec(exec.id)} aria-label="关闭运行面板">关闭</button>
      </div>

      <div className="rail-exec-body">
        {out ? <pre className="rx-out">{out}</pre> : null}
        {err ? (
          <>
            <div className="rx-err-head">错误输出</div>
            <pre className="rx-err">{err}</pre>
          </>
        ) : null}
        {phase.k === 'starting' && !out && !err ? <div className="rx-note">正在启动…</div> : null}
        {phase.k === 'ended' ? <div className={'rx-note' + (phase.bad ? ' bad' : '')}>{phase.text}</div> : null}
        {phase.k === 'failed' ? <div className="rx-note bad">{phase.message}</div> : null}
        {phase.k === 'confirm' ? (
          <div className="rx-note">
            {phase.hint ? <div className="rx-hint">{phase.hint}</div> : null}
            <button type="button" onClick={() => setPendingConfirm(true)}>运行这段代码…</button>
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={pendingConfirm}
        message={phase.k === 'confirm' ? phase.message : ''}
        confirmLabel="就在我电脑上运行"
        cancelLabel="不运行"
        onConfirm={() => { setPendingConfirm(false); setConfirmed(true) }}
        onCancel={() => { setPendingConfirm(false); closeExec(exec.id) }}
      />
    </section>
  )
}
