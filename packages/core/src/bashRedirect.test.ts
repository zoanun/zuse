import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { decide, isMustConfirm, splitBashSegments, MATCHED_CONFIRM_PREFIX } from './permission.js'
import type { Tool } from './tool.js'
import type { ResolvedSettings } from './types.js'

/**
 * **路径护栏是按工具名挂的，Bash 从旁边绕过去。** 实测复现（全自主档，真浏览器）：
 *
 *   1. Write(<cwd>/ZUSE.md) → 弹确认卡 → 人点「拒绝」
 *   2. Bash: echo "探针" > ZUSE.md → **无卡片，文件落地**
 *
 * `~/.zuse/**` 的 deny 同样：`echo probe > ~/.zuse/__probe.txt` 一声不吭地写成了。
 *
 * 这一档把**重定向目标**当成 Write 的路径再过一遍 deny 与 confirm 两张表。
 * 独立评审否掉了「全自主档下带重定向的段一律降级 ask」那个更宽的方案 ——
 * 真实语料里 11.3% 的 Bash 调用带重定向、其中 32% 是 heredoc 正文里的假 `>`，
 * 而覆盖面并不比这个方案宽。详见 2026-08-18-bash-write-surface-design.md。
 */

const cwd = process.cwd()
const mk = (name: string): Tool => ({
  name, description: '', inputSchema: { type: 'object', properties: {} },
  run: async () => ({ output: '' }),
})
const Bash = mk('Bash')

function settings(over: Partial<ResolvedSettings['permissions']> = {}): ResolvedSettings {
  return {
    tools: {}, providers: {},
    permissions: { defaultMode: 'bypass', allow: [], ask: [], deny: [], ...over },
  } as ResolvedSettings
}

const MEMORY_MD = join(homedir(), '.zuse', 'MEMORY.md').split('\\').join('/')

describe('重定向目标撞上 deny', () => {
  it('全自主档下 echo x > ~/.zuse/f 被 deny 拦住（修之前是静默放行）', () => {
    const r = decide(Bash, 'echo x > ~/.zuse/probe.txt', settings({ deny: ['Write(~/.zuse/**)'] }), [], cwd)
    expect(r.decision).toBe('deny')
  })

  it('Edit 形态的 deny 规则同样算数 —— 重定向就是写', () => {
    const r = decide(Bash, 'echo x > ~/.zuse/probe.txt', settings({ deny: ['Edit(~/.zuse/**)'] }), [], cwd)
    expect(r.decision).toBe('deny')
  })

  it('目标带引号也拦得住（一个字符本来就能绕过整层判定）', () => {
    const r = decide(Bash, 'echo x > "~/.zuse/probe.txt"', settings({ deny: ['Write(~/.zuse/**)'] }), [], cwd)
    expect(r.decision).toBe('deny')
  })

  it('一条命令里的第二处重定向也要查', () => {
    const r = decide(Bash, 'cmd > /tmp/ok 2> ~/.zuse/probe.txt', settings({ deny: ['Write(~/.zuse/**)'] }), [], cwd)
    expect(r.decision).toBe('deny')
  })

  it('没撞上的照旧放行 —— 这一档不该把普通重定向也拖下水', () => {
    const r = decide(Bash, 'echo x > build.log', settings({ deny: ['Write(~/.zuse/**)'] }), [], cwd)
    expect(r.decision).toBe('allow')
  })

  it('2>&1 与 /dev/null 不是写入面', () => {
    for (const c of ['cmd 2>&1', 'cmd > /dev/null', 'cmd 2> /dev/null']) {
      expect(decide(Bash, c, settings({ deny: ['Write(~/.zuse/**)'] }), [], cwd).decision).toBe('allow')
    }
  })
})

describe('重定向目标撞上「必须确认」档', () => {
  it('全自主档下 echo x > ZUSE.md 仍要确认（那次实测的原样复现）', () => {
    const r = decide(Bash, 'echo "探针" > ZUSE.md', settings(), [], cwd)
    expect(r.decision).toBe('ask')
    expect(r.matched?.startsWith(MATCHED_CONFIRM_PREFIX)).toBe(true)
  })

  it('MEMORY.md 也是', () => {
    const r = decide(Bash, `echo x >> ${MEMORY_MD}`, settings(), [], cwd)
    expect(r.decision).toBe('ask')
  })

  /**
   * **切「全自主」时这张卡不能被自动按掉。** `SessionManager` 的结算是
   * `if (p.mustConfirm) continue`，而 `isMustConfirm` 原来对 Bash 恒返回 false ——
   * 卡片弹出来，然后被替用户点成 allow。
   */
  it('isMustConfirm 认得出 Bash 这条路', () => {
    expect(isMustConfirm('Bash', 'echo x > ZUSE.md', cwd)).toBe(true)
    expect(isMustConfirm('Bash', 'echo x > build.log', cwd)).toBe(false)
  })
})

describe('目标静态判不出来时 fail closed', () => {
  it('目标里有变量 → 落 ask，不放过', () => {
    const r = decide(Bash, 'echo x > $HOME/.zuse/f', settings(), [], cwd)
    expect(r.decision).toBe('ask')
    // **断言 matched，不只断言 decision。** 只看 decision 的话，这条测试会被
    // 更早的档位（Bash 安全检查）顺手带绿 —— 下面那条就是活例子。
    expect(r.matched).toBe('redirect:目标判不出来')
  })

  /**
   * **命令替换根本轮不到这一档** —— 它在第 3 步（Bash 安全检查第 8 项）就被拦了，
   * 而第 3 步在 3.3 之前。
   *
   * 这条原来写的是 `expect(decision).toBe('ask')`，**绿得毫无意义**：
   * 无论 3.3 存在与否它都绿。变异验证抓到的 —— 拆掉 fail-closed 那一段，
   * 两条 fail-closed 测试只红了一条。留着它，改成钉住**分层顺序**这个真实事实。
   */
  it('命令替换在更早一档就被拦了，不归这一档管', () => {
    const r = decide(Bash, 'echo x > `mktemp`', settings(), [], cwd)
    expect(r.decision).toBe('ask')
    expect(r.matched).toMatch(/^security:8 /)
  })

  /** 但它不是「必须确认」档 —— 用户切全自主时这张卡该被结算掉，不该焊死。 */
  it('不可判定不等于必须确认', () => {
    expect(isMustConfirm('Bash', 'echo x > $HOME/f', cwd)).toBe(false)
  })
})

describe('扫描器本身', () => {
  it('引号剥掉、引号内的空格保留', () => {
    expect(splitBashSegments('echo x > "my file.txt"')[0]!.redirects)
      .toEqual([{ target: 'my file.txt', decidable: true }])
  })

  it('>| 不再被当成管道拆开', () => {
    const segs = splitBashSegments('echo x >| f')
    expect(segs).toHaveLength(1)
    expect(segs[0]!.redirects).toEqual([{ target: 'f', decidable: true }])
  })

  it('变量目标标成不可判定', () => {
    expect(splitBashSegments('echo x >$HOME/f')[0]!.redirects[0]!.decidable).toBe(false)
  })
})
