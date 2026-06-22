import { describe, it, expect } from 'vitest'
import { SessionManager } from './SessionManager.js'
import { fakeClient, fakeSnapshotStore } from './testFakes.js'
import { ToolRegistry } from '@zuse/core'
import type { ResolvedSettings, Tool, ToolContext, ToolResult } from '@zuse/core'

function makeSettings(): ResolvedSettings {
  return {
    providers: {},
    tools: {},
    permissions: { defaultMode: 'default', allow: [], deny: [], ask: [] },
  } as unknown as ResolvedSettings
}

/** Minimal fake Bash tool satisfying the Tool interface for decide() evaluation. */
function makeBashTool(): Tool {
  return {
    name: 'Bash',
    description: 'Run a bash command',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
    run: async (_input: unknown, _ctx: ToolContext): Promise<ToolResult> => ({ output: '' }),
    readOnly: false,
    specifierFor: (input: unknown) => (input as { command?: string }).command ?? null,
  }
}

function makeManager(scripts = [] as Parameters<typeof fakeClient>[0]) {
  const { client, calls } = fakeClient(scripts)
  const mgr = new SessionManager({
    sessionId: 's1',
    cwd: '/work',
    client,
    registry: new ToolRegistry(),
    settings: makeSettings(),
    systemPrompt: 'SYS',
    permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
    snapshotStore: fakeSnapshotStore() as never,
  })
  return { mgr, calls }
}

describe('SessionManager skeleton', () => {
  it('getState returns initial snapshot', () => {
    const { mgr } = makeManager()
    const s = mgr.getState()
    expect(s.sessionId).toBe('s1')
    expect(s.isThinking).toBe(false)
    expect(s.model).toBe('fake-model')
    expect(s.cwd).toBe('/work')
    expect(s.messageCount).toBe(0)
    expect(s.pendingPermissions).toEqual([])
  })

  it('subscribe receives emitted events; unsubscribe stops them', () => {
    const { mgr } = makeManager()
    const seen: string[] = []
    const off = mgr.subscribe((e) => seen.push(e.type))
    // @ts-expect-error reach a test-only emit hook
    mgr._emitForTest({ type: 'warning', message: 'x' })
    off()
    // @ts-expect-error
    mgr._emitForTest({ type: 'warning', message: 'y' })
    expect(seen).toEqual(['warning'])
  })
})

describe('SessionManager permissions', () => {
  it('interactive: ask emits permission-request and resolves on resolvePermission', async () => {
    const { mgr } = makeManager()
    const events: string[] = []
    mgr.subscribe((e) => events.push(e.type))
    // @ts-expect-error reach private canUseTool for unit test
    const p = mgr.canUseTool({ toolName: 'Bash', input: { command: 'ls' }, specifier: 'ls', rule: 'Bash(ls)', reason: 'ask' })
    const pendingId = mgr.getState().pendingPermissions[0]?.id
    expect(pendingId).toBeDefined()
    expect(events).toContain('permission-request')
    mgr.resolvePermission(pendingId!, 'allow')
    await expect(p).resolves.toBe('allow')
    expect(mgr.getState().pendingPermissions).toEqual([])
  })

  it('interactive: two concurrent asks resolve independently', async () => {
    const { mgr } = makeManager()
    // @ts-expect-error
    const p1 = mgr.canUseTool({ toolName: 'Bash', input: { command: 'a' }, specifier: 'a', rule: 'Bash(a)', reason: 'ask' })
    // @ts-expect-error
    const p2 = mgr.canUseTool({ toolName: 'Bash', input: { command: 'b' }, specifier: 'b', rule: 'Bash(b)', reason: 'ask' })
    const ids = mgr.getState().pendingPermissions.map((x) => x.id)
    expect(ids.length).toBe(2)
    mgr.resolvePermission(ids[1]!, 'deny')
    mgr.resolvePermission(ids[0]!, 'allow')
    await expect(p1).resolves.toBe('allow')
    await expect(p2).resolves.toBe('deny')
  })

  it('non-interactive: allow-listed specifier resolves allow; others deny; no permission-request emitted', async () => {
    const { client } = fakeClient([])
    const registry = new ToolRegistry()
    registry.register(makeBashTool())
    const mgr = new SessionManager({
      sessionId: 's1',
      cwd: '/work',
      client,
      registry,
      settings: makeSettings(),
      systemPrompt: 'SYS',
      permissionPolicy: {
        interactive: false,
        config: { defaultMode: 'default', allow: ['Bash(ls)'], ask: [], deny: [] },
      },
      snapshotStore: fakeSnapshotStore() as never,
    })
    const events: string[] = []
    mgr.subscribe((e) => events.push(e.type))
    // @ts-expect-error
    await expect(mgr.canUseTool({ toolName: 'Bash', input: { command: 'ls' }, specifier: 'ls', rule: 'Bash(ls)', reason: 'ask' })).resolves.toBe('allow')
    // @ts-expect-error
    await expect(mgr.canUseTool({ toolName: 'Bash', input: { command: 'rm' }, specifier: 'rm', rule: 'Bash(rm)', reason: 'ask' })).resolves.toBe('deny')
    expect(events).not.toContain('permission-request')
  })

  it('non-interactive: compound Bash command is NOT bypassed by a prefix allow rule', async () => {
    // Regression test: "git status && rm -rf /tmp/x" must not be allowed just
    // because allow contains "Bash(git status*)". The compound command contains
    // a dangerous subcommand; decide() splits on && and must deny the whole thing.
    const { client } = fakeClient([])
    const registry = new ToolRegistry()
    registry.register(makeBashTool())
    const mgr = new SessionManager({
      sessionId: 's1',
      cwd: '/work',
      client,
      registry,
      settings: makeSettings(),
      systemPrompt: 'SYS',
      permissionPolicy: {
        interactive: false,
        config: { defaultMode: 'default', allow: ['Bash(git status*)'], ask: [], deny: [] },
      },
      snapshotStore: fakeSnapshotStore() as never,
    })
    const compound = 'git status && rm -rf /tmp/x'
    // @ts-expect-error
    await expect(mgr.canUseTool({ toolName: 'Bash', input: { command: compound }, specifier: compound, rule: `Bash(${compound})`, reason: 'ask' })).resolves.toBe('deny')
  })

  it('non-interactive: deny list is honored even when allow covers the tool', async () => {
    // Bash(*) in allow would naively allow everything, but deny: ['Bash(rm*)'] must
    // win due to deny-priority in decide().
    const { client } = fakeClient([])
    const registry = new ToolRegistry()
    registry.register(makeBashTool())
    const mgr = new SessionManager({
      sessionId: 's1',
      cwd: '/work',
      client,
      registry,
      settings: makeSettings(),
      systemPrompt: 'SYS',
      permissionPolicy: {
        interactive: false,
        config: { defaultMode: 'default', allow: ['Bash(*)'], ask: [], deny: ['Bash(rm*)'] },
      },
      snapshotStore: fakeSnapshotStore() as never,
    })
    // @ts-expect-error
    await expect(mgr.canUseTool({ toolName: 'Bash', input: { command: 'rm -rf /' }, specifier: 'rm -rf /', rule: 'Bash(rm -rf /)', reason: 'ask' })).resolves.toBe('deny')
  })

  it('resolvePermission ignores invalid verdict strings', async () => {
    const { mgr } = makeManager()
    // @ts-expect-error
    const p = mgr.canUseTool({ toolName: 'Bash', input: { command: 'ls' }, specifier: 'ls', rule: 'Bash(ls)', reason: 'ask' })
    const id = mgr.getState().pendingPermissions[0]!.id
    // @ts-expect-error intentionally invalid verdict
    mgr.resolvePermission(id, 'not-a-verdict')
    // The promise must still be pending (not resolved)
    const raced = await Promise.race([p.then(() => 'resolved'), Promise.resolve('pending')])
    expect(raced).toBe('pending')
    // The pending entry must still exist
    expect(mgr.getState().pendingPermissions.map((x) => x.id)).toContain(id)
    // Clean up
    mgr.resolvePermission(id, 'deny')
    await expect(p).resolves.toBe('deny')
  })
})
