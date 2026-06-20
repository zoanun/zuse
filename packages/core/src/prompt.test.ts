import { describe, it, expect } from 'vitest'
import { buildSystemPrompt, DEFAULT_SYSTEM_PROMPT, isClaudeFamily, type AgentEnvironment } from './prompt.js'

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

  it('reports the actual platform, shell and cwd (date is injected into user messages, not system prompt)', () => {
    const prompt = buildSystemPrompt(ENV)
    expect(prompt).toContain('win32 (10.0.26100)')
    expect(prompt).toContain('Shell: bash')
    expect(prompt).toContain('E:\\ai-study\\zuse')
    expect(prompt).not.toContain('2026-06-06')
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

  it('does not contain date in system prompt (date is in user messages for cache stability)', () => {
    const prompt = buildSystemPrompt(ENV)
    expect(prompt).not.toContain("Today's date:")
    expect(prompt).not.toContain('2026-06-06')
  })
})

describe('isClaudeFamily', () => {
  it('returns true for claude model ids', () => {
    expect(isClaudeFamily('claude-sonnet-4-6')).toBe(true)
    expect(isClaudeFamily('claude-opus-4-8')).toBe(true)
    expect(isClaudeFamily('claude-haiku-4-5-20251001')).toBe(true)
  })

  it('returns true for anthropic-prefixed ids', () => {
    expect(isClaudeFamily('anthropic/claude-sonnet')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isClaudeFamily('Claude-Sonnet-4-6')).toBe(true)
    expect(isClaudeFamily('CLAUDE-OPUS')).toBe(true)
  })

  it('returns false for non-claude models', () => {
    expect(isClaudeFamily('deepseek-v4')).toBe(false)
    expect(isClaudeFamily('gpt-4o-mini')).toBe(false)
    expect(isClaudeFamily('qwen-2.5')).toBe(false)
    expect(isClaudeFamily('gemini-2.5-flash')).toBe(false)
    expect(isClaudeFamily('glm-5.1')).toBe(false)
    expect(isClaudeFamily('unknown')).toBe(false)
  })
})

describe('model-tiered overlay', () => {
  it('injects enforcement overlay for non-Claude models', () => {
    const prompt = buildSystemPrompt(ENV, [], 'deepseek-v4')
    expect(prompt).toContain('<tool_use_enforcement>')
    expect(prompt).toContain('<anti_fabrication>')
    expect(prompt).toContain('<mandatory_tool_use>')
    expect(prompt).toContain('<completion_contract>')
  })

  it('does NOT inject overlay for Claude models', () => {
    const prompt = buildSystemPrompt(ENV, [], 'claude-sonnet-4-6')
    expect(prompt).not.toContain('<tool_use_enforcement>')
  })

  it('does NOT inject overlay when modelId is omitted', () => {
    const prompt = buildSystemPrompt(ENV)
    expect(prompt).not.toContain('<tool_use_enforcement>')
  })

  it('places overlay after env block but before sections', () => {
    const prompt = buildSystemPrompt(
      ENV,
      [{ title: 'User instructions', content: 'Be brief.' }],
      'gpt-4o-mini',
    )
    const envIdx = prompt.indexOf('Environment:')
    const overlayIdx = prompt.indexOf('<tool_use_enforcement>')
    const sectionIdx = prompt.indexOf('## User instructions')
    expect(envIdx).toBeLessThan(overlayIdx)
    expect(overlayIdx).toBeLessThan(sectionIdx)
  })

  it('output is byte-identical to no-modelId when modelId is claude', () => {
    const withoutId = buildSystemPrompt(ENV, [])
    const withClaudeId = buildSystemPrompt(ENV, [], 'claude-sonnet-4-6')
    expect(withClaudeId).toBe(withoutId)
  })
})
