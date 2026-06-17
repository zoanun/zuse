import { describe, it, expect } from 'vitest'
import { runHooks } from './hooks.js'

describe('runHooks', () => {
  const env = { toolName: 'Edit', toolInput: { file_path: 'test.ts' }, cwd: '.' }

  it('runs matching hooks', () => {
    const { warnings } = runHooks(
      [{ tool: 'Edit', command: 'echo ok' }],
      env,
    )
    expect(warnings).toHaveLength(0)
  })

  it('wildcard matches any tool', () => {
    const { warnings } = runHooks(
      [{ tool: '*', command: 'echo ok' }],
      env,
    )
    expect(warnings).toHaveLength(0)
  })

  it('skips non-matching tool rules', () => {
    const { warnings } = runHooks(
      [{ tool: 'Bash', command: 'echo should-not-run' }],
      env,
    )
    expect(warnings).toHaveLength(0)
  })

  it('captures failure as warning without throwing', () => {
    const { warnings } = runHooks(
      [{ tool: 'Edit', command: 'exit 1' }],
      env,
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('failed')
  })

  it('returns empty for undefined rules', () => {
    expect(runHooks(undefined, env).warnings).toEqual([])
  })

  it('returns empty for empty array', () => {
    expect(runHooks([], env).warnings).toEqual([])
  })
})
