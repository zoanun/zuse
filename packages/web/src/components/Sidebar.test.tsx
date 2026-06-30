import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import type { SessionMeta } from '@zuse/protocol'
import { Sidebar } from './Sidebar.js'
import { searchSessions } from '../state/session.js'

vi.mock('../state/session.js', async (orig) => ({
  ...(await orig<typeof import('../state/session.js')>()),
  searchSessions: vi.fn(async () => [
    {
      session: { id: 's1', title: '会话一', cwd: '/work', updatedAt: '2026-06-30T10:00:00Z' },
      hits: [{ msgIndex: 2, role: 'user', snippet: { pre: '前', match: 'needle', post: '后' } }],
      hitCount: 1,
    },
  ]),
}))

const meta = (id: string, title: string): SessionMeta => ({
  id, title, createdAt: '', updatedAt: '', cwd: '/', messageCount: 0,
})

function renderSidebar(over: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const props = {
    sessions: [meta('a', 'Alpha'), meta('b', '')],
    currentSessionId: 'a',
    onNewChat: vi.fn(),
    onSwitch: vi.fn(),
    onDelete: vi.fn(),
    onRename: vi.fn(),
    onJump: vi.fn(),
    ...over,
  }
  render(<Sidebar {...props} />)
  return props
}

describe('Sidebar', () => {
  it('renders one row per session; empty title shows "New chat"', () => {
    renderSidebar()
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    // empty-title session falls back to "New chat" (separate from the button)
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(within(items[1]!).getByText('New chat')).toBeInTheDocument()
  })

  it('marks the current session row active', () => {
    renderSidebar({ currentSessionId: 'a' })
    const items = screen.getAllByRole('listitem')
    expect(items[0]!.className).toContain('active')
    expect(items[1]!.className).not.toContain('active')
  })

  it('clicking a row switches to it', () => {
    const props = renderSidebar()
    fireEvent.click(screen.getByText('Alpha'))
    expect(props.onSwitch).toHaveBeenCalledWith('a')
  })

  it('New chat button fires onNewChat', () => {
    const props = renderSidebar({ sessions: [] }) // no rows → only the button reads "New chat"
    fireEvent.click(screen.getByText(/New chat/))
    expect(props.onNewChat).toHaveBeenCalled()
  })

  it('delete requires inline confirm before firing onDelete', () => {
    const props = renderSidebar()
    const items = screen.getAllByRole('listitem')
    fireEvent.click(within(items[0]!).getByLabelText('Delete session'))
    // not yet deleted — confirm UI shown
    expect(props.onDelete).not.toHaveBeenCalled()
    fireEvent.click(within(items[0]!).getByLabelText('Confirm delete'))
    expect(props.onDelete).toHaveBeenCalledWith('a')
  })

  it('canceling the delete confirm does not fire onDelete', () => {
    const props = renderSidebar()
    const items = screen.getAllByRole('listitem')
    fireEvent.click(within(items[0]!).getByLabelText('Delete session'))
    fireEvent.click(within(items[0]!).getByLabelText('Cancel delete'))
    expect(props.onDelete).not.toHaveBeenCalled()
  })

  it('double-click title → input; Enter commits via onRename', () => {
    const props = renderSidebar()
    fireEvent.doubleClick(screen.getByText('Alpha'))
    const input = screen.getByDisplayValue('Alpha') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onRename).toHaveBeenCalledWith('a', 'Renamed')
  })

  it('rename commit ignores an empty/blank title', () => {
    const props = renderSidebar()
    fireEvent.doubleClick(screen.getByText('Alpha'))
    const input = screen.getByDisplayValue('Alpha')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onRename).not.toHaveBeenCalled()
  })

  it('Esc cancels rename without firing onRename', () => {
    const props = renderSidebar()
    fireEvent.doubleClick(screen.getByText('Alpha'))
    const input = screen.getByDisplayValue('Alpha')
    fireEvent.change(input, { target: { value: 'Nope' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(props.onRename).not.toHaveBeenCalled()
    expect(screen.getByText('Alpha')).toBeInTheDocument()
  })

  it('double-click then blur WITHOUT changing the title does not fire onRename', () => {
    // Regression: a no-op edit must not pin the title as manual (which would
    // freeze it and clobber the auto-generated title).
    const props = renderSidebar()
    fireEvent.doubleClick(screen.getByText('Alpha'))
    const input = screen.getByDisplayValue('Alpha')
    fireEvent.blur(input)
    expect(props.onRename).not.toHaveBeenCalled()
  })

  it('changing the title then blurring commits the rename', () => {
    const props = renderSidebar()
    fireEvent.doubleClick(screen.getByText('Alpha'))
    const input = screen.getByDisplayValue('Alpha')
    fireEvent.change(input, { target: { value: 'Beta' } })
    fireEvent.blur(input)
    expect(props.onRename).toHaveBeenCalledWith('a', 'Beta')
  })

  it('Esc after changing text does not commit on the unmount blur', () => {
    const props = renderSidebar()
    fireEvent.doubleClick(screen.getByText('Alpha'))
    const input = screen.getByDisplayValue('Alpha')
    fireEvent.change(input, { target: { value: 'Changed' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.blur(input) // unmount blur — must be suppressed by the cancel guard
    expect(props.onRename).not.toHaveBeenCalled()
  })

  it('typing enters results mode and renders the hit snippet', async () => {
    renderSidebar()
    fireEvent.change(screen.getByPlaceholderText(/搜索/), { target: { value: 'needle' } })
    await waitFor(() => expect(searchSessions).toHaveBeenCalled())
    expect(await screen.findByText('会话一')).toBeInTheDocument()
    expect(screen.getByText('needle')).toBeInTheDocument()
    // session list rows are gone in results mode
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
  })

  it('clicking a hit calls onJump(sessionId, msgIndex)', async () => {
    const props = renderSidebar()
    fireEvent.change(screen.getByPlaceholderText(/搜索/), { target: { value: 'needle' } })
    const hit = await screen.findByText('needle')
    fireEvent.click(hit)
    expect(props.onJump).toHaveBeenCalledWith('s1', 2)
  })

  it('clearing the search box restores the session list', async () => {
    renderSidebar()
    const box = screen.getByPlaceholderText(/搜索/)
    fireEvent.change(box, { target: { value: 'needle' } })
    expect(await screen.findByText('会话一')).toBeInTheDocument()
    fireEvent.change(box, { target: { value: '' } })
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())
    expect(screen.queryByText('会话一')).not.toBeInTheDocument()
  })
})
