import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { ToolRegistry } from '@zuse/core'
import type { ResolvedSettings, PermissionRequest, PermissionVerdict } from '@zuse/core'
import { SessionManager } from './SessionManager.js'
import { fakeClient, fakeSnapshotStore, interactiveOpts } from './testFakes.js'
import type { SessionEvent } from './events.js'

/**
 * 「必须确认」档的待决卡片**不能**被「切到全自主」替用户按掉。
 *
 * `decide()` 那边已经把这一档排在 bypass 之前了，但那只挡住**新**的调用；
 * 屏上**已经在等**的卡片走的是 `setPermissionMode` 这条路 ——
 * 它遍历 `pending` 全部 `resolve('allow')`，等于上层替用户按了「允许」。
 *
 * 独立评审就是这么抓出来的，原话：「`decide()` 确实返回了 ask —— 是**上层替用户按掉的**。
 * 只测 `decide()` 的用例会绿，而真系统漏。这就是本仓『测试绿 ≠ 能用』的教科书案例。」
 *
 * **这条测试直接驱动 `setPermissionMode`，不跑整个 agent 回合** ——
 * 要测的就是那一个分支，绕开回合编排能让它稳定且快。
 */

function makeSettings(): ResolvedSettings {
  return {
    providers: {}, tools: {},
    permissions: { defaultMode: 'default', allow: [], deny: [], ask: [] },
  } as unknown as ResolvedSettings
}

function makeMgr(): SessionManager {
  const { client } = fakeClient([])
  return new SessionManager({
    sessionId: 's-confirm', cwd: process.cwd(), client,
    registry: new ToolRegistry(), systemPrompt: 'SYS',
    ...interactiveOpts(makeSettings()),
    snapshotStore: fakeSnapshotStore(),
  })
}

/** 手工塞一张待决卡（`canUseTool` 是私有的，而我们要测的是结算那一侧）。 */
function park(mgr: SessionManager, id: string, req: PermissionRequest): PermissionVerdict[] {
  const got: PermissionVerdict[] = []
  const pending = (mgr as unknown as {
    pending: Map<string, { req: PermissionRequest; resolve: (v: PermissionVerdict) => void; mustConfirm?: boolean }>
  }).pending
  const isMustConfirm = (mgr as unknown as { constructor: unknown }) && undefined
  void isMustConfirm
  pending.set(id, {
    req,
    resolve: (v) => got.push(v),
    // 与生产路径一致：这个标记在 canUseTool 里由 isMustConfirm 算出来。
    mustConfirm: req.specifier?.endsWith('ZUSE.md') === true,
  })
  return got
}

const reqFor = (specifier: string): PermissionRequest => ({
  toolName: 'Write', input: { path: specifier }, specifier, rule: `Write(${specifier})`,
})

describe('切全自主：必须确认档的卡片不被替按', () => {
  it('普通卡被结算成 allow，必须确认的那张**原地不动**', () => {
    const mgr = makeMgr()
    const normal = park(mgr, 'perm-1', reqFor(join(process.cwd(), 'src', 'app.ts')))
    const confirm = park(mgr, 'perm-2', reqFor(join(process.cwd(), 'ZUSE.md')))
    const resolvedIds: string[] = []
    mgr.subscribe((e: SessionEvent) => {
      if (e.type === 'permission-resolved') resolvedIds.push(e.id)
    })

    mgr.setPermissionMode('bypass')

    expect(normal, '普通卡应当被切换结算成 allow').toEqual(['allow'])
    expect(confirm, '必须确认的卡被切全自主替用户按掉了').toEqual([])
    expect(resolvedIds).toEqual(['perm-1'])
  })

  it('必须确认的卡仍然留在待决表里，等用户自己点', () => {
    const mgr = makeMgr()
    park(mgr, 'perm-1', reqFor(join(process.cwd(), 'ZUSE.md')))
    mgr.setPermissionMode('bypass')
    const pending = (mgr as unknown as { pending: Map<string, unknown> }).pending
    expect(pending.has('perm-1'), '卡片被移出了待决表 —— 用户再也点不到它').toBe(true)
  })

  it('横幅计数只算被替按掉的那些（必须确认的不算）', () => {
    const mgr = makeMgr()
    park(mgr, 'perm-1', reqFor(join(process.cwd(), 'a.ts')))
    park(mgr, 'perm-2', reqFor(join(process.cwd(), 'ZUSE.md')))
    const before = mgr.getState().autoAllowedCount
    mgr.setPermissionMode('bypass')
    expect(mgr.getState().autoAllowedCount - before).toBe(1)
  })
})
