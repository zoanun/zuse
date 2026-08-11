import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Header } from './Header.js'
import { BypassBanner } from './BypassBanner.js'
import { PERMISSION_MODES, modeInfo, nextMode } from './permissionMode.js'
import { initialState, reduce } from '../state/reducer.js'
import type { AppState } from '../state/types.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const noop = () => {}
function headerProps(state: AppState, onCycle = noop as (m: never) => void) {
  return { state, onMenu: noop, onOpenManage: noop, onChangeCwd: noop, onSwitchModel: noop, onCyclePermissionMode: onCycle as never, cleanView: true, onToggleCleanView: noop }
}

describe('nextMode —— 点击 chip 的循环顺序', () => {
  it('询问 → 自动接受编辑 → 全自主 → 询问', () => {
    expect(nextMode('default')).toBe('acceptEdits')
    expect(nextMode('acceptEdits')).toBe('bypass')
    expect(nextMode('bypass')).toBe('default')
  })
})

describe('档位文案（§2 / §3：写机械行为，不写承诺）', () => {
  it('三档齐全，标签是中文', () => {
    expect(PERMISSION_MODES.map((m) => m.mode)).toEqual(['default', 'acceptEdits', 'bypass'])
    expect(PERMISSION_MODES.map((m) => m.label)).toEqual(['询问', '自动接受编辑', '全自主'])
  })

  it('「询问」档不写成「每次写文件都会问你」—— 当前配置下 Write 在 allow 表里，根本不问', () => {
    const desc = modeInfo('default').desc
    expect(desc).not.toMatch(/每次.*(写|编辑).*都会问/)
    // 必须点明 allow 规则在兜底判定之前生效，否则用户会拿它当「全都会问」的保证
    expect(desc).toContain('allow')
  })

  it('「全自主」档不宣称护栏比实际厚：只承认 deny 与 Bash 安全检查两道', () => {
    const desc = modeInfo('bypass').desc
    // 必须点名仅剩的两道，且明说没有别的 —— 用户会按文案上写的去用它
    expect(desc).toContain('deny')
    expect(desc).toContain('安全检查')
    expect(desc).toContain('没有别的检查')
    // 不许出现任何「你仍然是安全的」式措辞
    expect(desc).not.toMatch(/保护|护栏|放心|安全的/)
  })
})

describe('Header 的权限 chip', () => {
  it('可编辑时渲染，点击按循环顺序上报下一档', () => {
    const onCycle = vi.fn()
    render(<Header {...headerProps({ ...initialState, permissionModeEditable: true, permissionMode: 'default' }, onCycle)} />)
    fireEvent.click(screen.getByRole('button', { name: /权限 询问/ }))
    expect(onCycle).toHaveBeenCalledWith('acceptEdits')
  })

  it('非交互会话（permissionModeEditable=false）不渲染这个 chip —— 点了不生效的开关比没有更糟', () => {
    render(<Header {...headerProps({ ...initialState, permissionModeEditable: false, permissionMode: 'default' })} />)
    expect(screen.queryByRole('button', { name: /权限/ })).toBeNull()
  })

  it('全自主档带告警色 class', () => {
    render(<Header {...headerProps({ ...initialState, permissionModeEditable: true, permissionMode: 'bypass' })} />)
    expect(screen.getByRole('button', { name: /权限 全自主/ }).className).toContain('chip-danger')
  })
})

describe('全自主常驻横幅', () => {
  it('只在全自主档出现', () => {
    const { container: c1 } = render(<BypassBanner mode="default" count={0} onExit={noop} />)
    expect(c1.querySelector('.bypass-banner')).toBeNull()
    cleanup()
    const { container: c2 } = render(<BypassBanner mode="acceptEdits" count={0} onExit={noop} />)
    expect(c2.querySelector('.bypass-banner')).toBeNull()
    cleanup()
    const { container: c3 } = render(<BypassBanner mode="bypass" count={0} onExit={noop} />)
    expect(c3.querySelector('.bypass-banner')).not.toBeNull()
  })

  it('显示自动放行次数，并给一个一键切回的出口', () => {
    const onExit = vi.fn()
    render(<BypassBanner mode="bypass" count={7} onExit={onExit} />)
    expect(screen.getByRole('status').textContent).toContain('7')
    fireEvent.click(screen.getByRole('button', { name: '切回询问' }))
    expect(onExit).toHaveBeenCalled()
  })
})

describe('reducer', () => {
  it('permission-mode-changed 同时更新档位与计数（同一帧，横幅不会先闪旧数字）', () => {
    const s = reduce(initialState, { kind: 'server', msg: { type: 'event', event: { type: 'permission-mode-changed', mode: 'bypass', autoAllowedCount: 4 } } })
    expect(s.permissionMode).toBe('bypass')
    expect(s.autoAllowedCount).toBe(4)
  })

  it('快照带回档位（刷新页面不丢）', () => {
    const s = reduce(initialState, { kind: 'server', msg: { type: 'snapshot', snapshot: {
      sessionId: 'x', isThinking: false, model: 'm', modelProviderId: 'p', cwd: '/x',
      totalUsage: undefined, contextTokens: 1, contextWindow: 2, todos: [], backgroundAgents: [],
      pendingPermissions: [], permissionMode: 'acceptEdits', permissionModeEditable: true, autoAllowedCount: 2,
      messageCount: 0, messages: [], checkpoints: [],
    } } })
    expect(s.permissionMode).toBe('acceptEdits')
    expect(s.permissionModeEditable).toBe(true)
    expect(s.autoAllowedCount).toBe(2)
  })

  it('初始态是最保守的一组：询问档 + 不可编辑（快照到达前不画一个假开关）', () => {
    expect(initialState.permissionMode).toBe('default')
    expect(initialState.permissionModeEditable).toBe(false)
  })
})
