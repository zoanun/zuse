import { describe, it, expect } from 'vitest'
import { createDefaultRegistry, WebFetchTool } from './index.js'

describe('createDefaultRegistry', () => {
  it('registers WebFetch', () => {
    const registry = createDefaultRegistry()
    expect(registry.get('WebFetch')).toBe(WebFetchTool)
  })
})
