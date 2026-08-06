import { useMemo } from 'react'
import { isTurnOpener, type Message, type Part } from '../state/types.js'

type AgentStatus = 'done' | 'doing' | 'failed'

interface SubAgent { id: string; label: string; status: AgentStatus }

/**
 * Collect every Agent (sub-agent) tool call in the given messages, pairing each with its result
 * by id. 只管**前台**子代理：没有结果 = 还在跑，有结果 = 已返回（错误结果则 failed）。
 * 这个判据是自愈的 —— 结果一到状态就翻。
 *
 * **后台子代理不在这里。** 它的 tool-result 是那句立即返回的 "launched in background" ack，
 * 也就是说「工具已返回」，只是真正的活儿还在跑。曾经把这句 ack 当作「仍在运行」来处理，
 * 结果是它永远等不到翻面：完成通知是一条普通用户消息、不是该 tool-use 的结果；而被停止
 * 取消掉的那些连通知都不会有。于是面板永久卡在「1 运行中」，且因为源自已落盘的历史，
 * 刷新也去不掉。现在在飞的后台子代理由服务端的待投递表直接给出（AppState.backgroundAgents）。
 */
export function collectAgents(messages: Message[]): SubAgent[] {
  const results = new Map<string, Extract<Part, { kind: 'tool-result' }>>()
  for (const m of messages) for (const p of m.parts) if (p.kind === 'tool-result') results.set(p.id, p)

  const out: SubAgent[] = []
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.kind !== 'tool-use' || p.name !== 'Agent') continue
      const inp = (p.input ?? {}) as { description?: unknown; prompt?: unknown; runInBackground?: unknown }
      // 后台派发在这张前台表里没有意义：工具立刻就返回了那句 ack，"已返回" 说明不了活儿干没干完。
      // 它的在飞状态由服务端给（见函数注释）—— 不跳过的话，同一个子代理会在面板里出现两次。
      // 判据取输入参数而不是匹配 ack 文案：前者是结构，后者是会被人顺手润色的英文句子。
      if (inp.runInBackground === true) continue
      const label = (typeof inp.description === 'string' && inp.description) ||
        (typeof inp.prompt === 'string' ? inp.prompt : '') || 'sub-agent'
      const r = results.get(p.id)
      const status: AgentStatus = !r ? 'doing' : r.isError ? 'failed' : 'done'
      out.push({ id: p.id, label, status })
    }
  }
  return out
}

/** Status marker: returned → green check, waiting → pulsing dot, failed → red ✕. */
function AgentMarker({ status }: { status: AgentStatus }) {
  if (status === 'done') return <span className="ag-mark ag-done" aria-hidden="true">✓</span>
  if (status === 'failed') return <span className="ag-mark ag-failed" aria-hidden="true">✕</span>
  return <span className="ag-mark ag-run" aria-hidden="true" />
}

/** Messages of the current turn: everything from the last turn opener onward. A mid-turn steer
 *  bubble is NOT the opener (isTurnOpener), so interjecting doesn't drop the turn's earlier
 *  tool-use/tool-result parts and hide the sub-agents still running. */
function currentTurn(messages: Message[]): Message[] {
  let start = 0
  for (let i = messages.length - 1; i >= 0; i--) if (isTurnOpener(messages[i]!)) { start = i; break }
  return messages.slice(start)
}

export function AgentsPanel({ messages, backgroundAgents = [] }: { messages: Message[]; backgroundAgents?: string[] }) {
  // 两个来源，两种真相：
  //  - 前台子代理来自本回合的消息（没结果 = 在跑），自愈；
  //  - 后台子代理来自服务端的待投递表，是此刻的实况 —— 它跨回合存活，
  //    翻历史推不出来（见 collectAgents 的注释）。
  const agents = useMemo(() => {
    const fg = collectAgents(currentTurn(messages))
    const bg: SubAgent[] = backgroundAgents.map((label, i) => ({ id: `bg-${i}-${label}`, label, status: 'doing' }))
    return [...fg, ...bg]
  }, [messages, backgroundAgents])
  const running = agents.filter((a) => a.status === 'doing').length
  // 完成才消失: show only while a sub-agent is still running; once all have returned/failed,
  // the panel clears (their results remain on the inline tool cards in the chat).
  if (!running) return null
  const done = agents.filter((a) => a.status === 'done').length
  return (
    <div className="todos agents">
      <div className="th">
        <span>子代理</span>
        <span>{running > 0 ? `${running} 运行中 · ` : ''}{done} / {agents.length}</span>
      </div>
      {agents.map((a) => (
        <div key={a.id} className={'ti ag ' + a.status}>
          <AgentMarker status={a.status} />
          <span>{a.label}</span>
        </div>
      ))}
    </div>
  )
}
