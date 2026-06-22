import { describe, it, expect } from 'vitest'
import { SessionManager } from './SessionManager.js'
import { fakeClient, fakeSnapshotStore } from './testFakes.js'
import { ToolRegistry } from '@zuse/core'
import type { ResolvedSettings } from '@zuse/core'

function makeSettings(): ResolvedSettings {
  return { providers: {}, permissions: { defaultMode: 'default', allow: [], deny: [] } } as unknown as ResolvedSettings
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
    permissionPolicy: { mode: 'default', interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
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

  it('non-interactive: ask is decided deterministically without emitting a request', async () => {
    const { mgr } = makeManager()
    mgr.setPermissionPolicy({
      mode: 'default',
      interactive: false,
      config: { defaultMode: 'default', allow: ['Bash(ls)'], ask: [], deny: [] },
    })
    const events: string[] = []
    mgr.subscribe((e) => events.push(e.type))
    // @ts-expect-error
    await expect(mgr.canUseTool({ toolName: 'Bash', input: { command: 'ls' }, specifier: 'ls', rule: 'Bash(ls)', reason: 'ask' })).resolves.toBe('allow')
    // @ts-expect-error
    await expect(mgr.canUseTool({ toolName: 'Bash', input: { command: 'rm' }, specifier: 'rm', rule: 'Bash(rm)', reason: 'ask' })).resolves.toBe('deny')
    expect(events).not.toContain('permission-request')
  })
})
