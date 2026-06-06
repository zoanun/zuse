import { describe, it, expect } from 'vitest'
import type { ResolvedSettings, ModelSelection, Conversation } from '@zuse/core'
import { findCommand, editDistance, nearestMatch } from './registry.js'
import type { CommandContext } from './types.js'

// 造一个最小可用的 ResolvedSettings；只有 providers / model 与 /model 校验相关。
function makeSettings(providers: ResolvedSettings['providers'], model?: string): ResolvedSettings {
  return {
    model,
    tools: {},
    permissions: { defaultMode: 'default', allow: [], ask: [], deny: [] },
    providers,
  }
}

// 跑 /model <args>，捕获打印的行和 switchModel 收到的 persist 标志。
function runModel(args: string, settings: ResolvedSettings, current: { providerId: string; model: string }) {
  const printed: string[] = []
  let persistSeen: boolean | undefined
  const ctx: CommandContext = {
    args,
    print: (t) => printed.push(t),
    clear: () => {},
    // /model 不触碰 conversation，给个占位即可。
    conversation: {} as unknown as Conversation,
    load: () => {},
    settings,
    currentModel: current.model,
    currentProviderId: current.providerId,
    switchModel: (sel: ModelSelection, persist: boolean) => {
      persistSeen = persist
      return `已切换到 ${sel.providerId}/${sel.model}${persist ? '（已写盘）' : ''}`
    },
  }
  const cmd = findCommand('model')
  if (!cmd) throw new Error('model command not found')
  void cmd.run(ctx)
  return { printed, persistSeen }
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

describe('/model 切换校验', () => {
  const settings = makeSettings({
    opencode: { models: ['mimo-v2.5-free', 'glm-5.1'] },
  })
  const current = { providerId: 'opencode', model: 'glm-5.1' }

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

describe('/model 列表标星', () => {
  const settings = makeSettings({
    deepseek: { models: ['deepseek-v4-flash'] },
    opencode: { models: ['deepseek-v4-flash', 'glm-5.1'] },
  })

  it('重名模型只给当前 provider 标一个星', () => {
    const { printed } = runModel('', settings, { providerId: 'opencode', model: 'deepseek-v4-flash' })
    const list = printed.join('\n')
    expect(list).toContain('* opencode/deepseek-v4-flash')
    expect(list).not.toContain('* deepseek/deepseek-v4-flash')
    // 只数带星的条目行（行首缩进 + '* '），别把表头里的 '* = 当前' 也算进来。
    const starredLines = list.split('\n').filter((l) => /^\s+\*\s/.test(l))
    expect(starredLines.length).toBe(1)
  })

  it('当前模型不在任何清单里：仍显式补一个当前标记', () => {
    const { printed } = runModel('', settings, { providerId: 'opencode', model: 'off-list-model' })
    const list = printed.join('\n')
    expect(list).toContain('* opencode/off-list-model')
    expect(list).toContain('不在已声明列表中')
  })
})
