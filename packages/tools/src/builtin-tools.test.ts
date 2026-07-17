import { describe, it, expect } from 'vitest'
import { createDefaultRegistry } from './index.js'
import type { WebSearchConfig } from '@zuse/core'
import { toolModule as readToolModule } from './read.js'
import { toolModule as skillToolModule } from './skills.js'
import { toolModule as websearchToolModule } from './websearch.js'
import { toolModule as lspToolModule } from './lsp/index.js'
import { toolModule as lspInstallToolModule } from './lsp/install.js'

// 取注册表里工具名的有序列表。ToolRegistry.list() 按注册顺序返回。
function names(opts: Parameters<typeof createDefaultRegistry>[0] = {}): string[] {
  return createDefaultRegistry(opts).list().map((t) => t.name)
}

// 假的 LspManager / WebSearchConfig / SkillEntry：只要能让条件分支注册工具即可，不触发真实 I/O。
const fakeLsp = {} as unknown as import('./lsp/manager.js').LspManager
const fakeWebSearch = { provider: 'brave', apiKey: 'x' } as unknown as WebSearchConfig
const fakeSkills = [{ name: 's', description: 'd', body: 'b', path: '/tmp/s' }] as unknown as
  import('./skills.js').SkillEntry[]

describe('createDefaultRegistry — 内置工具集与顺序（回归锁）', () => {
  it('{} → 无条件工具集', () => {
    expect(names({})).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'Memory'])
  })
  it('{skills} → 追加 Skill', () => {
    expect(names({ skills: fakeSkills })).toEqual([
      'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'Memory', 'Skill',
    ])
  })
  it('空 skills 数组 → 不追加 Skill', () => {
    expect(names({ skills: [] })).not.toContain('Skill')
  })
  it('{webSearch} → 追加 WebSearch', () => {
    expect(names({ webSearch: fakeWebSearch })).toContain('WebSearch')
  })
  it('{lsp} → 追加 Lsp 和 LspInstall（顺序 Lsp 在前）', () => {
    const n = names({ lsp: fakeLsp })
    expect(n.slice(-2)).toEqual(['Lsp', 'LspInstall'])
  })
  it('全开 → 完整有序集', () => {
    expect(names({ skills: fakeSkills, webSearch: fakeWebSearch, lsp: fakeLsp })).toEqual([
      'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'Memory',
      'Skill', 'WebSearch', 'Lsp', 'LspInstall',
    ])
  })
})

describe('toolModule.enabled 真值表', () => {
  it('skill: 空/无 → 关，非空 → 开', () => {
    expect(skillToolModule.enabled!({})).toBe(false)
    expect(skillToolModule.enabled!({ skills: [] })).toBe(false)
    expect(skillToolModule.enabled!({ skills: fakeSkills })).toBe(true)
  })
  it('websearch: 无 → 关，有 → 开', () => {
    expect(websearchToolModule.enabled!({})).toBe(false)
    expect(websearchToolModule.enabled!({ webSearch: fakeWebSearch })).toBe(true)
  })
  it('lsp / lspInstall: 无 lsp → 关，有 → 开', () => {
    expect(lspToolModule.enabled!({})).toBe(false)
    expect(lspInstallToolModule.enabled!({})).toBe(false)
    expect(lspToolModule.enabled!({ lsp: fakeLsp })).toBe(true)
    expect(lspInstallToolModule.enabled!({ lsp: fakeLsp })).toBe(true)
  })
  it('无条件工具无 enabled（缺省启用）', () => {
    expect('enabled' in readToolModule).toBe(false)
  })
})
