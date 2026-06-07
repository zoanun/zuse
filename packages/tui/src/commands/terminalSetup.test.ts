import { describe, it, expect } from 'vitest'
import { parse as parseJsonc } from 'jsonc-parser'
import { detectEditor, keybindingsPath, upsertNewlineBindings } from './terminalSetup.js'

// 控制字符/反斜杠一律用 fromCharCode 拼装,避免源码里的转义在工具链各层被反复解释。
const ESC = String.fromCharCode(0x1b) // ESC
const CR = String.fromCharCode(0x0d) // 回车 \r
const LF = String.fromCharCode(0x0a) // 换行 \n
const BS = String.fromCharCode(0x5c) // 反斜杠 \
// VSCode keybinding 真正要发送的序列：ESC + CR。Ink 收到后剥掉 ESC 前缀剩裸 CR 当作换行。
const ESC_CR = ESC + CR

describe('detectEditor', () => {
  it('TERM_PROGRAM=vscode → vscode', () => {
    expect(detectEditor({ TERM_PROGRAM: 'vscode' })).toBe('vscode')
  })

  it('CURSOR_TRACE_ID 优先识别为 cursor（即便 TERM_PROGRAM 仍是 vscode）', () => {
    expect(detectEditor({ CURSOR_TRACE_ID: 'abc', TERM_PROGRAM: 'vscode' })).toBe('cursor')
  })

  it('VSCODE_GIT_ASKPASS_MAIN 含 cursor → cursor', () => {
    expect(detectEditor({ VSCODE_GIT_ASKPASS_MAIN: '/x/cursor/y.js', TERM_PROGRAM: 'vscode' })).toBe('cursor')
  })

  it('VSCODE_GIT_ASKPASS_MAIN 含 windsurf → windsurf', () => {
    expect(detectEditor({ VSCODE_GIT_ASKPASS_MAIN: '/x/.windsurf-server/y.js', TERM_PROGRAM: 'vscode' })).toBe(
      'windsurf',
    )
  })

  it('非内置编辑器终端（Apple_Terminal）→ null', () => {
    expect(detectEditor({ TERM_PROGRAM: 'Apple_Terminal' })).toBeNull()
  })

  it('空环境 → null', () => {
    expect(detectEditor({})).toBeNull()
  })
})

describe('keybindingsPath', () => {
  it('win32 / vscode → AppData\\Roaming\\Code\\User', () => {
    const home = ['C:', 'Users', 'me'].join(BS)
    const expected = ['C:', 'Users', 'me', 'AppData', 'Roaming', 'Code', 'User', 'keybindings.json'].join(BS)
    expect(keybindingsPath('vscode', 'win32', home)).toBe(expected)
  })

  it('darwin / cursor → Library/Application Support/Cursor/User', () => {
    expect(keybindingsPath('cursor', 'darwin', '/Users/me')).toBe(
      '/Users/me/Library/Application Support/Cursor/User/keybindings.json',
    )
  })

  it('linux / windsurf → .config/Windsurf/User', () => {
    expect(keybindingsPath('windsurf', 'linux', '/home/me')).toBe(
      '/home/me/.config/Windsurf/User/keybindings.json',
    )
  })
})

describe('upsertNewlineBindings', () => {
  interface Binding {
    key?: string
    command?: string
    args?: { text?: string }
    when?: string
  }
  // 解析结果里按 key 取出对应的换行绑定，便于断言。
  const findBinding = (content: string, key: string): Binding | undefined => {
    const arr = parseJsonc(content) as Binding[]
    return arr.find((b) => b.key === key && b.command === 'workbench.action.terminal.sendSequence')
  }

  it('空内容 → 新建数组并写入 Ctrl+Enter 一条绑定，args.text 为 ESC+CR', () => {
    const { content, added } = upsertNewlineBindings('')
    expect(added).toEqual(['ctrl+enter'])
    const arr = parseJsonc(content) as unknown[]
    expect(arr).toHaveLength(1)
    expect(findBinding(content, 'ctrl+enter')).toEqual({
      key: 'ctrl+enter',
      command: 'workbench.action.terminal.sendSequence',
      args: { text: ESC_CR },
      when: 'terminalFocus',
    })
  })

  it('Ctrl+Enter 已存在 → added 为空且内容原样不动', () => {
    const existing = JSON.stringify(
      [
        {
          key: 'ctrl+enter',
          command: 'workbench.action.terminal.sendSequence',
          args: { text: ESC_CR },
          when: 'terminalFocus',
        },
      ],
      null,
      2,
    )
    const { content, added } = upsertNewlineBindings(existing)
    expect(added).toEqual([])
    expect(content).toBe(existing)
  })

  it('已有无关的 shift+enter 绑定 → 追加 Ctrl+Enter 且不覆盖它，保留顶部注释', () => {
    const existing = [
      '// 我的快捷键',
      '[',
      '  { "key": "shift+enter", "command": "workbench.action.terminal.sendSequence", "args": { "text": "X" }, "when": "terminalFocus" }',
      ']',
      '',
    ].join(LF)
    const { content, added } = upsertNewlineBindings(existing)
    expect(added).toEqual(['ctrl+enter'])
    expect(content).toContain('// 我的快捷键')
    const arr = parseJsonc(content) as unknown[]
    expect(arr).toHaveLength(2)
    expect(findBinding(content, 'ctrl+enter')).toBeTruthy()
    expect(findBinding(content, 'shift+enter')).toBeTruthy()
  })

  it('已有无关绑定 ctrl+k → 追加 Ctrl+Enter 一条，保留顶部注释', () => {
    const existing = ['// 我的快捷键', '[', '  { "key": "ctrl+k", "command": "foo" }', ']', ''].join(LF)
    const { content, added } = upsertNewlineBindings(existing)
    expect(added).toEqual(['ctrl+enter'])
    expect(content).toContain('// 我的快捷键')
    const arr = parseJsonc(content) as unknown[]
    expect(arr).toHaveLength(2)
  })
})
