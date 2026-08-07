import { describe, it, expect } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { AgentsPanel, collectAgents, runningAgentCount } from './AgentsPanel.js'
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

  // 这条曾经断言 ack 算「仍在运行」—— 那正是让面板永久卡在「1 运行中」的原因：
  // 后台子代理的完成通知是一条普通用户消息、不是该 tool-use 的结果，所以这个状态
  // 永远等不到翻面；被停止取消掉的那些连通知都不会有。而它源自已落盘的历史，刷新也去不掉。
  // 现在 ack = 工具已返回（done），在飞与否由服务端的待投递表说了算。
  it("后台派发不进前台表（它的在飞状态由服务端给，混进来会重复显示）", () => {
    const agents = collectAgents([msg([
      { kind: 'tool-use', id: 'a1', name: 'Agent', input: { description: 'bg task', prompt: 'p', runInBackground: true } },
      toolResult('a1', 'Sub-agent "bg task" launched in background. You will be notified when it finishes.'),
    ])])
    expect(agents).toEqual([])
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

  it('a mid-turn steer bubble does not drop the still-running sub-agents from the panel', () => {
    const { container } = render(<AgentsPanel messages={[
      userMsg('spawn some agents'),
      msg([agentUse('a1', 'running agent')]),                     // launched this turn, still running
      { id: 's1', role: 'user', parts: [{ kind: 'text', text: 'also do X' }], steer: true }, // interjection
    ]} />)
    // The steer bubble is NOT the turn opener, so the agent launched before it stays in scope.
    expect(screen.getByText('running agent')).toBeInTheDocument()
    expect(container.querySelector('.agents')).not.toBeNull()
  })

  it('lists sub-agents with a done/total count', () => {
    const { container } = render(<AgentsPanel messages={[
      msg([agentUse('a1', 'finished one'), toolResult('a1', 'ok')]),
      msg([agentUse('a2', 'still running')]),
    ]} />)
    expect(screen.getByText('finished one')).toBeInTheDocument()
    expect(screen.getByText('still running')).toBeInTheDocument()
    // header shows the running count and the done/total tally
    expect(screen.getByText(/1 运行中 · 1 \/ 2/)).toBeInTheDocument()
    // a returned agent gets the green check; a waiting one the pulsing run dot
    expect(container.querySelector('.ti.ag.done .ag-mark.ag-done')).not.toBeNull()
    expect(container.querySelector('.ti.ag.doing .ag-mark.ag-run')).not.toBeNull()
  })
})

/**
 * 后台子代理的在飞状态来自服务端（AppState.backgroundAgents ← SessionSnapshot），
 * 不从消息历史推断。这一组钉的就是这个数据源 —— 用户报过一个「面板永久显示 1 运行中、
 * 刷新也去不掉」的会话，成因正是拿历史里的 ack 当在飞。
 */
describe('AgentsPanel —— 后台子代理来自服务端', () => {
  const ackMsg = msg([
    { kind: 'tool-use', id: 'a1', name: 'Agent', input: { description: '慢活', prompt: 'p', runInBackground: true } },
    toolResult('a1', 'Sub-agent "慢活" launched in background. You will be notified when it finishes.'),
  ])

  it('服务端说还在跑 → 显示它', () => {
    render(<AgentsPanel messages={[ackMsg]} backgroundAgents={['慢活']} />)
    expect(screen.getByText('慢活')).toBeInTheDocument()
    expect(screen.getByText(/1 运行中/)).toBeInTheDocument()
  })

  it('服务端说没有在飞的 → 面板整个消失（哪怕历史里那条 ack 还在）', () => {
    const { container } = render(<AgentsPanel messages={[ackMsg]} backgroundAgents={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('省略该 prop 时按「没有在飞的」处理，不会凭历史臆造一个运行中', () => {
    const { container } = render(<AgentsPanel messages={[ackMsg]} />)
    expect(container.firstChild).toBeNull()
  })
})

/**
 * 谓词与组件必须**永远同答案**（设计 §8）。
 *
 * 右栏的显示条件调用 `runningAgentCount`，面板自己 `if (!running) return null` 也走
 * 同一条链路（turnAgents → countRunning）。这条测试是那份「同一个真相」的锁。
 *
 * 为什么非得是**这个**谓词、不许在 Shell 里现写一个：判据里藏着两条踩过坑的规则 ——
 * `currentTurn` 的回合切分（插话不是回合开头，否则本回合早先派出的子代理会被切丢），
 * 以及 collectAgents 的「后台派发跳过」（拿历史里那句 ack 当在飞，就是「永久卡在 1 运行中」
 * 那个真实故障）。复刻一份等于把故障请回来，而这里会立刻变红。
 */
describe('runningAgentCount —— 谓词与组件渲染结果一致', () => {
  const cases: Array<{ name: string; messages: Message[]; bg?: string[] }> = [
    { name: '没有子代理', messages: [msg([{ kind: 'text', text: 'hi' }])] },
    { name: '一个在跑', messages: [msg([agentUse('a1', 'running one')])] },
    { name: '全部已返回', messages: [msg([agentUse('a1', 'x'), toolResult('a1', 'ok')])] },
    { name: '全部已失败', messages: [msg([agentUse('a1', 'x'), toolResult('a1', 'boom', true)])] },
    { name: '一个返回一个在跑', messages: [msg([agentUse('a1', 'x'), toolResult('a1', 'ok'), agentUse('a2', 'y')])] },
    {
      name: '上一回合在跑的不算（回合切分）',
      messages: [msg([agentUse('old', 'old one')]), userMsg('next'), msg([{ kind: 'text', text: 'hi' }])],
    },
    {
      name: '插话不切回合，本回合在跑的还算',
      messages: [
        userMsg('go'), msg([agentUse('a1', 'running one')]),
        { id: 's1', role: 'user', parts: [{ kind: 'text', text: 'also X' }], steer: true },
      ],
    },
    {
      name: '后台派发的 ack 不算在跑（服务端说没有在飞的）',
      messages: [msg([
        { kind: 'tool-use', id: 'b1', name: 'Agent', input: { description: 'bg', prompt: 'p', runInBackground: true } },
        toolResult('b1', 'launched in background'),
      ])],
      bg: [],
    },
    {
      name: '后台在飞由服务端给 → 算在跑',
      messages: [msg([
        { kind: 'tool-use', id: 'b1', name: 'Agent', input: { description: 'bg', prompt: 'p', runInBackground: true } },
        toolResult('b1', 'launched in background'),
      ])],
      bg: ['bg'],
    },
  ]
  for (const c of cases) {
    it(c.name, () => {
      const n = runningAgentCount(c.messages, c.bg ?? [])
      const { container } = render(<AgentsPanel messages={c.messages} backgroundAgents={c.bg ?? []} />)
      expect(container.querySelector('.agents') !== null).toBe(n > 0)
      // 反向钉死：谓词报的数就是面板头上那个「N 运行中」，两边不许各算各的。
      if (n > 0) expect(container.querySelector('.th')!.textContent).toContain(`${n} 运行中`)
      cleanup()
    })
  }
})
