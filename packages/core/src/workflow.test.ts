import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { Semaphore, createWorkflow, computeAgentHash } from './workflow.js'
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

// ── token budget ─────────────────────────────────────────────────────

describe('token budget', () => {
  it('tracks spent tokens and exposes budget API', async () => {
    const client = fakeClient([
      [
        { type: 'text-delta', text: 'ok' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: { ...USAGE, output_tokens: 100 } },
      ],
    ])
    const wf = createWorkflow({ ...makeCtx(client), tokenBudget: 500 })

    expect(wf.budget.total).toBe(500)
    expect(wf.budget.spent()).toBe(0)
    expect(wf.budget.remaining()).toBe(500)

    await wf.agent('task')

    expect(wf.budget.spent()).toBe(100)
    expect(wf.budget.remaining()).toBe(400)
  })

  it('stops agents when budget exhausted (sequential)', async () => {
    const client = fakeClient(
      Array.from({ length: 5 }, () => [
        { type: 'text-delta' as const, text: 'ok' },
        { type: 'message-stop' as const, stop_reason: 'end_turn', usage: { ...USAGE, output_tokens: 50 } },
      ]),
    )
    const wf = createWorkflow({ ...makeCtx(client), tokenBudget: 120 })

    const r1 = await wf.agent('a')
    expect(r1).toBe('ok')
    expect(wf.budget.spent()).toBe(50)

    const r2 = await wf.agent('b')
    expect(r2).toBe('ok')
    expect(wf.budget.spent()).toBe(100)

    const r3 = await wf.agent('c')
    expect(r3).toBe('ok')
    expect(wf.budget.spent()).toBe(150)

    // Budget exhausted — direct call throws, parallel catches as null
    const [r4] = await wf.parallel([() => wf.agent('d')])
    expect(r4).toBeNull()
  })

  it('returns parsed JSON when schema is provided', async () => {
    const client = fakeClient([
      [
        { type: 'text-delta', text: '{"name": "test", "count": 42}' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
      ],
    ])
    const wf = createWorkflow(makeCtx(client))

    const result = await wf.agent('extract data', {
      schema: { type: 'object', properties: { name: { type: 'string' }, count: { type: 'number' } } },
    })

    expect(result).toEqual({ name: 'test', count: 42 })
  })

  it('strips markdown fences from schema response', async () => {
    const client = fakeClient([
      [
        { type: 'text-delta', text: '```json\n{"ok": true}\n```' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
      ],
    ])
    const wf = createWorkflow(makeCtx(client))

    const result = await wf.agent('test', { schema: { type: 'object' } })
    expect(result).toEqual({ ok: true })
  })

  it('returns null for invalid JSON when schema is provided', async () => {
    const client = fakeClient([
      [
        { type: 'text-delta', text: 'not json at all' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
      ],
    ])
    const wf = createWorkflow(makeCtx(client))

    const result = await wf.agent('test', { schema: { type: 'object' } })
    expect(result).toBeNull()
  })

  it('returns Infinity remaining when no budget set', async () => {
    const wf = createWorkflow(makeCtx(fakeClient([])))
    expect(wf.budget.total).toBeNull()
    expect(wf.budget.remaining()).toBe(Infinity)
  })
})

// ── Journal Resume ──────────────────────────────────────────────────

function makeTmpJournalDir(): string {
  const dir = join(tmpdir(), `zuse-test-journal-${randomBytes(4).toString('hex')}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('workflow resume (journal)', () => {
  it('returns runId from createWorkflow', () => {
    const wf = createWorkflow(makeCtx(fakeClient([])))
    expect(wf.runId).toMatch(/^wf_[0-9a-f]{12}$/)
  })

  it('persists agent results to journal file', async () => {
    const journalDir = makeTmpJournalDir()
    try {
      const client = fakeClient([
        [
          { type: 'text-delta', text: 'result-a' },
          { type: 'message-stop', stop_reason: 'end_turn', usage: { ...USAGE, output_tokens: 50 } },
        ],
        [
          { type: 'text-delta', text: 'result-b' },
          { type: 'message-stop', stop_reason: 'end_turn', usage: { ...USAGE, output_tokens: 30 } },
        ],
      ])
      const wf = createWorkflow({ ...makeCtx(client), journalDir })

      await wf.agent('task-a')
      await wf.agent('task-b')

      const journalPath = join(journalDir, `${wf.runId}.jsonl`)
      const lines = readFileSync(journalPath, 'utf-8').trim().split('\n')
      expect(lines).toHaveLength(2)

      const entry0 = JSON.parse(lines[0])
      expect(entry0.prompt).toBe('task-a')
      expect(entry0.result).toBe('result-a')
      expect(entry0.tokens).toBe(50)

      const entry1 = JSON.parse(lines[1])
      expect(entry1.prompt).toBe('task-b')
      expect(entry1.result).toBe('result-b')
      expect(entry1.tokens).toBe(30)
    } finally {
      rmSync(journalDir, { recursive: true, force: true })
    }
  })

  it('resumes from previous journal — matching calls return cached results', async () => {
    const journalDir = makeTmpJournalDir()
    try {
      // First run: execute 2 agent calls
      const client1 = fakeClient([
        [
          { type: 'text-delta', text: 'original-a' },
          { type: 'message-stop', stop_reason: 'end_turn', usage: { ...USAGE, output_tokens: 40 } },
        ],
        [
          { type: 'text-delta', text: 'original-b' },
          { type: 'message-stop', stop_reason: 'end_turn', usage: { ...USAGE, output_tokens: 60 } },
        ],
      ])
      const wf1 = createWorkflow({ ...makeCtx(client1), journalDir })
      await wf1.agent('task-a')
      await wf1.agent('task-b')

      // Second run: resume — client should NOT be called (no scripts needed)
      let clientCalled = false
      const client2: ModelClient = {
        getModel: () => 'fake',
        async *sendMessages() {
          clientCalled = true
          yield { type: 'text-delta' as const, text: 'should-not-appear' }
          yield { type: 'message-stop' as const, stop_reason: 'end_turn', usage: USAGE }
        },
      }
      const wf2 = createWorkflow({ ...makeCtx(client2), journalDir, resumeFromRunId: wf1.runId })

      const r1 = await wf2.agent('task-a')
      const r2 = await wf2.agent('task-b')

      expect(r1).toBe('original-a')
      expect(r2).toBe('original-b')
      expect(clientCalled).toBe(false)
      expect(wf2.budget.spent()).toBe(100) // 40 + 60 from cached tokens
    } finally {
      rmSync(journalDir, { recursive: true, force: true })
    }
  })

  it('invalidates from changed prompt onward — re-executes changed + subsequent calls', async () => {
    const journalDir = makeTmpJournalDir()
    try {
      // First run: 3 calls
      const client1 = fakeClient([
        [
          { type: 'text-delta', text: 'res-1' },
          { type: 'message-stop', stop_reason: 'end_turn', usage: { ...USAGE, output_tokens: 10 } },
        ],
        [
          { type: 'text-delta', text: 'res-2' },
          { type: 'message-stop', stop_reason: 'end_turn', usage: { ...USAGE, output_tokens: 20 } },
        ],
        [
          { type: 'text-delta', text: 'res-3' },
          { type: 'message-stop', stop_reason: 'end_turn', usage: { ...USAGE, output_tokens: 30 } },
        ],
      ])
      const wf1 = createWorkflow({ ...makeCtx(client1), journalDir })
      await wf1.agent('task-1')
      await wf1.agent('task-2')
      await wf1.agent('task-3')

      // Second run: same first call, CHANGED second call → 2nd & 3rd re-execute
      const executedPrompts: string[] = []
      const client2: ModelClient = {
        getModel: () => 'fake',
        async *sendMessages() {
          executedPrompts.push('executed')
          yield { type: 'text-delta' as const, text: 'new-result' }
          yield { type: 'message-stop' as const, stop_reason: 'end_turn', usage: { ...USAGE, output_tokens: 5 } }
        },
      }
      const wf2 = createWorkflow({ ...makeCtx(client2), journalDir, resumeFromRunId: wf1.runId })

      const r1 = await wf2.agent('task-1')           // matches → cached
      const r2 = await wf2.agent('task-2-CHANGED')   // hash differs → re-execute
      const r3 = await wf2.agent('task-3')            // after mismatch → re-execute (sequential invalidation)

      expect(r1).toBe('res-1')     // cached
      expect(r2).toBe('new-result') // re-executed
      expect(r3).toBe('new-result') // re-executed (hash matches but position after mismatch)
      expect(executedPrompts).toHaveLength(2)
    } finally {
      rmSync(journalDir, { recursive: true, force: true })
    }
  })

  it('new calls beyond journal length execute normally', async () => {
    const journalDir = makeTmpJournalDir()
    try {
      // First run: 1 call
      const client1 = fakeClient([
        [
          { type: 'text-delta', text: 'cached' },
          { type: 'message-stop', stop_reason: 'end_turn', usage: { ...USAGE, output_tokens: 10 } },
        ],
      ])
      const wf1 = createWorkflow({ ...makeCtx(client1), journalDir })
      await wf1.agent('existing')

      // Second run: resume + add a new call
      const client2 = fakeClient([
        [
          { type: 'text-delta', text: 'fresh' },
          { type: 'message-stop', stop_reason: 'end_turn', usage: { ...USAGE, output_tokens: 20 } },
        ],
      ])
      const wf2 = createWorkflow({ ...makeCtx(client2), journalDir, resumeFromRunId: wf1.runId })

      const r1 = await wf2.agent('existing')  // cached
      const r2 = await wf2.agent('brand-new') // beyond journal → execute

      expect(r1).toBe('cached')
      expect(r2).toBe('fresh')
    } finally {
      rmSync(journalDir, { recursive: true, force: true })
    }
  })

  it('computeAgentHash produces stable, distinct hashes', () => {
    const h1 = computeAgentHash('prompt-a')
    const h2 = computeAgentHash('prompt-a')
    const h3 = computeAgentHash('prompt-b')
    const h4 = computeAgentHash('prompt-a', { label: 'x' })

    expect(h1).toBe(h2) // same input → same hash
    expect(h1).not.toBe(h3) // different prompt → different hash
    expect(h1).not.toBe(h4) // different opts → different hash
    expect(h1).toMatch(/^[0-9a-f]{16}$/) // 16 hex chars
  })

  it('resumes with missing journal file — all calls execute normally', async () => {
    const journalDir = makeTmpJournalDir()
    try {
      const client = fakeClient([
        [
          { type: 'text-delta', text: 'ok' },
          { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
        ],
      ])
      const wf = createWorkflow({
        ...makeCtx(client),
        journalDir,
        resumeFromRunId: 'wf_nonexistent000',
      })

      const result = await wf.agent('task')
      expect(result).toBe('ok')
    } finally {
      rmSync(journalDir, { recursive: true, force: true })
    }
  })
})
