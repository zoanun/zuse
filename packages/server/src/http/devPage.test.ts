import { describe, it, expect } from 'vitest'
import { DEV_PAGE_HTML } from './devPage.js'

describe('dev page', () => {
  it('is self-contained HTML mentioning the auth + ws flow', () => {
    expect(DEV_PAGE_HTML).toContain('<!doctype html>')
    expect(DEV_PAGE_HTML).toContain('/api/auth/login')
    expect(DEV_PAGE_HTML).toContain('/ws')
    expect(DEV_PAGE_HTML).toContain('DEV TEST PAGE')
  })
  it('has no external resource references', () => {
    expect(DEV_PAGE_HTML).not.toMatch(/https?:\/\/[^"']*\.(js|css)/)
    expect(DEV_PAGE_HTML).not.toContain('cdn')
  })
})
