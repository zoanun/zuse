import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { ModelPicker } from './ModelPicker.js'
import * as manageApi from '../state/manageApi.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const OPTIONS = [
  { providerId: 'qwen', model: 'kimi-k2.6' },
  { providerId: 'qwen', model: 'qwen-max' },
  { providerId: 'anthropic', model: 'claude-sonnet-4-5' },
]

describe('ModelPicker', () => {
  it('renders options grouped by provider and highlights the current model', async () => {
    vi.spyOn(manageApi, 'listModels').mockResolvedValue({ options: OPTIONS, defaultModel: 'qwen/kimi-k2.6' })
    render(<ModelPicker current="kimi-k2.6" onPick={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('qwen-max')).toBeInTheDocument())
    // Group headers = provider ids.
    expect(screen.getByText('qwen')).toBeInTheDocument()
    expect(screen.getByText('anthropic')).toBeInTheDocument()
    // Current model row carries aria-current.
    const current = screen.getByRole('button', { name: /kimi-k2.6/ })
    expect(current).toHaveAttribute('aria-current', 'true')
  })

  it('picking a row calls onPick with persist=false by default, then onClose', async () => {
    vi.spyOn(manageApi, 'listModels').mockResolvedValue({ options: OPTIONS, defaultModel: null })
    const onPick = vi.fn()
    const onClose = vi.fn()
    render(<ModelPicker current="kimi-k2.6" onPick={onPick} onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('qwen-max')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /qwen-max/ }))
    expect(onPick).toHaveBeenCalledWith('qwen', 'qwen-max', false)
    expect(onClose).toHaveBeenCalled()
  })

  it('with the persist checkbox ticked, onPick receives persist=true', async () => {
    vi.spyOn(manageApi, 'listModels').mockResolvedValue({ options: OPTIONS, defaultModel: null })
    const onPick = vi.fn()
    render(<ModelPicker current="kimi-k2.6" onPick={onPick} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('claude-sonnet-4-5')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('永久保存到配置'))
    fireEvent.click(screen.getByRole('button', { name: /claude-sonnet-4-5/ }))
    expect(onPick).toHaveBeenCalledWith('anthropic', 'claude-sonnet-4-5', true)
  })

  it('shows an error message when listModels fails', async () => {
    vi.spyOn(manageApi, 'listModels').mockRejectedValue(new Error('boom'))
    render(<ModelPicker current="x" onPick={() => {}} onClose={() => {}} />)
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })
})
