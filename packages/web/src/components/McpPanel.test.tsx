import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import type { McpServerInfo } from '@zuse/protocol'
import { McpPanel } from './McpPanel.js'

const srv = (over: Partial<McpServerInfo> = {}): McpServerInfo => ({
  name: 'playwright', status: 'connected', command: 'npx', args: ['@playwright/mcp'], tools: [{ name: 'browser_click' }], ...over,
})

function renderPanel(over: Partial<Parameters<typeof McpPanel>[0]> = {}) {
  const props = { servers: [srv()], onAdd: vi.fn(), onDelete: vi.fn(), onReconnect: vi.fn(), ...over }
  return { ...props, ...render(<McpPanel {...props} />) }
}

describe('McpPanel', () => {
  it('lists servers with status and tool count; expands tools', () => {
    const { container } = renderPanel()
    expect(screen.getByText('playwright')).toBeInTheDocument()
    expect(container.querySelector('.mcp-status.connected')).not.toBeNull()
    expect(screen.getByText(/1 tools/)).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Show tools'))
    expect(screen.getByText('browser_click')).toBeInTheDocument()
  })

  it('shows the failed error and a restart note for configured servers', () => {
    renderPanel({ servers: [
      srv({ name: 'bad', status: 'failed', error: 'spawn ENOENT', tools: [] }),
      srv({ name: 'pending', status: 'configured', tools: [] }),
    ] })
    expect(screen.getByText('spawn ENOENT')).toBeInTheDocument()
    expect(screen.getByText(/click Reconnect to apply/)).toBeInTheDocument()
  })

  it('Reconnect button fires onReconnect', () => {
    const props = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /Reconnect/ }))
    expect(props.onReconnect).toHaveBeenCalled()
  })

  it('New form submits onAdd with name+command+args', () => {
    const props = renderPanel({ servers: [] })
    fireEvent.click(screen.getByText(/New/))
    fireEvent.change(screen.getByPlaceholderText('e.g. playwright'), { target: { value: 'pw' } })
    fireEvent.change(screen.getByPlaceholderText('e.g. npx'), { target: { value: 'npx' } })
    fireEvent.change(screen.getByPlaceholderText('@playwright/mcp'), { target: { value: '-y @playwright/mcp' } })
    fireEvent.click(screen.getByText('Add'))
    expect(props.onAdd).toHaveBeenCalledWith({ name: 'pw', command: 'npx', args: ['-y', '@playwright/mcp'] })
  })

  it('Add disabled without name+command', () => {
    renderPanel({ servers: [] })
    fireEvent.click(screen.getByText(/New/))
    expect((screen.getByText('Add') as HTMLButtonElement).disabled).toBe(true)
  })

  it('delete requires inline confirm', () => {
    const props = renderPanel()
    const row = screen.getAllByRole('listitem')[0]!
    fireEvent.click(within(row).getByLabelText('Delete server'))
    expect(props.onDelete).not.toHaveBeenCalled()
    fireEvent.click(within(row).getByLabelText('Confirm delete'))
    expect(props.onDelete).toHaveBeenCalledWith('playwright')
  })

  it('empty state', () => {
    renderPanel({ servers: [] })
    expect(screen.getByText(/No MCP servers/)).toBeInTheDocument()
  })
})
