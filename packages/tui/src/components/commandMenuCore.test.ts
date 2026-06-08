import { describe, it, expect } from 'vitest'
import {
  isCommandMenuActive,
  commandMenuQuery,
  filterCommands,
  wrapIndex,
  type CommandInfo,
} from './commandMenuCore.js'

const CMDS: CommandInfo[] = [
  { name: 'help', description: '列出所有可用命令' },
  { name: 'config', description: '显示当前生效配置' },
  { name: 'clear', description: '清空对话历史' },
  { name: 'save', description: '保存当前对话', takesArgs: true },
  { name: 'load', description: '加载已保存的对话', takesArgs: true },
  { name: 'model', description: '查看或切换模型' },
]

describe('isCommandMenuActive', () => {
  it('裸 / 与正在敲的命令名都激活', () => {
    expect(isCommandMenuActive('/')).toBe(true)
    expect(isCommandMenuActive('/cl')).toBe(true)
    expect(isCommandMenuActive('/terminal-setup')).toBe(true)
  })
  it('打了空格（进入参数）或非斜杠输入不激活', () => {
    expect(isCommandMenuActive('/save ')).toBe(false)
    expect(isCommandMenuActive('/save foo')).toBe(false)
    expect(isCommandMenuActive('')).toBe(false)
    expect(isCommandMenuActive('hello')).toBe(false)
    expect(isCommandMenuActive(' /clear')).toBe(false) // 前导空格 → 非起始场景
  })
})

describe('commandMenuQuery', () => {
  it('取 / 之后的片段', () => {
    expect(commandMenuQuery('/')).toBe('')
    expect(commandMenuQuery('/cl')).toBe('cl')
  })
  it('非菜单输入返回空串', () => {
    expect(commandMenuQuery('/save foo')).toBe('')
    expect(commandMenuQuery('hi')).toBe('')
  })
})

describe('filterCommands', () => {
  it('空词返回全部，保持声明顺序', () => {
    expect(filterCommands(CMDS, '').map((c) => c.name)).toEqual([
      'help',
      'config',
      'clear',
      'save',
      'load',
      'model',
    ])
  })

  it('前缀匹配把对应命令排到最前', () => {
    const out = filterCommands(CMDS, 'cl').map((c) => c.name)
    expect(out[0]).toBe('clear')
    expect(out).not.toContain('help') // help 无子序列 'cl'
  })

  it('精确名优先于其它前缀同字头候选', () => {
    const cmds: CommandInfo[] = [
      { name: 'config', description: '' },
      { name: 'co', description: '' },
    ]
    // 'co' 精确名 > 'config' 前缀名
    expect(filterCommands(cmds, 'co').map((c) => c.name)).toEqual(['co', 'config'])
  })

  it('能匹配到描述（命令名不含该词时）', () => {
    const out = filterCommands(CMDS, '历史').map((c) => c.name)
    expect(out).toContain('clear') // 描述「清空对话历史」命中
  })

  it('无匹配返回空数组', () => {
    expect(filterCommands(CMDS, 'zzzzz')).toEqual([])
  })
})

describe('wrapIndex', () => {
  it('到顶再上回末尾、到底再下回开头', () => {
    expect(wrapIndex(-1, 3)).toBe(2)
    expect(wrapIndex(3, 3)).toBe(0)
    expect(wrapIndex(1, 3)).toBe(1)
  })
  it('空列表返回 0', () => {
    expect(wrapIndex(-1, 0)).toBe(0)
  })
})
