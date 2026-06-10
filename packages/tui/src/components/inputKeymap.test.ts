import { describe, it, expect } from 'vitest'
import { keyToEvent, type KeyState } from './inputKeymap.js'

/** 造一个全 false 的按键状态，按需覆盖个别标志。 */
function k(overrides: Partial<KeyState> = {}): KeyState {
  return { ...overrides }
}

describe('keyToEvent', () => {
  it('普通字符 → insert', () => {
    expect(keyToEvent('a', k())).toEqual({ type: 'insert', text: 'a' })
  })

  it('Enter → submit（普通回车,Ink 给 input=\\r 且置 return 标志）', () => {
    expect(keyToEvent('\r', k({ return: true }))).toEqual({ type: 'submit' })
  })

  it('Ctrl+Enter（VSCode 集成终端）→ newline（经 keybindings 发 ESC+CR,Ink 剥 ESC 后为 input=\\r 且无 return）', () => {
    expect(keyToEvent('\r', k())).toEqual({ type: 'newline' })
  })

  it('Ctrl+J → newline（裸 LF,任何终端都能原生发出,无需 VSCode 配置；Ink 解析为 input=\\n 且无 return）', () => {
    expect(keyToEvent('\n', k())).toEqual({ type: 'newline' })
  })

  it('Ctrl+Enter → submit（ctrl 在 return 上被忽略）', () => {
    expect(keyToEvent('\r', k({ return: true, ctrl: true }))).toEqual({ type: 'submit' })
  })

  it('Alt+Enter → submit（meta 在 return 上被忽略）', () => {
    expect(keyToEvent('\r', k({ return: true, meta: true }))).toEqual({ type: 'submit' })
  })

  it('Backspace → backspace', () => {
    expect(keyToEvent('', k({ backspace: true }))).toEqual({ type: 'backspace' })
  })

  it('Delete 也当作 backspace（多数终端退格上报为 delete）', () => {
    expect(keyToEvent('', k({ delete: true }))).toEqual({ type: 'backspace' })
  })

  it('方向键 → 对应移动事件', () => {
    expect(keyToEvent('', k({ leftArrow: true }))).toEqual({ type: 'left' })
    expect(keyToEvent('', k({ rightArrow: true }))).toEqual({ type: 'right' })
    expect(keyToEvent('', k({ upArrow: true }))).toEqual({ type: 'up' })
    expect(keyToEvent('', k({ downArrow: true }))).toEqual({ type: 'down' })
  })

  it('Ctrl+A → home，Ctrl+E → end', () => {
    expect(keyToEvent('a', k({ ctrl: true }))).toEqual({ type: 'home' })
    expect(keyToEvent('e', k({ ctrl: true }))).toEqual({ type: 'end' })
  })

  it('Escape → none（交由上层处理，输入框忽略）', () => {
    expect(keyToEvent('', k({ escape: true }))).toEqual({ type: 'none' })
  })

  it('未绑定的 Ctrl 组合不插入字符 → none', () => {
    expect(keyToEvent('c', k({ ctrl: true }))).toEqual({ type: 'none' })
  })

  it('空输入且无特殊键 → none', () => {
    expect(keyToEvent('', k())).toEqual({ type: 'none' })
  })
})

describe('Shift+Enter 换行', () => {
  it('return + shift → newline', () => {
    expect(keyToEvent('', { return: true, shift: true })).toEqual({ type: 'newline' })
  })
  it('return 无 shift → submit', () => {
    expect(keyToEvent('', { return: true })).toEqual({ type: 'submit' })
  })
})
