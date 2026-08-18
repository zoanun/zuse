import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TrustedRootsPanel } from './TrustedRootsPanel.js'

function renderPanel(over: Partial<Parameters<typeof TrustedRootsPanel>[0]> = {}) {
  const props = {
    roots: ['E:/proj-a', 'E:/gone'], missing: ['E:/gone'],
    loading: false, error: null as string | null, onUntrust: vi.fn(), ...over,
  }
  return { ...props, ...render(<TrustedRootsPanel {...props} />) }
}

describe('TrustedRootsPanel', () => {
  it('列出每一个受信目录', () => {
    renderPanel()
    expect(screen.getByText('E:/proj-a')).toBeInTheDocument()
    expect(screen.getByText('E:/gone')).toBeInTheDocument()
  })

  /**
   * 陈旧条目是这个功能最危险的形态：信任比的是**路径字面量**，
   * 同一路径日后被重建（把另一个仓库 clone 回原位）会直接继承信任。
   * 不标出来，用户就不会去清 —— 那这个面板等于白做。
   */
  it('目录已经不在的条目要标出来，且只标那一条', () => {
    const { container } = renderPanel()
    const stale = container.querySelectorAll('.trust-row.missing')
    expect(stale).toHaveLength(1)
    expect(stale[0]!.textContent).toContain('E:/gone')
  })

  it('点撤销把那个目录传出去', () => {
    const { onUntrust } = renderPanel()
    fireEvent.click(screen.getAllByRole('button', { name: '撤销信任' })[1]!)
    expect(onUntrust).toHaveBeenCalledWith('E:/gone')
  })

  it('空表有明确的说明，不是一片空白', () => {
    renderPanel({ roots: [], missing: [] })
    expect(screen.getByText(/还没有信任过任何目录/)).toBeInTheDocument()
  })

  it('出错时显示错误，而不是装作空表', () => {
    renderPanel({ roots: [], missing: [], error: '读不到' })
    expect(screen.getByText(/读不到/)).toBeInTheDocument()
    expect(screen.queryByText(/还没有信任过任何目录/)).not.toBeInTheDocument()
  })
})
