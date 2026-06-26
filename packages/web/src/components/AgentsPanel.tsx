import { useMemo } from 'react'
import type { Message, Part } from '../state/types.js'

type AgentStatus = 'done' | 'doing' | 'failed'

interface SubAgent { id: string; label: string; status: AgentStatus }

/** True when a result is the immediate "launched in background" ack, not the real completion. */
function isBackgroundAck(output: string): boolean {
  return /launched in background/i.test(output)
}

/**
 * Collect every Agent (sub-agent) tool call across the conversation, pairing each with its
 * result by id. Status mirrors a todo list: no result yet → running; an error result → failed;
 * otherwise done. (A "launched in background" ack counts as still running.)
 */
export function collectAgents(messages: Message[]): SubAgent[] {
  const results = new Map<string, Extract<Part, { kind: 'tool-result' }>>()
  for (const m of messages) for (const p of m.parts) if (p.kind === 'tool-result') results.set(p.id, p)

  const out: SubAgent[] = []
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.kind !== 'tool-use' || p.name !== 'Agent') continue
      const inp = (p.input ?? {}) as { description?: unknown; prompt?: unknown }
      const label = (typeof inp.description === 'string' && inp.description) ||
        (typeof inp.prompt === 'string' ? inp.prompt : '') || 'sub-agent'
      const r = results.get(p.id)
      const status: AgentStatus = !r || isBackgroundAck(r.output) ? 'doing' : r.isError ? 'failed' : 'done'
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

/** Messages of the current turn: everything from the last user message onward. */
function currentTurn(messages: Message[]): Message[] {
  let start = 0
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'user') { start = i; break }
  return messages.slice(start)
}

export function AgentsPanel({ messages }: { messages: Message[] }) {
  // Scope to the current turn so finished turns' agents never linger alongside new ones.
  const agents = useMemo(() => collectAgents(currentTurn(messages)), [messages])
  const running = agents.filter((a) => a.status === 'doing').length
  // 完成才消失: show only while a sub-agent is still running; once all have returned/failed,
  // the panel clears (their results remain on the inline tool cards in the chat).
  if (!running) return null
  const done = agents.filter((a) => a.status === 'done').length
  return (
    <div className="todos agents">
      <div className="th">
        <span>Sub-agents</span>
        <span>{running > 0 ? `${running} running · ` : ''}{done} / {agents.length}</span>
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
