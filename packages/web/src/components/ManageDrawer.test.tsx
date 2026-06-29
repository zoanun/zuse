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
  listSkills: vi.fn(async () => ({ skills: [] })),
  updateSkill: vi.fn(async () => ({})),
  getUsage: vi.fn(async () => ({ total: { input_tokens: 0, output_tokens: 0 }, sessionCount: 0, byModel: [], sessions: [] })),
  listDir: vi.fn(async () => ({ path: '', entries: [] })),
  readFilePreview: vi.fn(async () => ({ path: '', content: '', truncated: false, binary: false, size: 0 })),
  listMcp: vi.fn(async () => []),
  addMcp: vi.fn(async () => undefined),
  deleteMcp: vi.fn(async () => undefined),
  reconnectMcp: vi.fn(async () => undefined),
  reconnectMcpServer: vi.fn(async () => undefined),
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
  it('renders the nav with Memory active and every panel enabled (no "soon" left)', () => {
    renderDrawer()
    const memBtn = screen.getByRole('button', { name: /Memory/ })
    expect(memBtn.className).toContain('active')
    // All panels (Memory/Personas/Skills/MCP/Usage/Files) are now shipped — none disabled.
    for (const name of [/Memory/, /Personas/, /Skills/, /MCP/, /Usage/, /Files/]) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false)
    }
    expect(screen.queryByText('soon')).toBeNull()
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
