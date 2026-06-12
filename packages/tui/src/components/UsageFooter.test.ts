import { describe, it, expect } from 'vitest'
import { formatTokens, contextRatioColor } from './UsageFooter.js'

describe('formatTokens', () => {
  it('renders small numbers as-is', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
  })

  it('renders thousands with one decimal, rounding past 100k', () => {
    expect(formatTokens(1234)).toBe('1.2k')
    expect(formatTokens(99_940)).toBe('99.9k')
    expect(formatTokens(131_072)).toBe('131k')
    expect(formatTokens(262_144)).toBe('262k')
  })

  it('renders millions compactly', () => {
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_048_576)).toBe('1.0M')
  })
})

describe('contextRatioColor', () => {
  it('matches the compaction threshold: red at >=80%, yellow at >=60%', () => {
    expect(contextRatioColor(0.5)).toBeUndefined()
    expect(contextRatioColor(0.6)).toBe('yellow')
    expect(contextRatioColor(0.79)).toBe('yellow')
    expect(contextRatioColor(0.8)).toBe('red')
    expect(contextRatioColor(1.2)).toBe('red')
  })
})
