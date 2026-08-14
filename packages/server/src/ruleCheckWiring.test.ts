import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from './startServer.js'
import { createSession } from './session/createSession.js'
import { DEFAULT_SESSION_ID } from './config.js'
import { fakeClient, fakeSnapshotStore } from './session/testFakes.js'
import { DEFAULT_ALLOW_RULES, DEFAULT_ASK_RULES, DEFAULT_DENY_RULES } from '@zuse/core'

/**
 * **接线测试。** `validateRules` 是纯函数，直接调它 + spy console.warn 的测试
 * **即使 `startServer` 里一行调用都没写也会绿** —— 而那正是本缺陷（D6）自己的形状：
 * 函数存在、没人接线、运行期神秘失效。所以这条必须穿过真的 `startServer`。
 *
 * 配置读的是**用户层**（`~/.zuse/settings.json`），所以这里用 `HOME`/`USERPROFILE`
 * 指向临时目录，绝不碰开发者本机的真配置。
 */
let dir: string
let prevHome: string | undefined
let prevProfile: string | undefined
const servers: { close(): Promise<void> }[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zuse-rulechk-'))
  prevHome = process.env.HOME
  prevProfile = process.env.USERPROFILE
  process.env.HOME = dir
  process.env.USERPROFILE = dir
  mkdirSync(join(dir, '.zuse'), { recursive: true })
})
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome
  if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile
  rmSync(dir, { recursive: true, force: true })
})

async function boot(): Promise<void> {
  const { client } = fakeClient([])
  const session = createSession({ sessionId: DEFAULT_SESSION_ID, cwd: dir, client, snapshotStore: fakeSnapshotStore() })
  servers.push(await startServer(
    { host: '127.0.0.1', port: 0, authDir: dir, tokenTtlSec: 3600, cwd: dir },
    { session, connectMcp: false },
  ))
}

const writeSettings = (perms: unknown): void =>
  writeFileSync(join(dir, '.zuse', 'settings.json'), JSON.stringify({ permissions: perms }, null, 2), 'utf8')

describe('startServer 的权限规则体检', () => {
  it('非法规则被逐字打出来，且点明是哪张表', async () => {
    writeSettings({ deny: ['Bash(rm -rf'], allow: ['Write(./**)'] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await boot()
    const all = warn.mock.calls.map((c) => String(c[0])).join('\n')
    warn.mockRestore()
    expect(all).toContain('Bash(rm -rf')     // 原文逐字 —— 用户要能一眼认出是哪条
    expect(all).toContain('permissions.deny')
  })

  /**
   * 「大小写写错」是**另一种机制**：规则合法、只是没有那个工具，所以永不命中。
   * 只查 `parseRule === null` 的实现会漏掉它，而症状与非法规则一模一样。
   */
  it('工具名不存在（大小写写错）也要报出来', async () => {
    writeSettings({ deny: ['read(~/.ssh/**)'] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await boot()
    const all = warn.mock.calls.map((c) => String(c[0])).join('\n')
    warn.mockRestore()
    expect(all).toContain('read(~/.ssh/**)')
    expect(all).toContain('找不到')
  })

  /**
   * **这条同时是防漂移的护栏。** 用户配置为空时跑的是**内置默认规则集**
   * （`DEFAULT_ALLOW_RULES` / `DEFAULT_DENY_RULES`），里面提到 Agent / TodoWrite /
   * WebSearch / mcp__… 等探测 registry 装不下的工具。
   * 谁加了新工具、或改了默认规则而忘了更新 `TOOLS_NOT_IN_PROBE_REGISTRY`，这条会红 ——
   * 那正是把人引回那个「同一个概念写两处」的地方的唯一机制。
   */
  /**
   * **防漂移的护栏。** 内置默认规则集里提到 Agent / TodoWrite / WebSearch 等
   * 探测 registry 装不下的工具；谁加了新工具、或改了默认规则却忘了更新
   * `TOOLS_NOT_IN_PROBE_REGISTRY`，这条会红 —— 那是把人引回那个
   * 「同一个概念写两处」的地方的唯一机制。
   *
   * **断言方式刻意不是「一条告警都没有」**：`loadSettings()` 会顺着 daemon 的 cwd
   * 往上找项目层配置（本仓 CLAUDE.md 记过这个坑），所以跑测试时**本仓自己的**
   * `.zuse/settings.local.jsonc` 也在里面 —— 那份是开发者的私货，不该决定测试红绿。
   * 只断言「内置默认规则一条都没被点名」。
   */
  it('内置默认规则集一条都不该被点名（防「工具名单写两处」漂移）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await boot()
    const all = warn.mock.calls.map((c) => String(c[0])).join('\n')
    warn.mockRestore()
    // **三张表都要遍历。** 只走 allow+deny 的话，新加的 `DEFAULT_ASK_RULES`
    // 就没有防漂移保护 —— 而这条测试的整个存在意义就是防漂移。
    for (const r of [...DEFAULT_ALLOW_RULES, ...DEFAULT_ASK_RULES, ...DEFAULT_DENY_RULES])
      expect(all).not.toContain(`"${r}"`)
  })

  it('合法规则不被点名（否则告警会被当噪音无视掉）', async () => {
    writeSettings({ deny: ['Bash(rm -rf *)'], allow: ['Read'] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await boot()
    const all = warn.mock.calls.map((c) => String(c[0])).join('\n')
    warn.mockRestore()
    expect(all).not.toContain('Bash(rm -rf *)')
    expect(all).not.toContain('"Read"')
  })

  /** 体检本身绝不能拦住启动 —— 它是诊断，不是闸门。 */
  it('体检不影响 daemon 起来', async () => {
    writeSettings({ deny: ['Bash(rm -rf', 'read(x)', ''] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(boot()).resolves.toBeUndefined()
    warn.mockRestore()
  })
})
