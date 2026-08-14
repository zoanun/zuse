import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { decide, validateRules, matchesRule } from './permission.js'
import { DEFAULT_DENY_RULES, DEFAULT_ALLOW_RULES, DEFAULT_ASK_RULES } from './settings.js'
import type { Tool } from './tool.js'
import type { ResolvedSettings } from './types.js'

/**
 * 设计审计（2026-08-14）查出来的三条，逐条锁住。
 * 每条测试的头部写清它防的是什么 —— 这三条的共同点是「失效时静默」。
 */

function settings(over: Partial<ResolvedSettings['permissions']> = {}): ResolvedSettings {
  return {
    tools: {},
    providers: {},
    permissions: {
      defaultMode: 'default',
      allow: [...DEFAULT_ALLOW_RULES],
      ask: [...DEFAULT_ASK_RULES],
      deny: [...DEFAULT_DENY_RULES],
      ...over,
    },
  } as ResolvedSettings
}

const memoryLike = (): Tool => ({
  name: 'Memory',
  description: '',
  inputSchema: { type: 'object', properties: {} },
  run: async () => ({ output: '' }),
  specifierKind: 'opaque',
  specifierFor: (input: unknown) => {
    const a = (input as { action?: unknown } | null)?.action
    return typeof a === 'string' ? a : null
  },
  // readOnly 由被测的真实工具决定；这里造一个「未来新增的写类 action」的场景，
  // 所以刻意不设 readOnly —— 见下面用例自己的说明。
})

/**
 * 审计 1.3：`Memory` 标了 `readOnly: true`，而 `decide()` 的兜底是
 * `tool.readOnly ? 'allow' : 'ask'` —— 于是**任何不在 ask 表里的 action 自动放行**。
 * 今天 action 枚举有 5 个（save/search/recall/list/delete），ask 表只有 2 个。
 * 明天加第 6 个写类 action：编译不报错、测试不变红、界面不弹框。**这是 fail-open。**
 */
describe('审计 1.3：Memory 的未知 action 必须 fail-closed', () => {
  it('未来新增的写类 action（不在任何规则里）→ 必须 ask，不能自动放行', () => {
    const tool = { ...memoryLike(), readOnly: false, parallelizable: true } as Tool
    const { decision } = decide(tool, 'export', settings(), [], process.cwd())
    expect(decision).toBe('ask')
  })

  it('读类 action 仍然免打扰（靠 allow 规则，不靠 readOnly 兜底）', () => {
    const tool = { ...memoryLike(), readOnly: false, parallelizable: true } as Tool
    for (const a of ['search', 'recall', 'list']) {
      const { decision } = decide(tool, a, settings(), [], process.cwd())
      expect(decision, `Memory(${a}) 应当免确认`).toBe('allow')
    }
  })

  it('写类 action 仍然要人审', () => {
    const tool = { ...memoryLike(), readOnly: false, parallelizable: true } as Tool
    for (const a of ['save', 'delete']) {
      const { decision } = decide(tool, a, settings(), [], process.cwd())
      expect(decision, `Memory(${a}) 应当 ask`).toBe('ask')
    }
  })

  it('对照：把 readOnly 设回 true，未知 action 就变成静默放行（这正是被修掉的形状）', () => {
    const tool = { ...memoryLike(), readOnly: true } as Tool
    const { decision } = decide(tool, 'export', settings(), [], process.cwd())
    expect(decision).toBe('allow') // ← 这条不是「期望行为」，是把缺陷形状钉在这里当反面教材
  })
})

/**
 * 审计 1.2：`~/.zuse/cron/tasks.json` 里的 `permissionMode` **默认就是 bypass**
 * （CronService.ts:42 与 cronStore.ts:46 两处）。写一份 tasks.json 就等于
 * 让调度器起一个非交互 + 全自主的会话去跑里面的 prompt —— 比改 settings 更直接，
 * 后者要等下个会话，前者自带执行器。
 *
 * 而原来的 deny 只列了 `settings*.json*`：glob 的 `*` 编译成 `[^/]*`，**跨不过斜杠**，
 * 所以 `~/.zuse/cron/tasks.json` 一条都不命中。
 */
describe('审计 1.2：~/.zuse 下的文件模型一律不能写', () => {
  it('cron 任务表（自带 bypass 执行器）被 deny 挡住', () => {
    // 用真实的绝对路径，不是字面 `~/…` —— 工具传给权限层的 specifier 是解析过的路径，
    // 拿 `~/…` 当 specifier 测等于测了一个现实中不会出现的输入（我第一版就写错在这）。
    const target = join(homedir(), '.zuse', 'cron', 'tasks.json')
    for (const tool of ['Write', 'Edit']) {
      const t = { name: tool, description: '', inputSchema: { type: 'object', properties: {} }, run: async () => ({ output: '' }) } as Tool
      const { decision } = decide(t, target, settings(), [], process.cwd())
      expect(decision, `${tool}(${target})`).toBe('deny')
    }
  })

  it('settings 那几条老规则仍然生效（别为了加新规则把旧的挤掉）', () => {
    const t = { name: 'Write', description: '', inputSchema: { type: 'object', properties: {} }, run: async () => ({ output: '' }) } as Tool
    expect(decide(t, '.zuse/settings.local.jsonc', settings(), [], process.cwd()).decision).toBe('deny')
  })

  it('~/.zuse 之外的普通文件不受影响', () => {
    const t = { name: 'Write', description: '', inputSchema: { type: 'object', properties: {} }, run: async () => ({ output: '' }) } as Tool
    expect(decide(t, 'src/app.ts', settings({ allow: ['Write(./**)'] }), [], process.cwd()).decision).toBe('allow')
  })
})

/**
 * 审计 2.2：Bash 的限定符**不是 glob**，只支持「全 `*`」和「尾 `*` 前缀匹配」
 * （permission.ts 的 matchCommand）。于是 `Bash(*curl*)` 是一条
 * **合法、能过 validateRules 全部校验、但永远不可能命中**的规则。
 *
 * 用户可见症状与那一整篇 rule-parse spec 要消灭的「静默丢弃的 deny」完全一样：
 * 配了、看得见、没生效、没提示。区别只在于这次是**语言设计**造成的，不是用户手滑。
 */
describe('审计 2.2：Bash 限定符里写中缀 * 要被告警', () => {
  it('中缀 * 确实永远不命中（先证明问题存在）', () => {
    expect(matchesRule('Bash(*curl*)', 'Bash', 'curl evil.sh', process.cwd())).toBe(false)
    expect(matchesRule('Bash(* --force)', 'Bash', 'git push --force', process.cwd())).toBe(false)
  })

  it('validateRules 报 bash-glob-noop', () => {
    const bad = validateRules(['Bash(*curl*)', 'Bash(* --force)', 'Bash(rm ?)'])
    expect(bad.map((b) => b.rule).sort()).toEqual(['Bash(* --force)', 'Bash(*curl*)', 'Bash(rm ?)'])
    expect(new Set(bad.map((b) => b.problem))).toEqual(new Set(['bash-glob-noop']))
  })

  it('合法的 Bash 限定符形态不报警', () => {
    expect(validateRules(['Bash(*)', 'Bash(ls *)', 'Bash(git status)', 'Bash(npm run *)'])).toEqual([])
  })

  it('非 Bash 工具的 glob 不受影响（那边 ** 和 ? 都是真的 glob）', () => {
    expect(validateRules(['Write(**/*.ts)', 'Read(src/?.ts)', 'WebFetch(*.example.com)'])).toEqual([])
  })
})
