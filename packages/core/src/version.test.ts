import { describe, it, expect } from 'vitest'
import { VERSION } from './index.js'

describe('VERSION', () => {
  it('is the placeholder 0.0.0 during phase 0', () => {
    expect(VERSION).toBe('0.0.0')
  })
})