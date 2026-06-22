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
