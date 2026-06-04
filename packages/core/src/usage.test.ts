import { describe, it, expect } from 'vitest'
import type { Usage } from './types.js'

describe('Usage type', () => {
  it('tracks input and output tokens', () => {
    const usage: Usage = {
      input_tokens: 100,
      output_tokens: 50,
    }
    expect(usage.input_tokens).toBe(100)
    expect(usage.output_tokens).toBe(50)
  })

  it('can calculate total tokens', () => {
    const usage: Usage = {
      input_tokens: 100,
      output_tokens: 50,
    }
    const total = usage.input_tokens + usage.output_tokens
    expect(total).toBe(150)
  })
})
