import { describe, it, expect } from 'vitest'
import { buildSystemPrompt, DEFAULT_SYSTEM_PROMPT, type AgentEnvironment } from './prompt.js'

const ENV: AgentEnvironment = {
  platform: 'win32',
  osVersion: '10.0.26100',
  shell: 'bash',
  cwd: 'E:\\ai-study\\zuse',
  date: '2026-06-06',
}

describe('buildSystemPrompt', () => {
  it('keeps the base identity prompt and appends an environment block', () => {
    const prompt = buildSystemPrompt(ENV)
    expect(prompt.startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true)
    expect(prompt).toContain('Environment:')
  })

  it('reports the actual platform, shell, cwd and date', () => {
    const prompt = buildSystemPrompt(ENV)
    expect(prompt).toContain('win32 (10.0.26100)')
    expect(prompt).toContain('Shell: bash')
    expect(prompt).toContain('E:\\ai-study\\zuse')
    expect(prompt).toContain('2026-06-06')
  })

  it('omits the version parenthetical when osVersion is absent', () => {
    const prompt = buildSystemPrompt({ ...ENV, osVersion: undefined })
    expect(prompt).toContain('Operating system: win32\n')
    expect(prompt).not.toContain('win32 (')
  })

  it('reflects a different system (darwin/sh) verbatim', () => {
    const prompt = buildSystemPrompt({ ...ENV, platform: 'darwin', shell: 'sh', osVersion: '24.0.0' })
    expect(prompt).toContain('darwin (24.0.0)')
    expect(prompt).toContain('Shell: sh')
  })
})
