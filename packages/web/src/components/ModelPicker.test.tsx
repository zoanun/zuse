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

  it('does NOT treat a bare defaultModel as default when it names another provider\'s same-named model', async () => {
    // defaultModel is a bare 'gpt-4o' (flat default), current is azure/gpt-4o — a DIFFERENT provider's
    // same-named model. The checkbox must be tickable (not pre-checked/disabled) so the user can
    // persist azure/gpt-4o as the new default.
    vi.spyOn(manageApi, 'listModels').mockResolvedValue({
      options: [{ providerId: 'azure', model: 'gpt-4o', vision: false }],
      defaultModel: 'gpt-4o',
    })
    render(<ModelPicker current="gpt-4o" currentProviderId="azure" onPick={noop} onPersist={noop} onClose={noop} />)
    await waitFor(() => expect(screen.getByText('gpt-4o')).toBeInTheDocument())
    const box = screen.getByRole('checkbox')
    expect(box).not.toBeChecked()
    expect(box).not.toBeDisabled()
  })

  it('treats the qualified providerId/model spec as default (azure/gpt-4o)', async () => {
    vi.spyOn(manageApi, 'listModels').mockResolvedValue({
      options: [{ providerId: 'azure', model: 'gpt-4o', vision: false }],
      defaultModel: 'azure/gpt-4o',
    })
    render(<ModelPicker current="gpt-4o" currentProviderId="azure" onPick={noop} onPersist={noop} onClose={noop} />)
    await waitFor(() => expect(screen.getByText('gpt-4o')).toBeInTheDocument())
    const box = screen.getByRole('checkbox')
    expect(box).toBeChecked()
    expect(box).toBeDisabled()
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
