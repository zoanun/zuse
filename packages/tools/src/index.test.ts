import { describe, it, expect } from 'vitest'
import type { WebSearchConfig } from '@zuse/core'
import { createDefaultRegistry, WebFetchTool } from './index.js'
import { LspManager } from './lsp/manager.js'

const WS: WebSearchConfig = {
  backend: 'tavily',
  fallback: [],
  maxResults: 5,
  backends: { tavily: { apiKey: 'tvly-x' } },
}

describe('createDefaultRegistry', () => {
  it('registers WebFetch', () => {
    const registry = createDefaultRegistry()
    expect(registry.get('WebFetch')).toBe(WebFetchTool)
  })

  it('does NOT register WebSearch without config', () => {
    const registry = createDefaultRegistry()
    expect(registry.get('WebSearch')).toBeUndefined()
  })

  it('registers WebSearch when given a config', () => {
    const registry = createDefaultRegistry({ webSearch: WS })
    expect(registry.get('WebSearch')?.name).toBe('WebSearch')
  })

  it('does NOT register WebSearch when config is null', () => {
    const registry = createDefaultRegistry({ webSearch: null })
    expect(registry.get('WebSearch')).toBeUndefined()
  })

  it('registers the Lsp tool when an LspManager is provided', () => {
    const registry = createDefaultRegistry({ lsp: new LspManager() })
    expect(registry.get('Lsp')).toBeTruthy()
  })

  it('omits Lsp when no manager is provided', () => {
    const registry = createDefaultRegistry()
    expect(registry.get('Lsp')).toBeUndefined()
  })
})
