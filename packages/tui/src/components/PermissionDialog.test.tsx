import { describe, it, expect, vi } from 'vitest'
import { render } from 'ink-testing-library'
import { Text } from 'ink'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PermissionRequest } from '@zuse/core'

/**
 * 这个组件**此前一条测试都没有**，而且 TUI 的 `.tsx` 测试根本进不了门禁
 * （根 vitest 的 include 是 `*.test.ts`，不含 `.tsx` —— 同一轮一起修了）。
 *
 * 补的时候钉住两件刚改的事：
 *  1. **限定符没说的那部分要显示出来。** `Memory(save)` 那张卡原来只有「Memory: save」，
 *     而「必须确认」这一档的全部价值就是让人看一眼。
 *  2. **「必须确认」档要藏掉两个「总是允许」。** 服务端对这一档什么都不记，
 *     点了与「允许本次」完全等价 —— 显示一个点了不算数的选项比不显示更坏。
 *
 * `SelectList` 用替身：它内部要 raw-mode 的 stdin，在测试环境里直接抛。
 * 而且**断言它收到了哪些选项**比在渲染字符串里找词更准 —— 后者会被换行、
 * 截断、颜色码搅乱。
 */
vi.mock('./SelectList.js', () => ({
  SelectList: ({ items }: { items: Array<{ value: string; label: string }> }) =>
    <Text>{'OPTS:' + items.map((i) => i.value).join(',')}</Text>,
}))

const { PermissionDialog } = await import('./PermissionDialog.js')

const req = (over: Partial<PermissionRequest>): PermissionRequest => ({
  toolName: 'Bash', input: { command: 'ls' }, specifier: 'ls', rule: 'Bash(ls)', ...over,
})
const frame = (r: PermissionRequest): string =>
  render(<PermissionDialog req={r} onDecision={() => {}} />).lastFrame() ?? ''

describe('PermissionDialog', () => {
  it('普通调用：四档裁决都在', () => {
    expect(frame(req({}))).toContain('OPTS:allow,allow_session,allow_persist,deny')
  })

  it('限定符已经说过的字段不重复显示', () => {
    // `command` 的值就是限定符，标题行已经写了 —— 不该再出现一行 `command: ls`
    expect(frame(req({}))).not.toContain('command: ls')
  })

  it('Memory(save)：内容要看得见（原来只显示「Memory: save」）', () => {
    const f = frame(req({
      toolName: 'Memory', specifier: 'save', rule: 'Memory(save)',
      input: { action: 'save', content: '以后遇到 X 就跑 Y' },
    }))
    expect(f).toContain('以后遇到')
  })

  it('必须确认档：两个「总是允许」不出现，并说明为什么', () => {
    const target = join(homedir(), '.zuse', 'MEMORY.md')
    const f = frame(req({
      toolName: 'Write', specifier: target, rule: `Write(${target})`,
      input: { file_path: target, content: 'x' },
    }))
    expect(f).toContain('OPTS:allow,deny')
    expect(f).not.toContain('allow_session')
    expect(f).toContain('每次都会问')
  })

  /** 入参是模型输出、直接打进终端 —— ESC/OSC 能清屏、移光标、伪造提示行。 */
  it('剥掉控制字符', () => {
    const ESC = String.fromCharCode(27)
    const f = frame(req({
      toolName: 'Memory', specifier: 'save',
      input: { action: 'save', content: `正常${ESC}[2J文本` },
    }))
    expect(f).not.toContain(`${ESC}[2J`)
  })
})
