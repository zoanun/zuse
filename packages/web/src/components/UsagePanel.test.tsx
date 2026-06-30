import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { UsageStats } from '@zuse/protocol'
import { UsagePanel, formatTokens, totalTokens } from './UsagePanel.js'

const stats: UsageStats = {
  total: { input_tokens: 1_200_000, output_tokens: 300_000, cache_read_input_tokens: 5000 },
  sessionCount: 2,
  byModel: [
    { model: 'opus', sessions: 2, usage: { input_tokens: 1_200_000, output_tokens: 300_000 } },
    { model: 'sonnet', sessions: 1, usage: { input_tokens: 50_000, output_tokens: 0 } },
  ],
  sessions: [
    { id: 's1', title: 'Big chat', model: 'opus', updatedAt: '2026-06-29T01:00:00Z', usage: { input_tokens: 1_000_000, output_tokens: 0 } },
    { id: 's2', title: '', model: 'sonnet', updatedAt: '2026-06-29T02:00:00Z', usage: { input_tokens: 5000, output_tokens: 0 } },
  ],
}

describe('formatTokens', () => {
  it('formats k and M', () => {
    expect(formatTokens(500)).toBe('500')
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_500_000)).toBe('1.5M')
  })
})

describe('totalTokens', () => {
  it('sums all buckets including cache', () => {
    expect(totalTokens({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 })).toBe(18)
  })
})

describe('UsagePanel', () => {
  it('shows the grand total, per-model and per-session breakdowns', () => {
    const { container } = render(<UsagePanel stats={stats} />)
    // Total (1.2M + 300k + 5k = 1.505M → "1.5M"); assert via its own element to dodge
    // token-string collisions with the model/session rows.
    expect(container.querySelector('.usage-total-num')?.textContent).toBe('1.5M')
    expect(container.querySelector('.usage-total-label')?.textContent).toContain('2 个会话')
    // Model names appear in both the by-model and by-session sections → use getAllByText.
    expect(screen.getAllByText('opus').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('sonnet').length).toBeGreaterThanOrEqual(1)
    // Session titles are unique.
    expect(screen.getByText('Big chat')).toBeInTheDocument()
    expect(screen.getByText('(未命名)')).toBeInTheDocument() // empty title falls back
  })

  it('shows an empty state when no usage recorded', () => {
    render(<UsagePanel stats={{ total: { input_tokens: 0, output_tokens: 0 }, sessionCount: 0, byModel: [], sessions: [] }} />)
    expect(screen.getByText(/暂无用量记录/)).toBeInTheDocument()
  })

  it('shows a loading state', () => {
    render(<UsagePanel loading />)
    expect(screen.getByText(/加载中/)).toBeInTheDocument()
  })
})
