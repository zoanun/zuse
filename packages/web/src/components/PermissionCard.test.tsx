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
