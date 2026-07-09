import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { ModelPicker } from './ModelPicker.js'
import * as manageApi from '../state/manageApi.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const OPTIONS = [
  { providerId: 'qwen', model: 'kimi-k2.6', vision: false },
  { providerId: 'qwen', model: 'qwen-max', vision: false },
  { providerId: 'anthropic', model: 'claude-sonnet-4-5', vision: true },
]

const noop = () => {}

describe('ModelPicker', () => {
  it('renders options grouped by provider and highlights the current model', async () => {
    vi.spyOn(manageApi, 'listModels').mockResolvedValue({ options: OPTIONS, defaultModel: 'qwen/kimi-k2.6' })
    render(<ModelPicker current="kimi-k2.6" currentProviderId="qwen" onPick={noop} onPersist={noop} onClose={noop} />)
    await waitFor(() => expect(screen.getByText('qwen-max')).toBeInTheDocument())
    expect(screen.getByText('qwen')).toBeInTheDocument()
    expect(screen.getByText('anthropic')).toBeInTheDocument()
    const current = screen.getByRole('button', { name: /kimi-k2.6/ })
    expect(current).toHaveAttribute('aria-current', 'true')
  })

  it('picking a row is a temporary switch: onPick(providerId, model) then onClose (no persist)', async () => {
    vi.spyOn(manageApi, 'listModels').mockResolvedValue({ options: OPTIONS, defaultModel: null })
    const onPick = vi.fn()
    const onClose = vi.fn()
    render(<ModelPicker current="kimi-k2.6" currentProviderId="qwen" onPick={onPick} onPersist={noop} onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('qwen-max')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /qwen-max/ }))
    expect(onPick).toHaveBeenCalledWith('qwen', 'qwen-max')
    expect(onClose).toHaveBeenCalled()
  })

  it('ticking the checkbox persists the CURRENT model immediately (onPersist), not the next pick', async () => {
    vi.spyOn(manageApi, 'listModels').mockResolvedValue({ options: OPTIONS, defaultModel: null })
    const onPersist = vi.fn()
    render(<ModelPicker current="kimi-k2.6" currentProviderId="qwen" onPick={noop} onPersist={onPersist} onClose={noop} />)
    await waitFor(() => expect(screen.getByText('qwen-max')).toBeInTheDocument())
    // The box acts on the CURRENT model (kimi-k2.6), no model row click needed.
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onPersist).toHaveBeenCalledWith('qwen', 'kimi-k2.6')
    expect(screen.getByRole('checkbox')).toBeChecked() // optimistic
  })

  it('when the current model is already the saved default, the checkbox is pre-checked + disabled', async () => {
    vi.spyOn(manageApi, 'listModels').mockResolvedValue({ options: OPTIONS, defaultModel: 'qwen/kimi-k2.6' })
    const onPersist = vi.fn()
    render(<ModelPicker current="kimi-k2.6" currentProviderId="qwen" onPick={noop} onPersist={onPersist} onClose={noop} />)
    await waitFor(() => expect(screen.getByText('qwen-max')).toBeInTheDocument())
    const box = screen.getByRole('checkbox')
    expect(box).toBeChecked()
    expect(box).toBeDisabled()
    fireEvent.click(box)
    expect(onPersist).not.toHaveBeenCalled() // already default → no-op
  })

  it('marks ONLY the provider+model match as current when two providers share a model name', async () => {
    const dupes = [
      { providerId: 'qwen', model: 'deepseek-v4-pro', vision: false },
      { providerId: 'deepseek', model: 'deepseek-v4-pro', vision: false },
    ]
    vi.spyOn(manageApi, 'listModels').mockResolvedValue({ options: dupes, defaultModel: null })
    render(<ModelPicker current="deepseek-v4-pro" currentProviderId="deepseek" onPick={noop} onPersist={noop} onClose={noop} />)
    await waitFor(() => expect(screen.getAllByRole('button', { name: /deepseek-v4-pro/ })).toHaveLength(2))
    const rows = screen.getAllByRole('button', { name: /deepseek-v4-pro/ })
    const current = rows.filter((r) => r.getAttribute('aria-current') === 'true')
    expect(current).toHaveLength(1)
  })

  it('renders the vision (eye) icon only on vision-capable rows', async () => {
    vi.spyOn(manageApi, 'listModels').mockResolvedValue({ options: OPTIONS, defaultModel: null })
    render(<ModelPicker current="kimi-k2.6" currentProviderId="qwen" onPick={noop} onPersist={noop} onClose={noop} />)
    await waitFor(() => expect(screen.getByText('claude-sonnet-4-5')).toBeInTheDocument())
    const icons = screen.getAllByLabelText('支持视觉/图片')
    expect(icons).toHaveLength(1)
    const claudeRow = screen.getByRole('button', { name: /claude-sonnet-4-5/ })
    expect(claudeRow).toContainElement(icons[0]!)
  })

  it('shows an error message when listModels fails', async () => {
    vi.spyOn(manageApi, 'listModels').mockRejectedValue(new Error('boom'))
    render(<ModelPicker current="x" onPick={noop} onPersist={noop} onClose={noop} />)
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })
})
