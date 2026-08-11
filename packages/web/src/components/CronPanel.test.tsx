import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { CronPanel } from './CronPanel.js'
import { presetToCron, describeCron } from './CronPanel.js'

vi.mock('../state/cronApi.js', () => ({
  listCronTasks: vi.fn(async () => [{ id: 't1', name: '每日汇总', cron: '0 9 * * *', prompt: 'p', cwd: '/tmp', permissionMode: 'bypass', enabled: true, createdAt: 'c', updatedAt: 'u', nextRun: '2026-07-25T09:00:00.000Z' }]),
  listCronRuns: vi.fn(async () => []), runCronNow: vi.fn(), createCronTask: vi.fn(), updateCronTask: vi.fn(), deleteCronTask: vi.fn(), getCronRunDetail: vi.fn(),
}))

describe('presetToCron / describeCron', () => {
  it('monthly compiles to day-of-month and round-trips readably', () => {
    expect(presetToCron({ kind: 'monthly', dom: 1, h: 8, m: 30 })).toBe('30 8 1 * *')
    expect(describeCron('0 9 * * *')).toMatch(/每天.*09:00/)
  })
})

describe('CronTasksView', () => {
  it('lists tasks with human-readable schedule', async () => {
    render(<CronPanel />)
    await waitFor(() => expect(screen.getByText('每日汇总')).toBeInTheDocument())
  })
})
