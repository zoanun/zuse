import { describe, it, expect } from 'vitest'
import { buildModelSelectItems } from './modelSelectItems.js'
import type { ModelOption } from '../commands/registry.js'

describe('buildModelSelectItems — 按 provider 分组成 SelectList 候选', () => {
  it('每组前插一条 header，option 的 value 用原下标、label 只显模型名', () => {
    const options: ModelOption[] = [
      { providerId: 'openai', model: 'gpt-5', isCurrent: false },
      { providerId: 'openai', model: 'gpt-4o', isCurrent: true },
      { providerId: 'deepseek', model: 'deepseek-v4', isCurrent: false },
    ]
    expect(buildModelSelectItems(options)).toEqual([
      { value: '__header__0', label: 'openai', kind: 'header' },
      { value: '0', label: 'gpt-5', filterText: 'openai/gpt-5' },
      { value: '1', label: 'gpt-4o', filterText: 'openai/gpt-4o' },
      { value: '__header__2', label: 'deepseek', kind: 'header' },
      { value: '2', label: 'deepseek-v4', filterText: 'deepseek/deepseek-v4' },
    ])
  })

  it('option 的 value 下标可直接回查原 options', () => {
    const options: ModelOption[] = [
      { providerId: 'a', model: 'm0', isCurrent: false },
      { providerId: 'b', model: 'm1', isCurrent: false },
    ]
    const items = buildModelSelectItems(options)
    const opt = items.find((i) => i.value === '1')
    expect(opt?.label).toBe('m1')
    expect(options[Number('1')]).toEqual({ providerId: 'b', model: 'm1', isCurrent: false })
  })

  it('同 provider 非连续出现(末尾补的当前项)：用下标做 header key，避免撞车', () => {
    // buildModelOptions 把「当前项」补在末尾，可能重复某 provider；header value 含下标保证唯一
    const options: ModelOption[] = [
      { providerId: 'openai', model: 'gpt-5', isCurrent: false },
      { providerId: 'deepseek', model: 'deepseek-v4', isCurrent: false },
      { providerId: 'openai', model: 'gpt-custom', isCurrent: true },
    ]
    const items = buildModelSelectItems(options)
    const headers = items.filter((i) => i.kind === 'header')
    expect(headers.map((h) => h.value)).toEqual(['__header__0', '__header__1', '__header__2'])
    // value 唯一(无 React key 撞车)
    expect(new Set(items.map((i) => i.value)).size).toBe(items.length)
  })

  it('空 options 返回空', () => {
    expect(buildModelSelectItems([])).toEqual([])
  })
})
