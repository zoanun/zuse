import { describe, it, expect } from 'vitest'
import { Semaphore, createWorkflow } from './workflow.js'
import { ToolRegistry } from './tool.js'
import type { ModelClient } from './model-client.js'
import type { StreamEvent, Usage, ResolvedSettings } from './types.js'

const USAGE: Usage = { input_tokens: 10, output_tokens: 5 }

function fakeClient(scripts: StreamEvent[][]): ModelClient {
  let i = 0
  return {
    getModel: () => 'fake',
    async *sendMessages() {
      const script = scripts[i++] ?? []
      for (const e of script) yield e
    },
  }
}

const PERMISSIVE: ResolvedSettings = {
  tools: {},
  permissions: { defaultMode: 'bypassPermissions', allow: [], ask: [], deny: [] },
  providers: {},
}

function makeCtx(client: ModelClient) {
  return {
    registry: new ToolRegistry(),
    getClient: () => client,
    settings: PERMISSIVE,
    getSystemPrompt: () => 'test',
    signal: new AbortController().signal,
    cwd: '.',
    tracker: { markRead() {}, getFingerprint: () => undefined },
  }
}

// ── Semaphore ────────────────────────────────────────────────────────

describe('Semaphore', () => {
  it('allows up to N concurrent acquisitions', async () => {
    const sem = new Semaphore(2)
    let active = 0
    let maxActive = 0

    const task = async () => {
      const release = await sem.acquire()
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 10))
      active--
      release()
    }

    await Promise.all([task(), task(), task(), task()])
    expect(maxActive).toBe(2)
  })

  it('processes in FIFO order', async () => {
    const sem = new Semaphore(1)
    const order: number[] = []

    const task = async (id: number) => {
      const release = await sem.acquire()
      order.push(id)
      release()
    }

    await Promise.all([task(1), task(2), task(3)])
    expect(order).toEqual([1, 2, 3])
  })
})

// ── parallel ─────────────────────────────────────────────────────────

describe('parallel', () => {
  it('runs thunks concurrently and returns all results', async () => {
    const wf = createWorkflow(makeCtx(fakeClient([])))

    const results = await wf.parallel([
      () => Promise.resolve('a'),
      () => Promise.resolve('b'),
      () => Promise.resolve('c'),
    ])

    expect(results).toEqual(['a', 'b', 'c'])
  })

  it('returns null for failed thunks without affecting others', async () => {
    const wf = createWorkflow(makeCtx(fakeClient([])))

    const results = await wf.parallel([
      () => Promise.resolve('ok'),
      () => Promise.reject(new Error('boom')),
      () => Promise.resolve('also ok'),
    ])

    expect(results).toEqual(['ok', null, 'also ok'])
  })

  it('respects agent concurrency limit via semaphore', async () => {
    let active = 0
    let maxActive = 0
    const client: ModelClient = {
      getModel: () => 'fake',
      async *sendMessages() {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 20))
        active--
        yield { type: 'text-delta' as const, text: 'ok' }
        yield { type: 'message-stop' as const, stop_reason: 'end_turn', usage: USAGE }
      },
    }
    const wf = createWorkflow({ ...makeCtx(client), concurrency: 2 })

    await wf.parallel([
      () => wf.agent('a'),
      () => wf.agent('b'),
      () => wf.agent('c'),
      () => wf.agent('d'),
    ])
    expect(maxActive).toBe(2)
  })
})

// ── pipeline ─────────────────────────────────────────────────────────

describe('pipeline', () => {
  it('chains stages per item', async () => {
    const wf = createWorkflow(makeCtx(fakeClient([])))

    const results = await wf.pipeline(
      [1, 2, 3],
      async (n) => n * 10,
      async (n) => `result:${n}`,
    )

    expect(results).toEqual(['result:10', 'result:20', 'result:30'])
  })

  it('passes originalItem and index to later stages', async () => {
    const wf = createWorkflow(makeCtx(fakeClient([])))

    const results = await wf.pipeline(
      ['a', 'b'],
      async (item) => item.toUpperCase(),
      async (prev, orig, idx) => `${prev}-${orig}-${idx}`,
    )

    expect(results).toEqual(['A-a-0', 'B-b-1'])
  })

  it('skips remaining stages on error, returns null for that item', async () => {
    const wf = createWorkflow(makeCtx(fakeClient([])))
    const stage2Calls: number[] = []

    const results = await wf.pipeline(
      [1, 2, 3],
      async (n) => {
        if (n === 2) throw new Error('fail')
        return n * 10
      },
      async (n, _orig, idx) => {
        stage2Calls.push(idx)
        return n + 1
      },
    )

    expect(results).toEqual([11, null, 31])
    expect(stage2Calls).toEqual([0, 2])
  })

  it('runs items concurrently (no inter-item barrier)', async () => {
    const wf = createWorkflow(makeCtx(fakeClient([])))
    const order: string[] = []

    let item2Stage1Resolve!: () => void
    const item2Stage1 = new Promise<void>((r) => { item2Stage1Resolve = r })

    const results = await wf.pipeline(
      ['fast', 'slow'],
      async (item) => {
        if (item === 'slow') await item2Stage1
        order.push(`s1:${item}`)
        return item
      },
      async (item) => {
        order.push(`s2:${item}`)
        if (item === 'fast') item2Stage1Resolve()
        return item
      },
    )

    expect(results).toEqual(['fast', 'slow'])
    expect(order.indexOf('s2:fast')).toBeLessThan(order.indexOf('s1:slow'))
  })
})

// ── agent ────────────────────────────────────────────────────────────

describe('workflow agent', () => {
  it('runs a sub-agent and returns final text', async () => {
    const client = fakeClient([
      [
        { type: 'text-delta', text: 'hello from sub' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
      ],
    ])
    const wf = createWorkflow(makeCtx(client))

    const result = await wf.agent('do something')
    expect(result).toBe('hello from sub')
  })

  it('returns null when sub-agent produces no text', async () => {
    const client = fakeClient([
      [{ type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }],
    ])
    const wf = createWorkflow(makeCtx(client))

    const result = await wf.agent('do something')
    expect(result).toBeNull()
  })

  it('returns null on error', async () => {
    const client = fakeClient([
      [{ type: 'error', message: 'boom' }],
    ])
    const wf = createWorkflow(makeCtx(client))

    const result = await wf.agent('do something')
    expect(result).toBeNull()
  })
})

// ── maxAgents ────────────────────────────────────────────────────────

describe('maxAgents', () => {
  it('caps total agent calls — excess return null via parallel', async () => {
    const client = fakeClient(
      Array.from({ length: 5 }, () => [
        { type: 'text-delta' as const, text: 'ok' },
        { type: 'message-stop' as const, stop_reason: 'end_turn', usage: USAGE },
      ]),
    )
    const wf = createWorkflow({ ...makeCtx(client), maxAgents: 3 })

    const results = await wf.parallel([
      () => wf.agent('a'),
      () => wf.agent('b'),
      () => wf.agent('c'),
      () => wf.agent('d'),
      () => wf.agent('e'),
    ])

    const nonNull = results.filter(Boolean)
    expect(nonNull).toHaveLength(3)
    const nulls = results.filter((r) => r === null)
    expect(nulls).toHaveLength(2)
  })
})
