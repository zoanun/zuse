import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Header } from './Header.js'
import { initialState } from '../state/reducer.js'

describe('Header', () => {
  it('shows ctx used / window / percent', () => {
    render(<Header state={{ ...initialState, connection: 'live', model: 'claude', contextTokens: 4700, contextWindow: 200000 }} onMenu={() => {}} onOpenManage={() => {}} onChangeCwd={() => {}} />)
    expect(screen.getByText(/ctx 4.7k \/ 200.0k · 2%/)).toBeInTheDocument()
    expect(screen.getByText('已连接')).toBeInTheDocument()
  })

  it('⚙ button fires onOpenManage', () => {
    const onOpenManage = vi.fn()
    render(<Header state={initialState} onMenu={() => {}} onOpenManage={onOpenManage} onChangeCwd={() => {}} />)
    fireEvent.click(screen.getByLabelText('管理'))
    expect(onOpenManage).toHaveBeenCalled()
  })
})
