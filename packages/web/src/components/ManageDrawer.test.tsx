import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ManageDrawer } from './ManageDrawer.js'

// Mock the data layer so the drawer's Memory container doesn't hit the network.
vi.mock('../state/manageApi.js', () => ({
  listMemory: vi.fn(async () => []),
  createMemory: vi.fn(async () => ({})),
  updateMemory: vi.fn(async () => ({})),
  deleteMemory: vi.fn(async () => undefined),
  listProjects: vi.fn(async () => []),
  listPersonas: vi.fn(async () => ({ personas: [], activeId: null })),
  createPersona: vi.fn(async () => ({})),
  updatePersona: vi.fn(async () => ({})),
  deletePersona: vi.fn(async () => undefined),
  activatePersona: vi.fn(async () => undefined),
  listMcp: vi.fn(async () => []),
  addMcp: vi.fn(async () => undefined),
  deleteMcp: vi.fn(async () => undefined),
}))

import { listMemory, listPersonas, listMcp } from '../state/manageApi.js'

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
  it('renders the nav with Memory active; Personas enabled; others disabled (soon)', () => {
    renderDrawer()
    const memBtn = screen.getByRole('button', { name: /Memory/ })
    expect(memBtn.className).toContain('active')
    // Personas (the M2 panel) is now enabled, not "soon".
    expect((screen.getByRole('button', { name: /Personas/ }) as HTMLButtonElement).disabled).toBe(false)
    // Skills/MCP/Usage are still placeholders.
    expect(screen.getAllByText('soon').length).toBeGreaterThan(0)
  })

  it('loads personas via listPersonas when switched to the Personas panel', async () => {
    renderDrawer({ activePanel: 'prompts' })
    await waitFor(() => expect(listPersonas).toHaveBeenCalled())
  })

  it('loads MCP servers via listMcp when switched to the MCP panel', async () => {
    renderDrawer({ activePanel: 'mcp' })
    await waitFor(() => expect(listMcp).toHaveBeenCalled())
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
