import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry, type ResolvedSettings } from '@zuse/core'
import { SessionManager } from './SessionManager.js'
import { fakeClient, fakeSnapshotStore, interactiveOpts } from './testFakes.js'

/**
 * 「总是允许」必须写到**本会话自己的目录**，不是 daemon 的项目根。
 *
 * core 的缺省 `appendAllowRule(rule)` 走 `findProjectRoot()`，而那是从
 * **daemon 进程的 cwd** 往上找的。于是在别的项目里点一次「总是允许」，
 * 规则被写进 zuse 仓库自己的 `.zuse/settings.local.json`，**对所有会话永久生效**。
 * 用户以为在给「这个项目」放行，实际是给所有项目、永久放行。
 *
 * ## 这条测试防假绿的三道措施（评审点名要求）
 *
 * 1. **规则串带随机后缀** —— `appendAllowRule` 是幂等的（`if (existing.includes(rule)) return`），
 *    随手挑一条本仓已有的规则，坏实现也能让「daemon 根没变」通过。
 * 2. **断言 daemon 根那个文件「根本不存在」**，而不是「内容没变」。用临时目录当假 daemon 根，
 *    起始就没有这个文件 —— 比 hash 比对更硬。
 * 3. **必须配正向断言** —— 只查「daemon 根没被写」的话，一个「哪儿都没写」的实现全绿。
 */

let daemonRoot: string
let sessionRoot: string
let origCwd: string

beforeEach(() => {
  origCwd = process.cwd()
  daemonRoot = mkdtempSync(join(tmpdir(), 'zuse-daemon-root-'))
  sessionRoot = mkdtempSync(join(tmpdir(), 'zuse-session-root-'))
  // 假 daemon 根：放一个 pnpm-workspace.yaml，让 findProjectRoot 认它。
  writeFileSync(join(daemonRoot, 'pnpm-workspace.yaml'), 'packages: []\n')
  // vitest 2.x 默认 pool 是 forks，process.chdir 可用（worker threads 里会抛）。
  process.chdir(daemonRoot)
})
afterEach(() => {
  process.chdir(origCwd)
  rmSync(daemonRoot, { recursive: true, force: true })
  rmSync(sessionRoot, { recursive: true, force: true })
})

function makeSettings(): ResolvedSettings {
  return {
    providers: {}, tools: {},
    permissions: { defaultMode: 'default', allow: [], deny: [], ask: [] },
  } as unknown as ResolvedSettings
}

function makeManager(cwd: string): SessionManager {
  const { client } = fakeClient([])
  return new SessionManager({
    sessionId: 's1', cwd, client, registry: new ToolRegistry(), systemPrompt: 'SYS',
    ...interactiveOpts(makeSettings()),
    snapshotStore: fakeSnapshotStore(),
  })
}

/** 直取私有方法：这条路径的公开入口要跑完一整个回合，代价与本测试无关。 */
function persist(mgr: SessionManager, rule: string): void {
  ;(mgr as unknown as { persistAllowRule(r: string): void }).persistAllowRule(rule)
}

const localOf = (root: string): string => join(root, '.zuse', 'settings.local.json')

describe('「总是允许」的落盘作用域', () => {
  it('写到会话根，而不是 daemon 的项目根', () => {
    const mgr = makeManager(sessionRoot)
    // 随机后缀：绕开 appendAllowRule 的幂等短路（已存在就连写都不写）。
    const rule = `Bash(zuse-scope-probe-${Math.random().toString(36).slice(2)})`
    persist(mgr, rule)

    // 正向：会话根那份确实有这条规则。
    expect(existsSync(localOf(sessionRoot)), '会话根没生成配置文件').toBe(true)
    expect(readFileSync(localOf(sessionRoot), 'utf8')).toContain(rule)

    // 反向：daemon 根那个文件**根本不存在**（比「内容没变」硬）。
    expect(existsSync(localOf(daemonRoot)), 'daemon 根被写了 —— 规则泄漏到所有会话').toBe(false)
  })

  it('会话根不可写时不抛、不静默 —— 本会话内仍然有效', () => {
    // 指一个不可能建出来的目录：Windows 上盘符非法，POSIX 上 /proc 下不可建。
    const bad = process.platform === 'win32' ? 'Z*:/nope/nope' : '/proc/nope/nope'
    const mgr = makeManager(bad)
    expect(() => persist(mgr, 'Bash(whatever)')).not.toThrow()
    // 仍然没有碰 daemon 根。
    expect(existsSync(localOf(daemonRoot))).toBe(false)
  })

  it('两个不同根的会话各写各的，互不串味', () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'zuse-other-root-'))
    try {
      mkdirSync(join(otherRoot, '.zuse'), { recursive: true })
      const a = makeManager(sessionRoot)
      const b = makeManager(otherRoot)
      const ruleA = `Bash(only-a-${Math.random().toString(36).slice(2)})`
      const ruleB = `Bash(only-b-${Math.random().toString(36).slice(2)})`
      persist(a, ruleA)
      persist(b, ruleB)

      expect(readFileSync(localOf(sessionRoot), 'utf8')).toContain(ruleA)
      expect(readFileSync(localOf(sessionRoot), 'utf8')).not.toContain(ruleB)
      expect(readFileSync(localOf(otherRoot), 'utf8')).toContain(ruleB)
      expect(readFileSync(localOf(otherRoot), 'utf8')).not.toContain(ruleA)
      expect(existsSync(localOf(daemonRoot))).toBe(false)
    } finally {
      rmSync(otherRoot, { recursive: true, force: true })
    }
  })
})
