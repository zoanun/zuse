import { describe, it, expect } from 'vitest'
import { ToolRegistry, type ResolvedSettings, type ModelSelection, type Conversation, type Tool, type ErrorCategory } from '@zuse/core'
import { findCommand, editDistance, nearestMatch, buildModelOptions, listCommands } from './registry.js'
import type { CommandContext } from './types.js'
import type { SessionCheckpoint } from './sessionStore.js'
import type { SkillEntry } from '@zuse/tools'

// 造一个最小可用的 ResolvedSettings；只有 providers / model 与 /model 校验相关。
function makeSettings(providers: ResolvedSettings['providers'], model?: string): ResolvedSettings {
  return {
    model,
    tools: {},
    permissions: { defaultMode: 'default', allow: [], ask: [], deny: [] },
    providers,
  }
}

// 造一个最小工具（仅 name/description 与 /tools 展示相关）。
function fakeTool(name: string, description: string): Tool {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {} },
    run: async () => ({ output: '' }),
  }
}

function makeRegistry(tools: Tool[]): ToolRegistry {
  const reg = new ToolRegistry()
  for (const t of tools) reg.register(t)
  return reg
}

// 跑 /model <args>，捕获打印的行和 switchModel 收到的 persist 标志。
function runModel(args: string, settings: ResolvedSettings, current: { providerId: string; model: string }) {
  const printed: string[] = []
  let persistSeen: boolean | undefined
  let selectorOpened = false
  const ctx: CommandContext = {
    args,
    print: (t) => printed.push(t),
    clear: () => {},
    // /model 不触碰 conversation，给个占位即可。
    conversation: {} as unknown as Conversation,
    load: () => {},
    adoptSession: () => {},
    cwd: 'E:\\proj',
    compact: async () => '已压缩',
    checkpoints: [],
    checkpointDiff: async () => '',
    revertToCheckpoint: async () => '',
    settings,
    currentModel: current.model,
    currentProviderId: current.providerId,
    switchModel: (sel: ModelSelection, persist: boolean) => {
      persistSeen = persist
      return `已切换到 ${sel.providerId}/${sel.model}${persist ? '（已写盘）' : ''}`
    },
    openModelSelector: () => {
      selectorOpened = true
    },
    registry: makeRegistry([]),
    skills: [],
  }
  const cmd = findCommand('model')
  if (!cmd) throw new Error('model command not found')
  void cmd.run(ctx)
  return { printed, persistSeen, selectorOpened }
}

describe('editDistance', () => {
  it('counts single-char typo as distance 1', () => {
    expect(editDistance('mino-v2.5-free', 'mimo-v2.5-free')).toBe(1)
  })
  it('is zero for identical strings', () => {
    expect(editDistance('abc', 'abc')).toBe(0)
  })
})

describe('nearestMatch', () => {
  it('picks the closest candidate for a typo', () => {
    expect(nearestMatch('mino-v2.5-free', ['glm-5.1', 'mimo-v2.5-free', 'kimi-k2.6'])).toBe('mimo-v2.5-free')
  })
  it('returns undefined when nothing is close enough', () => {
    expect(nearestMatch('zzz', ['mimo-v2.5-free', 'glm-5.1'])).toBeUndefined()
  })
  it('also works for provider names', () => {
    expect(nearestMatch('pencode', ['deepseek', 'opencode', 'hermes'])).toBe('opencode')
  })
})

describe('buildModelOptions — /model 交互式选择器的候选清单', () => {
  it('展开每个 provider 的 models，配对标记当前项', () => {
    const settings = makeSettings({
      opencode: { models: ['mimo-v2.5-free', 'glm-5.1'] },
      deepseek: { models: ['deepseek-v4'] },
    })
    const opts = buildModelOptions(settings, 'opencode', 'glm-5.1')
    expect(opts.map((o) => `${o.providerId}/${o.model}`)).toEqual([
      'opencode/mimo-v2.5-free',
      'opencode/glm-5.1',
      'deepseek/deepseek-v4',
    ])
    expect(opts.filter((o) => o.isCurrent).map((o) => o.model)).toEqual(['glm-5.1'])
  })

  it('重名模型只按 provider+model 配对标当前，不会多标', () => {
    const settings = makeSettings({
      a: { models: ['shared'] },
      b: { models: ['shared'] },
    })
    const opts = buildModelOptions(settings, 'b', 'shared')
    expect(opts.filter((o) => o.isCurrent)).toEqual([{ providerId: 'b', model: 'shared', isCurrent: true }])
  })

  it('当前模型不在任何已声明清单：补一条并高亮，保证选择器能看到当前', () => {
    const settings = makeSettings({
      opencode: { models: ['glm-5.1'] },
    })
    const opts = buildModelOptions(settings, 'opencode', '离群模型')
    expect(opts).toContainEqual({ providerId: 'opencode', model: '离群模型', isCurrent: true })
    expect(opts.filter((o) => o.isCurrent)).toHaveLength(1)
  })

  it('扁平默认配置（无 providers）：只产出当前一条', () => {
    const settings = makeSettings({})
    const opts = buildModelOptions(settings, 'default', 'kimi-k2')
    expect(opts).toEqual([{ providerId: 'default', model: 'kimi-k2', isCurrent: true }])
  })

  it('provider 未声明 models 清单：不进选择器（仅直输路径可达），但当前仍兜底补上', () => {
    const settings = makeSettings({
      mystery: {},
    })
    const opts = buildModelOptions(settings, 'mystery', 'x-1')
    expect(opts).toEqual([{ providerId: 'mystery', model: 'x-1', isCurrent: true }])
  })
})

describe('/model 切换校验', () => {
  const settings = makeSettings({
    opencode: { models: ['mimo-v2.5-free', 'glm-5.1'] },
  })
  const current = { providerId: 'opencode', model: 'glm-5.1' }

  it('无参：打开交互式选择器，不打印文本 dump', () => {
    const { printed, selectorOpened } = runModel('', settings, current)
    expect(selectorOpened).toBe(true)
    expect(printed).toEqual([])
  })

  it('清单外拼错、有相近候选：拒绝切换，保留当前', () => {
    const { printed, persistSeen } = runModel('opencode/mino-v2.5-free --save', settings, current)
    expect(persistSeen).toBeUndefined() // switchModel 根本没被调用
    const warn = printed.find((l) => l.startsWith('⚠'))
    expect(warn).toContain('不在 provider "opencode" 的已声明列表中')
    expect(warn).toContain('mimo-v2.5-free') // 建议最接近的
    expect(warn).toContain('已保留当前模型（未切换）')
  })

  it('清单外、无相近候选：仍切换（自由输入），但不写盘', () => {
    const { printed, persistSeen } = runModel('opencode/totally-unknown-xyz --save', settings, current)
    expect(persistSeen).toBe(false) // 切换了，但 --save 被忽略
    const warn = printed.find((l) => l.startsWith('⚠'))
    expect(warn).toContain('不在 provider "opencode" 的已声明列表中')
    expect(warn).not.toContain('你是否想要') // 没有相近候选 → 不给建议
    expect(warn).toContain('已忽略 --save')
  })

  it('清单内的模型 + --save：正常写盘，无警告', () => {
    const { printed, persistSeen } = runModel('opencode/mimo-v2.5-free --save', settings, current)
    expect(persistSeen).toBe(true)
    expect(printed.some((l) => l.startsWith('⚠'))).toBe(false)
  })

  it('provider 名打错、有相近候选：拒绝切换并建议', () => {
    const { printed, persistSeen } = runModel('pencode/glm-5.1 --save', settings, current)
    expect(persistSeen).toBeUndefined() // switchModel 没被调用
    const warn = printed.find((l) => l.startsWith('⚠'))
    expect(warn).toContain('Provider "pencode" 未配置')
    expect(warn).toContain('opencode') // 建议最接近的 provider
    expect(warn).toContain('已保留当前模型（未切换）')
  })

  it('provider 未声明 models 清单：自由输入，不校验', () => {
    const free = makeSettings({ custom: {} })
    const { printed, persistSeen } = runModel('custom/anything-goes --save', free, {
      providerId: 'custom',
      model: 'x',
    })
    expect(persistSeen).toBe(true)
    expect(printed.some((l) => l.startsWith('⚠'))).toBe(false)
  })
})

// 跑某个命令，注入指定 registry/settings，捕获打印行。
function runCommand(
  name: string,
  args: string,
  opts: { registry?: ToolRegistry; settings?: ResolvedSettings; skills?: SkillEntry[] } = {},
) {
  const printed: string[] = []
  const ctx: CommandContext = {
    args,
    print: (t) => printed.push(t),
    clear: () => {},
    conversation: {} as unknown as Conversation,
    load: () => {},
    adoptSession: () => {},
    cwd: 'E:\\proj',
    compact: async () => '已压缩',
    checkpoints: [],
    checkpointDiff: async () => '',
    revertToCheckpoint: async () => '',
    settings: opts.settings ?? makeSettings({}),
    currentModel: 'm',
    currentProviderId: 'p',
    switchModel: () => '',
    openModelSelector: () => {},
    registry: opts.registry ?? makeRegistry([]),
    skills: opts.skills ?? [],
  }
  const cmd = findCommand(name)
  if (!cmd) throw new Error(`${name} command not found`)
  void cmd.run(ctx)
  return { printed }
}

describe('/tools', () => {
  it('列出暴露给模型的工具（取描述首行）', () => {
    const reg = makeRegistry([
      fakeTool('Read', '读取文件\n（多行描述的后续内容应被忽略）'),
      fakeTool('Bash', '执行命令'),
    ])
    const { printed } = runCommand('tools', '', { registry: reg })
    const out = printed.join('\n')
    expect(out).toContain('2 个')
    expect(out).toContain('Read')
    expect(out).toContain('读取文件')
    expect(out).not.toContain('多行描述的后续内容') // 只取首行
    expect(out).toContain('Bash')
  })

  it('按 settings.tools.disabled 过滤（不展示被禁用的工具）', () => {
    const reg = makeRegistry([fakeTool('Read', '读取文件'), fakeTool('Bash', '执行命令')])
    const settings = { ...makeSettings({}), tools: { disabled: ['Bash'] } }
    const { printed } = runCommand('tools', '', { registry: reg, settings })
    const out = printed.join('\n')
    expect(out).toContain('Read')
    expect(out).not.toContain('Bash')
  })

  it('无可用工具时给出提示', () => {
    const { printed } = runCommand('tools', '', { registry: makeRegistry([]) })
    expect(printed.join('\n')).toContain('没有暴露给模型的工具')
  })
})

describe('/skills', () => {
  it('无技能时给出放置路径指引', () => {
    const { printed } = runCommand('skills', '')
    const out = printed.join('\n')
    expect(out).toContain('~/.zuse/skills')
    expect(out).toContain('.zuse/skills')
  })

  it('列出技能名与描述(截断),并提示触发方式', () => {
    const skills: SkillEntry[] = [
      { name: 'code-review', description: '审查本地改动', dir: 'E:\\x', body: '', source: 'user' },
      { name: 'deploy', description: 'd'.repeat(100), dir: 'E:\\y', body: '', source: 'user' },
    ]
    const { printed } = runCommand('skills', '', { skills })
    const out = printed.join('\n')
    expect(out).toContain('2 个')
    expect(out).toContain('code-review')
    expect(out).toContain('审查本地改动')
    expect(out).toContain('…') // 长描述截断
    expect(out).toContain('Skill 工具')
  })
})

describe('/history', () => {
  it('提示用终端滚动区查看历史（cc 式渲染下不再有应用内滚动）', () => {
    const { printed } = runCommand('history', '')
    expect(printed.join('\n')).toContain('终端')
  })
})

// ——— /revert(Phase 12)———

const CP = (i: number, label: string): SessionCheckpoint => ({
  messageIndex: i,
  hash: `${i}`.repeat(40).slice(0, 40),
  at: `2026-06-12T0${i}:00:00Z`,
  label,
})

// /revert 专用 runner:可注入检查点与 diff/revert spy,并 await 异步 run。
async function runRevert(
  args: string,
  checkpoints: SessionCheckpoint[],
  hooks?: {
    checkpointDiff?: (cp: SessionCheckpoint) => Promise<string>
    revertToCheckpoint?: (cp: SessionCheckpoint) => Promise<string>
  },
) {
  const printed: string[] = []
  const calls: { diff: SessionCheckpoint[]; revert: SessionCheckpoint[] } = { diff: [], revert: [] }
  const ctx: CommandContext = {
    args,
    print: (t) => printed.push(t),
    clear: () => {},
    conversation: {} as unknown as Conversation,
    load: () => {},
    adoptSession: () => {},
    cwd: 'E:\\proj',
    compact: async () => '已压缩',
    checkpoints,
    checkpointDiff: async (cp) => {
      calls.diff.push(cp)
      return hooks?.checkpointDiff ? await hooks.checkpointDiff(cp) : ' a.txt | 2 +-'
    },
    revertToCheckpoint: async (cp) => {
      calls.revert.push(cp)
      return hooks?.revertToCheckpoint ? await hooks.revertToCheckpoint(cp) : '已回滚'
    },
    settings: makeSettings({}),
    currentModel: 'm',
    currentProviderId: 'p',
    switchModel: () => '',
    openModelSelector: () => {},
    registry: makeRegistry([]),
    skills: [],
  }
  const cmd = findCommand('revert')
  if (!cmd) throw new Error('revert command not found')
  await cmd.run(ctx)
  return { printed, calls }
}

describe('/revert', () => {
  it('无检查点时给出提示', async () => {
    const { printed } = await runRevert('', [])
    expect(printed.join('\n')).toContain('还没有检查点')
  })

  it('无参列出检查点,1 = 最新(倒序),带时间与 label', async () => {
    const { printed, calls } = await runRevert('', [CP(0, '第一问'), CP(2, '第二问')])
    const out = printed.join('\n')
    expect(out).toContain('1. 2026-06-12 02:00  第二问')
    expect(out).toContain('2. 2026-06-12 00:00  第一问')
    expect(calls.revert).toHaveLength(0)
  })

  it('带序号不带 --yes:展示 diffStat 与确认指引,不执行回滚', async () => {
    const { printed, calls } = await runRevert('1', [CP(0, '第一问'), CP(2, '第二问')])
    const out = printed.join('\n')
    expect(calls.diff).toHaveLength(1)
    expect(calls.diff[0]!.messageIndex).toBe(2) // 序号 1 = 最新的检查点
    expect(out).toContain('a.txt')
    expect(out).toContain('/revert 1 --yes')
    expect(calls.revert).toHaveLength(0) // 未确认绝不执行
  })

  it('带 --yes:执行回滚并打印结果', async () => {
    const { printed, calls } = await runRevert('2 --yes', [CP(0, '第一问'), CP(2, '第二问')])
    expect(calls.revert).toHaveLength(1)
    expect(calls.revert[0]!.messageIndex).toBe(0) // 序号 2 = 较早的检查点
    expect(printed.join('\n')).toContain('已回滚')
  })

  it('序号越界给出明确提示,不执行', async () => {
    const { printed, calls } = await runRevert('9', [CP(0, '第一问')])
    expect(printed.join('\n')).toContain('没有序号为 "9" 的检查点')
    expect(calls.diff).toHaveLength(0)
    expect(calls.revert).toHaveLength(0)
  })

  it('diffStat 失败不阻断确认流程(降级为提示对比失败)', async () => {
    const { printed, calls } = await runRevert('1', [CP(0, '第一问')], {
      checkpointDiff: async () => {
        throw new Error('影子仓库不可用')
      },
    })
    const out = printed.join('\n')
    expect(out).toContain('改动对比失败')
    expect(out).toContain('--yes') // 仍给出确认路径
    expect(calls.revert).toHaveLength(0)
  })
})

describe('listCommands — 供 / 菜单消费的命令元信息', () => {
  it('投影出全部命令的名字/描述', () => {
    const names = listCommands().map((c) => c.name)
    expect(names).toEqual(['help', 'config', 'clear', 'save', 'load', 'resume', 'revert', 'compact', 'model', 'tools', 'skills', 'history', 'terminal-setup'])
  })

  it('save/load 标记为需参数；其余（含 model）为无参', () => {
    const byName = Object.fromEntries(listCommands().map((c) => [c.name, c.takesArgs]))
    expect(byName['save']).toBe(true)
    expect(byName['load']).toBe(true)
    expect(byName['model']).toBe(false)
    expect(byName['clear']).toBe(false)
    expect(byName['terminal-setup']).toBe(false)
  })
})

describe('buildModelOptions — 不可用标注', () => {
  it('badKeys 命中项带 unavailable,未命中不带', () => {
    const settings = makeSettings({ p: { models: ['m1', 'm2'] } })
    const bad = new Map<string, ErrorCategory>([['p/m1', 'quota']])
    const opts = buildModelOptions(settings, 'p', 'm2', bad)
    const m1 = opts.find((o) => o.model === 'm1')!
    const m2 = opts.find((o) => o.model === 'm2')!
    expect(m1.unavailable).toEqual({ reason: 'quota' })
    expect(m2.unavailable).toBeUndefined()
  })
  it('不传 badKeys 时全部无 unavailable(向后兼容)', () => {
    const settings = makeSettings({ p: { models: ['m1', 'm2'] } })
    const opts = buildModelOptions(settings, 'p', 'm1')
    expect(opts.every((o) => o.unavailable === undefined)).toBe(true)
  })
})

