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
    fireEvent.click(screen.getByText('Allow'))
    fireEvent.click(screen.getByText('Always'))
    fireEvent.click(screen.getByText('Deny'))
    expect(onReply).toHaveBeenNthCalledWith(1, 'p1', 'allow')
    expect(onReply).toHaveBeenNthCalledWith(2, 'p1', 'allow_session')
    expect(onReply).toHaveBeenNthCalledWith(3, 'p1', 'deny')
  })
})
