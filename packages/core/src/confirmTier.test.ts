import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { decide, isMustConfirm, MATCHED_CONFIRM_PREFIX, BUILTIN_CONFIRM_RULES } from './permission.js'
import type { Tool } from './tool.js'
import type { ResolvedSettings } from './types.js'

/**
 * 「必须确认」档：`allow` 压不过、`bypass` 也压不过的一档。
 *
 * 病根是 `decide()` 里 `allow` 在第 4 步、`ask` 在第 5 步 —— 用户写的任何一条 allow
 * 都会压过内建的 ask。实测过：内建 ask 被本仓自己的 `Write(./**)` 直接压掉。
 *
 * 这一档只管**今天完全零保护**的三个文件：它们直接进系统提示词
 *（ZUSE.md 的标题字面就是 "Project instructions"），是最直接的指令注入面。
 * settings 文件与 cron 表**仍然是 deny** —— 独立评审否掉了把它们降级的方案。
 */

const cwd = process.cwd()
const mk = (name: string): Tool => ({
  name, description: '', inputSchema: { type: 'object', properties: {} },
  run: async () => ({ output: '' }),
})
const Write = mk('Write')

function settings(over: Partial<ResolvedSettings['permissions']> = {}): ResolvedSettings {
  return {
    tools: {}, providers: {},
    permissions: { defaultMode: 'default', allow: [], ask: [], deny: [], ...over },
  } as ResolvedSettings
}

const ZUSE_MD = join(cwd, 'ZUSE.md')
const SYSTEM_MD = join(homedir(), '.zuse', 'SYSTEM.md')

describe('必须确认档：谁也压不过', () => {
  it('allow 压不过它（正是当初逼着用 deny 的那个实测反例）', () => {
    const r = decide(Write, ZUSE_MD, settings({ allow: ['Write(./**)'] }), [], cwd)
    expect(r.decision).toBe('ask')
    expect(r.matched?.startsWith(MATCHED_CONFIRM_PREFIX)).toBe(true)
  })

  it('bypass（全自主 / cron 默认档）也压不过它', () => {
    const r = decide(Write, SYSTEM_MD, settings({ defaultMode: 'bypass' }), [], cwd)
    expect(r.decision).toBe('ask')
    expect(r.matched?.startsWith(MATCHED_CONFIRM_PREFIX)).toBe(true)
  })

  it('会话覆盖层（点过「本会话允许」）同样压不过', () => {
    const r = decide(Write, ZUSE_MD, settings(), ['Write(./**)'], cwd)
    expect(r.decision).toBe('ask')
  })

  it('deny 仍然压过它（deny 是第 2 步，在 3.2 之前）', () => {
    const r = decide(Write, ZUSE_MD, settings({ deny: ['Write(**/ZUSE.md)'] }), [], cwd)
    expect(r.decision).toBe('deny')
  })

  it('工具被禁用仍然压过它（第 1 步在最前）', () => {
    const s = settings()
    ;(s as unknown as { tools: { disabled: string[] } }).tools = { disabled: ['Write'] }
    expect(decide(Write, ZUSE_MD, s, [], cwd).decision).toBe('deny')
  })

  it('不在这张表里的文件不受影响', () => {
    const r = decide(Write, join(cwd, 'src', 'app.ts'), settings({ allow: ['Write(./**)'] }), [], cwd)
    expect(r.decision).toBe('allow')
  })

  /**
   * 评审否掉的那次降级：settings 文件与 cron 表**必须仍然是 deny**。
   * 一次误点写进 `defaultMode:"bypass"` 会让 deny/ask 全表失效，且没有任何界面会告诉用户。
   */
  it('settings 文件与 cron 表没有被降级成「必须确认」', () => {
    for (const p of ['.zuse/settings.local.jsonc', join(homedir(), '.zuse', 'cron', 'tasks.json')]) {
      expect(isMustConfirm('Write', p, cwd), `${p} 不该在必须确认档里`).toBe(false)
    }
  })
})

describe('isMustConfirm 与 decide 用同一张表（漂移会让切全自主时行为不一致）', () => {
  it('表里每一条规则的目标都被 isMustConfirm 认出来', () => {
    const samples: Array<[string, string]> = [
      ['Write', SYSTEM_MD],
      ['Edit', SYSTEM_MD],
      ['Write', join(homedir(), '.zuse', 'MEMORY.md')],
      ['Write', ZUSE_MD],
      ['Edit', join(cwd, 'sub', 'ZUSE.md')],
    ]
    for (const [tool, path] of samples) {
      expect(isMustConfirm(tool, path, cwd), `${tool}(${path})`).toBe(true)
      // 与 decide 的判定必须一致 —— 两处漂移的症状是「切全自主时某些卡被按掉、某些没有」。
      const r = decide(mk(tool), path, settings({ defaultMode: 'bypass' }), [], cwd)
      expect(r.matched?.startsWith(MATCHED_CONFIRM_PREFIX), `${tool}(${path}) 在 decide 里没命中`).toBe(true)
    }
  })

  it('表非空（删空了这个特性就静默没了）', () => {
    expect(BUILTIN_CONFIRM_RULES.length).toBeGreaterThan(0)
  })
})

/**
 * **`~/.zuse/MEMORY.md` 有一个官方写入器，而它原来不受这一档管。**
 *
 * `Memory` 工具的 `specifierKind` 是 `opaque`（限定符是动作名，不是路径），
 * 于是 `Write(~/.zuse/MEMORY.md)` 这条规则对它**永不命中** —— 而它 save/delete
 * 成功后必定重写那个文件（`memory.ts` 的 `writeProjection`）。
 *
 * 实测（修之前）：全自主档下 `Memory(save)` → **allow，一声不吭**。
 * 也就是说 features.md 里那句「这几个文件即使你开着全自主也永远问你一声」
 * 对这条路是**假的**。要么管住它，要么改文案；两者都行，什么都不做不行。
 * 这里选管住它 —— 它写的东西正是这一档的立档理由：影响以后每一个会话。
 */
describe('Memory 工具：写的是同一个文件，就该受同一档管', () => {
  const Memory = mk('Memory')

  it('全自主档下 Memory(save) 仍然要确认', () => {
    const r = decide(Memory, 'save', settings({ defaultMode: 'bypass' }), [], cwd)
    expect(r.decision).toBe('ask')
    expect(r.matched?.startsWith(MATCHED_CONFIRM_PREFIX)).toBe(true)
  })

  it('Memory(delete) 同样 —— 删掉一条记忆也是在改那份系统提示词', () => {
    const r = decide(Memory, 'delete', settings({ defaultMode: 'bypass' }), [], cwd)
    expect(r.decision).toBe('ask')
  })

  /**
   * `isMustConfirm` 必须跟着一起认。否则用户一按「全自主」，
   * `SessionManager` 的结算逻辑（`if (p.mustConfirm) continue`）看不出这张卡是这一档的，
   * 会替用户把它按成 allow —— 卡片弹出来了，然后被自动点掉。
   */
  it('isMustConfirm 认得出它（否则切全自主时会被自动按掉）', () => {
    expect(isMustConfirm('Memory', 'save', cwd)).toBe(true)
    expect(isMustConfirm('Memory', 'delete', cwd)).toBe(true)
  })

  it('只读的那些动作不该被拖下水', () => {
    expect(isMustConfirm('Memory', 'list', cwd)).toBe(false)
    expect(decide(Memory, 'list', settings({ defaultMode: 'bypass' }), [], cwd).decision).toBe('allow')
  })

  it('规则表里确实有这两条（防止有人改表时漏掉）', () => {
    expect(BUILTIN_CONFIRM_RULES).toContain('Memory(save)')
    expect(BUILTIN_CONFIRM_RULES).toContain('Memory(delete)')
  })
})
