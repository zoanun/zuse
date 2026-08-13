import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { Header } from './Header.js'
import { initialState } from '../state/reducer.js'
import * as manageApi from '../state/manageApi.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Header', () => {
  it('shows ctx used / window / percent', () => {
    render(<Header state={{ ...initialState, connection: 'live', model: 'claude', contextTokens: 4700, contextWindow: 200000 }} onMenu={() => {}} onOpenManage={() => {}} onChangeCwd={() => {}} onSwitchModel={() => {}} onCyclePermissionMode={() => {}} cleanView={true} onToggleCleanView={() => {}} sessionId="s1" onRunScript={() => {}} runningCommands={new Set()} />)
    expect(screen.getByText(/ctx 4.7k \/ 200.0k · 2%/)).toBeInTheDocument()
    expect(screen.getByText('已连接')).toBeInTheDocument()
  })

  it('⚙ button fires onOpenManage', () => {
    const onOpenManage = vi.fn()
    render(<Header state={initialState} onMenu={() => {}} onOpenManage={onOpenManage} onChangeCwd={() => {}} onSwitchModel={() => {}} onCyclePermissionMode={() => {}} cleanView={true} onToggleCleanView={() => {}} sessionId="s1" onRunScript={() => {}} runningCommands={new Set()} />)
    fireEvent.click(screen.getByLabelText('管理'))
    expect(onOpenManage).toHaveBeenCalled()
  })

  it('clicking the model chip opens the ModelPicker', async () => {
    vi.spyOn(manageApi, 'listModels').mockResolvedValue({ options: [{ providerId: 'qwen', model: 'kimi-k2.6', vision: false }], defaultModel: 'qwen/kimi-k2.6' })
    render(<Header state={{ ...initialState, model: 'kimi-k2.6' }} onMenu={() => {}} onOpenManage={() => {}} onChangeCwd={() => {}} onSwitchModel={() => {}} onCyclePermissionMode={() => {}} cleanView={true} onToggleCleanView={() => {}} sessionId="s1" onRunScript={() => {}} runningCommands={new Set()} />)
    fireEvent.click(screen.getByRole('button', { name: /模型 kimi-k2.6/ }))
    expect(await screen.findByRole('dialog', { name: '切换模型' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('kimi-k2.6')).toBeInTheDocument())
  })
})
