import { describe, it, expect } from 'vitest'
import { Conversation } from './conversation.js'
import type { Message, StreamEvent, Usage } from './types.js'
import type { ModelClient } from './model-client.js'
import {
  findCompactionCut,
  findCompactionCutByBudget,
  estimateCompactionSavings,
  buildSummaryPrompt,
  buildIterativeSummaryPrompt,
  extractPreviousSummary,
  applyCompaction,
  summarizeForCompaction,
  splitMemoryCandidates,
  resolveContextWindow,
  DEFAULT_CONTEXT_WINDOW,
} from './compaction.js'

const USAGE: Usage = { input_tokens: 10, output_tokens: 5 }

function user(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] }
}
function assistant(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}
function toolUse(id: string): Message {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'a.ts' } }] }
}
function toolResult(id: string, content = 'ok'): Message {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }
}

describe('splitMemoryCandidates(压缩前记忆冲刷)', () => {
  it('拆出 MEMORY 行入候选,摘要剥掉这些行', () => {
    const raw = '1. 目标:重构\n2. 决策:用 sqlite\nMEMORY: user|偏好中文|用户永远用中文交流\nMEMORY: project|用 pnpm|本项目用 pnpm 不用 npm'
    const { summary, candidates } = splitMemoryCandidates(raw)
    expect(candidates).toEqual([
      { type: 'user', hook: '偏好中文', content: '用户永远用中文交流' },
      { type: 'project', hook: '用 pnpm', content: '本项目用 pnpm 不用 npm' },
    ])
    expect(summary).not.toContain('MEMORY:')
    expect(summary).toContain('决策:用 sqlite')
  })

  it('无 MEMORY 行时摘要原样、候选为空', () => {
    const { summary, candidates } = splitMemoryCandidates('普通摘要\n第二行')
    expect(candidates).toEqual([])
    expect(summary).toBe('普通摘要\n第二行')
  })

  it('超出 cap(3)的候选丢弃,且所有 MEMORY 行都从摘要剥掉', () => {
    const raw = ['MEMORY: user|a|A', 'MEMORY: user|b|B', 'MEMORY: user|c|C', 'MEMORY: user|d|D'].join('\n')
    const { summary, candidates } = splitMemoryCandidates(raw)
    expect(candidates).toHaveLength(3)
    expect(summary).toBe('')
  })

  it('格式不匹配的行原样保留(坏 type、缺竖线)', () => {
    const raw = 'MEMORY: banana|x|y\nMEMORY: user|缺内容段'
    const { summary, candidates } = splitMemoryCandidates(raw)
    expect(candidates).toEqual([])
    expect(summary).toContain('banana')
  })

  it('buildSummaryPrompt 含 MEMORY 行格式指令', () => {
    const prompt = buildSummaryPrompt([user('hi')])
    expect(prompt).toContain('MEMORY: <type>|')
  })
})

describe('findCompactionCut', () => {
  it('cuts at the keepTurns-th real user turn from the end', () => {
    const msgs = [user('一'), assistant('a'), user('二'), assistant('b'), user('三'), assistant('c')]
    // keep 2 → 保留段从「二」开始(index 2),摘要段 = [一, a]。
    expect(findCompactionCut(msgs, 2)).toBe(2)
  })

  it('does not treat tool_result feedback as a user turn start', () => {
    const msgs = [
      user('一'),
      toolUse('t1'),
      toolResult('t1'),
      assistant('a'),
      user('二'),
      assistant('b'),
      user('三'),
      assistant('c'),
    ]
    // tool_result(index 2)是回填不是用户回合;keep 2 → 切在「二」(index 4),
    // 「一」的整个 tool 往返完整落入摘要段,不会从配对中间劈开。
    expect(findCompactionCut(msgs, 2)).toBe(4)
  })

  it('returns null when there is nothing before the kept turns', () => {
    const msgs = [user('一'), assistant('a'), user('二'), assistant('b')]
    expect(findCompactionCut(msgs, 2)).toBeNull()
  })

  it('returns null for an empty conversation', () => {
    expect(findCompactionCut([], 2)).toBeNull()
  })
})

describe('buildSummaryPrompt', () => {
  it('renders roles and texts, and truncates bulky tool results', () => {
    const msgs = [
      user('帮我修 bug'),
      toolUse('t1'),
      toolResult('t1', 'x'.repeat(5000)),
      assistant('修好了'),
    ]
    const prompt = buildSummaryPrompt(msgs)
    expect(prompt).toContain('帮我修 bug')
    expect(prompt).toContain('修好了')
    expect(prompt).toContain('Read')
    expect(prompt).not.toContain('x'.repeat(1000)) // 5000 字的工具输出被截
    expect(prompt).toContain('Pending Items') // summary instruction includes the structured template
  })
})

describe('applyCompaction', () => {
  it('replaces the summarized span with one summary message and keeps the tail verbatim', () => {
    const conv = new Conversation()
    const msgs = [user('一'), assistant('a'), user('二'), assistant('b'), user('三'), assistant('c')]
    for (const m of msgs) conv.append(m)
    conv.addUsage(USAGE)

    const next = applyCompaction(conv, '这是摘要', 2)
    const out = next.getMessages()
    expect(out).toHaveLength(5) // 摘要 1 条 + 保留 4 条
    expect(out[0]!.role).toBe('user')
    const first = out[0]!.content[0]!
    expect(first.type === 'text' && first.text).toContain('这是摘要')
    expect(out.slice(1)).toEqual(msgs.slice(2))
    // 用量是成本账不是窗口账:不清零。
    expect(next.totalUsage).toEqual(conv.totalUsage)
  })
})

describe('summarizeForCompaction', () => {
  function fakeClient(events: StreamEvent[]): ModelClient {
    return {
      getModel: () => 'fake',
      async *sendMessages() {
        for (const e of events) yield e
      },
    }
  }

  it('collects streamed text into a summary', async () => {
    const client = fakeClient([
      { type: 'text-delta', text: '摘要前半' },
      { type: 'text-delta', text: ',后半' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
    ])
    const text = await summarizeForCompaction(client, [user('一'), assistant('a')], {
      model: 'fake',
      max_tokens: 100,
    })
    expect(text).toBe('摘要前半,后半')
  })

  it('falls back to deterministic summary on error event', async () => {
    const client = fakeClient([
      { type: 'text-delta', text: '半截' },
      { type: 'error', message: 'boom' },
    ])
    const text = await summarizeForCompaction(client, [user('一')], { model: 'fake', max_tokens: 100 })
    expect(text).toContain('Deterministic fallback summary')
    expect(text).toContain('Active Task')
  })

  it('falls back to deterministic summary when model returns no text', async () => {
    const client = fakeClient([{ type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }])
    const text = await summarizeForCompaction(client, [user('一')], { model: 'fake', max_tokens: 100 })
    expect(text).toContain('Deterministic fallback summary')
  })
})

describe('resolveContextWindow', () => {
  const settings = (providers: Record<string, unknown>): import('./types.js').ResolvedSettings =>
    ({
      tools: {},
      permissions: { defaultMode: 'default', allow: [], ask: [], deny: [] },
      providers,
    }) as import('./types.js').ResolvedSettings

  it('model-level entry wins over provider-level contextWindow', () => {
    const s = settings({
      dashscope: {
        contextWindow: 131072,
        models: ['qwen3-coder', { name: 'qwen3.7-max', contextWindow: 1000000 }],
      },
    })
    expect(resolveContextWindow(s, 'dashscope', 'qwen3.7-max')).toBe(1000000)
  })

  it('string entries fall back to the provider-level contextWindow', () => {
    const s = settings({
      dashscope: { contextWindow: 131072, models: ['qwen3-coder'] },
    })
    expect(resolveContextWindow(s, 'dashscope', 'qwen3-coder')).toBe(131072)
  })

  it('falls back to the global default when nothing is configured', () => {
    const s = settings({ deepseek: { models: ['deepseek-chat'] } })
    expect(resolveContextWindow(s, 'deepseek', 'deepseek-chat')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(resolveContextWindow(s, 'unknown-provider', 'whatever')).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  it('default is 512K (mainstream flagships are 1M-class in 2026)', () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(512_000)
  })
})

describe('findCompactionCutByBudget', () => {
  it('returns null when all messages fit within budget', () => {
    const msgs = [user('hi'), assistant('hello')]
    expect(findCompactionCutByBudget(msgs, 10000)).toBeNull()
  })

  it('keeps recent messages within budget and compresses old ones', () => {
    const msgs = [
      user('old message 1'),
      assistant('old response 1'),
      user('old message 2'),
      assistant('old response 2'),
      user('recent message'),
      assistant('recent response'),
    ]
    // Budget of 50 chars — should keep only the last few messages
    const cut = findCompactionCutByBudget(msgs, 50)
    expect(cut).not.toBeNull()
    expect(cut!).toBeGreaterThan(0)
    expect(cut!).toBeLessThan(msgs.length)
  })

  it('always protects at least MIN_TAIL_MESSAGES', () => {
    const msgs = [
      user('a'), assistant('b'),
      user('c'), assistant('d'),
      user('e'), assistant('f'),
    ]
    // Very tiny budget — should still keep MIN_TAIL_MESSAGES
    const cut = findCompactionCutByBudget(msgs, 1)
    expect(cut).not.toBeNull()
    // Should keep at least 3 messages
    expect(msgs.length - cut!).toBeGreaterThanOrEqual(3)
  })
})

describe('estimateCompactionSavings', () => {
  it('calculates savings ratio', () => {
    const msgs = [
      user('a'.repeat(1000)),
      assistant('b'.repeat(1000)),
      user('recent'),
    ]
    const { savingsRatio } = estimateCompactionSavings(msgs, 2, 200)
    expect(savingsRatio).toBeGreaterThan(0.5)
  })
})

describe('extractPreviousSummary', () => {
  it('returns null for empty messages', () => {
    expect(extractPreviousSummary([])).toBeNull()
  })

  it('returns null for non-compacted first message', () => {
    expect(extractPreviousSummary([user('hello')])).toBeNull()
  })

  it('extracts summary from compacted first message', () => {
    const compacted: Message = {
      role: 'user',
      content: [{ type: 'text', text: '[CONTEXT COMPACTION — REFERENCE ONLY] ...\nSome summary\n\n--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---' }],
    }
    const result = extractPreviousSummary([compacted])
    expect(result).toContain('Some summary')
    expect(result).not.toContain('END OF CONTEXT SUMMARY')
  })

  it('returns full text when end marker is missing', () => {
    const compacted: Message = {
      role: 'user',
      content: [{ type: 'text', text: '[CONTEXT COMPACTION — REFERENCE ONLY] ...\nSome summary without end marker' }],
    }
    const result = extractPreviousSummary([compacted])
    expect(result).toContain('Some summary without end marker')
  })

  it('returns null when first message is from assistant', () => {
    expect(extractPreviousSummary([assistant('hello')])).toBeNull()
  })
})

describe('buildIterativeSummaryPrompt', () => {
  it('includes previous summary and new transcript', () => {
    const prompt = buildIterativeSummaryPrompt('Old summary here', [user('new question'), assistant('new answer')])
    expect(prompt).toContain('PREVIOUS SUMMARY:')
    expect(prompt).toContain('Old summary here')
    expect(prompt).toContain('NEW TURNS TO INCORPORATE:')
    expect(prompt).toContain('new question')
    expect(prompt).toContain('PRESERVE all existing information')
  })

  it('includes MEMORY format instructions', () => {
    const prompt = buildIterativeSummaryPrompt('summary', [user('hi')])
    expect(prompt).toContain('MEMORY: <type>|')
  })

  it('includes temporal anchoring', () => {
    const prompt = buildIterativeSummaryPrompt('summary', [user('hi')])
    expect(prompt).toContain('TEMPORAL ANCHORING:')
  })
})
