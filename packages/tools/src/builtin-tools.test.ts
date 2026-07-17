import { describe, it, expect } from 'vitest'
import { createDefaultRegistry } from './index.js'
import type { WebSearchConfig } from '@zuse/core'

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
