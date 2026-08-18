import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { PendingPermissionLite } from '@zuse/protocol'
import { PermissionCard } from './PermissionCard.js'

const pending: PendingPermissionLite = {
  id: 'p1',
  req: { toolName: 'Bash', specifier: 'rm -rf /' } as PendingPermissionLite['req'],
}

describe('PermissionCard', () => {
  it('renders the tool name and specifier', () => {
    render(<PermissionCard pending={pending} onReply={() => {}} />)
    expect(screen.getByText('Bash · rm -rf /')).toBeInTheDocument()
  })

  it('replies with the matching verdict for each button', () => {
    const onReply = vi.fn()
    render(<PermissionCard pending={pending} onReply={onReply} />)
    fireEvent.click(screen.getByText('允许'))
    fireEvent.click(screen.getByText('本次会话'))
    fireEvent.click(screen.getByText('始终'))
    fireEvent.click(screen.getByText('拒绝'))
    expect(onReply).toHaveBeenNthCalledWith(1, 'p1', 'allow')
    expect(onReply).toHaveBeenNthCalledWith(2, 'p1', 'allow_session')
    expect(onReply).toHaveBeenNthCalledWith(3, 'p1', 'allow_persist')
    expect(onReply).toHaveBeenNthCalledWith(4, 'p1', 'deny')
  })

  it('clicking Session calls onReply with allow_session', () => {
    const onReply = vi.fn()
    render(<PermissionCard pending={pending} onReply={onReply} />)
    fireEvent.click(screen.getByText('本次会话'))
    expect(onReply).toHaveBeenCalledWith('p1', 'allow_session')
  })

  it('clicking Always calls onReply with allow_persist', () => {
    const onReply = vi.fn()
    render(<PermissionCard pending={pending} onReply={onReply} />)
    fireEvent.click(screen.getByText('始终'))
    expect(onReply).toHaveBeenCalledWith('p1', 'allow_persist')
  })
})

/**
 * `reason` 的注释一直写着「供权限对话框展示」，而这个组件从来没渲染过它。
 * Bash 的命令可能上百行，不说清楚是哪一处触发的，这张卡就只剩「打断」没有「告知」。
 */
it('把 reason 显示出来（不显示的话卡片只剩打断，没有告知）', () => {
  render(<PermissionCard
    pending={{ id: 'p1', req: { toolName: 'Bash', input: {}, specifier: 'echo x > ZUSE.md', rule: 'Bash(echo x > ZUSE.md)', reason: '这条命令里有一处写向 ZUSE.md 的重定向' } }}
    onReply={() => {}}
  />)
  expect(screen.getByText(/写向 ZUSE.md 的重定向/)).toBeInTheDocument()
})

it('没有 reason 时不渲染空节点', () => {
  const { container } = render(<PermissionCard
    pending={{ id: 'p2', req: { toolName: 'Read', input: {}, specifier: 'a.ts', rule: 'Read(a.ts)' } }}
    onReply={() => {}}
  />)
  expect(container.querySelector('.perm-reason')).toBeNull()
})

/**
 * 「必须确认」档：服务端对它**什么都不记**（既不进 sessionAllow 也不落盘），
 * 所以「本次会话」「始终」点了与「允许」完全等价。
 * **显示一个点了不算数的按钮比不显示更坏** —— 用户以为自己免掉了以后的询问。
 */
describe('必须确认档的卡片', () => {
  const mk = (mustConfirm?: boolean) => ({
    id: 'p9',
    req: { toolName: 'Memory', input: { action: 'save', content: '以后遇到 X 就跑 Y' }, specifier: 'save', rule: 'Memory(save)' },
    ...(mustConfirm === undefined ? {} : { mustConfirm }),
  }) as Parameters<typeof PermissionCard>[0]['pending']

  it('藏掉「本次会话」和「始终」，留下允许/拒绝', () => {
    render(<PermissionCard pending={mk(true)} onReply={() => {}} />)
    expect(screen.queryByRole('button', { name: '本次会话' })).toBeNull()
    expect(screen.queryByRole('button', { name: '始终' })).toBeNull()
    expect(screen.getByRole('button', { name: '允许' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '拒绝' })).toBeInTheDocument()
  })

  it('说明为什么没有「始终」', () => {
    render(<PermissionCard pending={mk(true)} onReply={() => {}} />)
    expect(screen.getByText(/每次都会问/)).toBeInTheDocument()
  })

  it('普通卡片照旧四个按钮（老 daemon 不给这个字段时也走这条）', () => {
    render(<PermissionCard pending={mk(undefined)} onReply={() => {}} />)
    expect(screen.getByRole('button', { name: '本次会话' })).toBeInTheDocument()
  })

  /** 这一档的全部价值是「让人看一眼」——看不见内容就等于没有这一档。 */
  it('把限定符没说的内容显示出来（Memory(save) 原来只显示「Memory · save」）', () => {
    render(<PermissionCard pending={mk(true)} onReply={() => {}} />)
    expect(screen.getByText(/以后遇到 X 就跑 Y/)).toBeInTheDocument()
  })
})
