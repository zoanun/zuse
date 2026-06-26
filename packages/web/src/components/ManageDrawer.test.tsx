import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ManageDrawer } from './ManageDrawer.js'

// Mock the data layer so the drawer's Memory container doesn't hit the network.
vi.mock('../state/manageApi.js', () => ({
  listMemory: vi.fn(async () => []),
  createMemory: vi.fn(async () => ({})),
  updateMemory: vi.fn(async () => ({})),
  deleteMemory: vi.fn(async () => undefined),
}))

import { listMemory } from '../state/manageApi.js'

function renderDrawer(over: Partial<Parameters<typeof ManageDrawer>[0]> = {}) {
  const props = {
    open: true,
    activePanel: 'memory' as const,
    onClose: vi.fn(),
    onSelectPanel: vi.fn(),
    ...over,
  }
  render(<ManageDrawer {...props} />)
  return props
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { vi.restoreAllMocks() })

describe('ManageDrawer', () => {
  it('renders the nav with Memory active and other items disabled (soon)', () => {
    renderDrawer()
    const memBtn = screen.getByRole('button', { name: /Memory/ })
    expect(memBtn.className).toContain('active')
    expect((screen.getByRole('button', { name: /Prompts/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getAllByText('soon').length).toBeGreaterThan(0)
  })

  it('loads memory via listMemory when open on the memory panel', async () => {
    renderDrawer()
    await waitFor(() => expect(listMemory).toHaveBeenCalled())
  })

  it('clicking the backdrop calls onClose', async () => {
    const props = renderDrawer()
    await waitFor(() => expect(listMemory).toHaveBeenCalled()) // let the load settle
    fireEvent.click(document.querySelector('.manage-backdrop')!)
    expect(props.onClose).toHaveBeenCalled()
  })

  it('the close (×) button calls onClose', async () => {
    const props = renderDrawer()
    await waitFor(() => expect(listMemory).toHaveBeenCalled())
    fireEvent.click(screen.getByLabelText('Close'))
    expect(props.onClose).toHaveBeenCalled()
  })

  it('Escape calls onClose when open', async () => {
    const props = renderDrawer()
    await waitFor(() => expect(listMemory).toHaveBeenCalled())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalled()
  })

  it('does not load or react to Escape when closed', () => {
    const props = renderDrawer({ open: false })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(props.onClose).not.toHaveBeenCalled()
    expect(listMemory).not.toHaveBeenCalled()
  })

  it('has the open class only when open', () => {
    const { container } = render(<ManageDrawer open={false} activePanel="memory" onClose={vi.fn()} onSelectPanel={vi.fn()} />)
    expect(container.querySelector('.manage-root')!.className).not.toContain('open')
  })
})
