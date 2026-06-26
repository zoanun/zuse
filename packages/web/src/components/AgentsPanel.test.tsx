import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AgentsPanel, collectAgents } from './AgentsPanel.js'
import type { Message } from '../state/types.js'

const msg = (parts: Message['parts']): Message => ({ id: 'm', role: 'assistant', parts })

const agentUse = (id: string, description: string) =>
  ({ kind: 'tool-use', id, name: 'Agent', input: { description, prompt: 'do the thing' } }) as const
const toolResult = (id: string, output: string, isError = false) =>
  ({ kind: 'tool-result', id, name: 'Agent', output, isError }) as const

describe('collectAgents', () => {
  it('marks an Agent with no result as running (doing)', () => {
    const agents = collectAgents([msg([agentUse('a1', 'scan logs')])])
    expect(agents).toEqual([{ id: 'a1', label: 'scan logs', status: 'doing' }])
  })

  it('marks an Agent with a result as done, and an error result as failed', () => {
    const agents = collectAgents([
      msg([agentUse('a1', 'ok one'), toolResult('a1', 'all good')]),
      msg([agentUse('a2', 'bad one'), toolResult('a2', 'boom', true)]),
    ])
    expect(agents.find((a) => a.id === 'a1')!.status).toBe('done')
    expect(agents.find((a) => a.id === 'a2')!.status).toBe('failed')
  })

  it('treats a "launched in background" ack as still running', () => {
    const agents = collectAgents([msg([
      agentUse('a1', 'bg task'),
      toolResult('a1', 'Sub-agent "bg task" launched in background. You will be notified when it finishes.'),
    ])])
    expect(agents[0]!.status).toBe('doing')
  })

  it('pairs result by id even when batched (use, use, result, result)', () => {
    const agents = collectAgents([msg([
      agentUse('a1', 'one'), agentUse('a2', 'two'),
      toolResult('a1', 'done one'), toolResult('a2', 'done two'),
    ])])
    expect(agents.map((a) => a.status)).toEqual(['done', 'done'])
  })

  it('ignores non-Agent tool calls', () => {
    const agents = collectAgents([msg([
      { kind: 'tool-use', id: 'b1', name: 'Bash', input: { command: 'ls' } },
    ])])
    expect(agents).toEqual([])
  })
})

const userMsg = (text: string): Message => ({ id: 'u', role: 'user', parts: [{ kind: 'text', text }] })

describe('AgentsPanel', () => {
  it('renders nothing when there are no sub-agents', () => {
    const { container } = render(<AgentsPanel messages={[msg([{ kind: 'text', text: 'hi' }])]} />)
    expect(container.querySelector('.agents')).toBeNull()
  })

  it('hides once every sub-agent has returned or failed (none running)', () => {
    const { container } = render(<AgentsPanel messages={[
      msg([agentUse('a1', 'done one'), toolResult('a1', 'ok')]),
      msg([agentUse('a2', 'failed one'), toolResult('a2', 'boom', true)]),
    ]} />)
    expect(container.querySelector('.agents')).toBeNull()
  })

  it('shows only the current turn (agents from a prior turn do not linger)', () => {
    const { container } = render(<AgentsPanel messages={[
      // prior turn: a settled agent
      msg([agentUse('old', 'old one'), toolResult('old', 'ok')]),
      userMsg('next question'),
      // current turn: one still running
      msg([agentUse('new', 'new one')]),
    ]} />)
    expect(screen.getByText('new one')).toBeInTheDocument()
    expect(screen.queryByText('old one')).toBeNull()
    expect(container.querySelector('.th')?.textContent).toContain('0 / 1')
  })

  it('lists sub-agents with a done/total count', () => {
    const { container } = render(<AgentsPanel messages={[
      msg([agentUse('a1', 'finished one'), toolResult('a1', 'ok')]),
      msg([agentUse('a2', 'still running')]),
    ]} />)
    expect(screen.getByText('finished one')).toBeInTheDocument()
    expect(screen.getByText('still running')).toBeInTheDocument()
    // header shows the running count and the done/total tally
    expect(screen.getByText(/1 running · 1 \/ 2/)).toBeInTheDocument()
    // a returned agent gets the green check; a waiting one the pulsing run dot
    expect(container.querySelector('.ti.ag.done .ag-mark.ag-done')).not.toBeNull()
    expect(container.querySelector('.ti.ag.doing .ag-mark.ag-run')).not.toBeNull()
  })
})
