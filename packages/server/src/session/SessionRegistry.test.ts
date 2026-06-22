import { describe, it, expect } from 'vitest'
import { SessionRegistry } from './SessionRegistry.js'
import { SessionManager } from './SessionManager.js'
import { fakeClient, fakeSnapshotStore } from './testFakes.js'
import { ToolRegistry } from '@zuse/core'
import type { ResolvedSettings } from '@zuse/core'

function mgr(id: string): SessionManager {
  const { client } = fakeClient([])
  return new SessionManager({
    sessionId: id,
    cwd: '/w',
    client,
    registry: new ToolRegistry(),
    settings: {
      providers: {},
      tools: {},
      permissions: { defaultMode: 'default', allow: [], ask: [], deny: [] },
    } as unknown as ResolvedSettings,
    systemPrompt: 'S',
    permissionPolicy: {
      interactive: true,
      config: { defaultMode: 'default', allow: [], ask: [], deny: [] },
    },
    snapshotStore: fakeSnapshotStore(),
  })
}

describe('SessionRegistry', () => {
  it('create/get/remove', () => {
    const reg = new SessionRegistry()
    const m = mgr('s1')
    reg.set('s1', m)
    expect(reg.get('s1')).toBe(m)
    expect(reg.list()).toEqual(['s1'])
    reg.remove('s1')
    expect(reg.get('s1')).toBeUndefined()
  })
})
