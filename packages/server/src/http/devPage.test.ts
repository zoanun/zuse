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

/**
 * 应急页也得带上待办的组名。
 *
 * 它是**第二套完整的待办渲染器**（renderTodos），且 startServer 无条件供它 ——
 * ZUSE_WEBDIR 传错时用户就落在这个页面（CLAUDE.md 记着这个坑）。分组在这里静默消失，
 * 会让来排查问题的人看到一份与主界面不一致的数据。不做分组渲染，但组名要拼进正文。
 */
it('待办渲染带上组名前缀（应急页不做分组，但不许让分组消失）', () => {
  expect(DEV_PAGE_HTML).toContain("t.group ? '[' + t.group + '] ' + t.content : t.content")
})
