import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createFetchCache,
  extractContent,
  WebFetchTool,
  __setFetchImpl,
  __resetFetchImpl,
  __clearCache,
} from './webfetch.js'
import { createFileTracker, type ToolContext } from '@zuse/core'

describe('createFetchCache', () => {
  it('returns a stored value within its TTL', () => {
    let clock = 0
    const cache = createFetchCache(1000, () => clock)
    cache.set('k', 'v')
    expect(cache.get('k')).toBe('v')
    clock = 999
    expect(cache.get('k')).toBe('v')
  })

  it('expires a value once the TTL has elapsed', () => {
    let clock = 0
    const cache = createFetchCache(1000, () => clock)
    cache.set('k', 'v')
    clock = 1000
    expect(cache.get('k')).toBeUndefined()
  })

  it('returns undefined for an unknown key', () => {
    const cache = createFetchCache(1000, () => 0)
    expect(cache.get('missing')).toBeUndefined()
  })
})

// 一篇有足够正文的文章，混入导航/脚本/页脚噪声，验证 readability 抽主正文、去噪。
const ARTICLE_HTML = `<!DOCTYPE html><html><head><title>Test Article Title</title></head>
<body>
  <nav>Home | AboutNav | Contact</nav>
  <script>trackerPixel()</script>
  <article>
    <h1>Main Heading</h1>
    <p>${'This is a substantial paragraph of real article body text that readability should detect as the primary content of the page. '.repeat(8)}</p>
    <p>${'A second meaningful paragraph with plenty of words, pushing the article comfortably over the extraction character threshold. '.repeat(8)}</p>
  </article>
  <footer>Copyright FooterNoise 2026</footer>
</body></html>`

// Cloudflare 邮箱混淆还原。两个 hex 是同一页 docs.astral.sh 在不同加载下的真实值，
// key 轮换（0x8d / 0xca）但都解码为 python@3.12 —— uv 文档把版本号当成了邮箱被 CF 混淆。
describe('extractContent — Cloudflare 邮箱混淆还原', () => {
  it('还原 data-cfemail 属性，且对 key 轮换免疫', () => {
    for (const hex of ['8dfdf4f9e5e2e3cdbea3bcbf', 'cabab3bea2a5a48af9e4fbf8']) {
      const html = `<html><body><pre><code>uvx <a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="${hex}">[email&#160;protected]</a> -c "x"</code></pre></body></html>`
      const { markdown } = extractContent(html, 'https://example.com')
      expect(markdown).toContain('python@3.12')
      // 占位符与 CF 链接都不应残留。
      expect(markdown).not.toContain('email-protection')
      expect(markdown).not.toMatch(/\[email.{0,12}protected\]/)
    }
  })

  it('还原 href 片段携带的 hex（无 data-cfemail 时）', () => {
    const html = `<html><body><p>contact <a href="/cdn-cgi/l/email-protection#8dfdf4f9e5e2e3cdbea3bcbf">[email&#160;protected]</a> now</p></body></html>`
    const { markdown } = extractContent(html, 'https://example.com')
    expect(markdown).toContain('python@3.12')
    expect(markdown).not.toContain('email-protection')
  })

  it('hex 非法时跳过该节点、不抛异常', () => {
    const html = `<html><body><p>x <span data-cfemail="zz">y</span> <span data-cfemail="8d">z</span></p></body></html>`
    expect(() => extractContent(html, 'https://example.com')).not.toThrow()
  })
})

describe('extractContent', () => {
  it('extracts title and main content as markdown, dropping nav/script noise', () => {
    const { title, markdown } = extractContent(ARTICLE_HTML, 'https://example.com/post')
    expect(title).toContain('Test Article Title')
    expect(markdown).toContain('Main Heading')
    expect(markdown).toContain('substantial paragraph of real article body text')
    // 导航被 readability 剔除。
    expect(markdown).not.toContain('AboutNav')
    // 脚本内容不应出现。
    expect(markdown).not.toContain('trackerPixel')
  })

  it('falls back to the body when readability finds no article', () => {
    const tiny = '<html><head><title>Tiny</title></head><body><p>hello fallback world</p></body></html>'
    const { title, markdown } = extractContent(tiny, 'https://example.com/tiny')
    expect(title).toContain('Tiny')
    expect(markdown).toContain('hello fallback world')
  })

  it('returns empty markdown for an empty body (SPA shell)', () => {
    const spa = '<html><head><title>App</title></head><body><div id="root"></div></body></html>'
    const { markdown } = extractContent(spa, 'https://example.com/app')
    expect(markdown.trim()).toBe('')
  })
})

// 构造一个普通 ToolContext（signal 不触发，tracker 不参与 WebFetch）。
function makeCtx(): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, tracker: createFileTracker() }
}

describe('WebFetchTool metadata', () => {
  it('is not read-only and exposes hostname as specifier', () => {
    expect(WebFetchTool.readOnly).toBeFalsy()
    expect(WebFetchTool.specifierFor?.({ url: 'https://github.com/a/b' })).toBe('github.com')
    expect(WebFetchTool.specifierFor?.({ url: 'not a url' })).toBeNull()
    expect(WebFetchTool.specifierFor?.({})).toBeNull()
    // 主机名不是文件路径，别让权限层拿它去 resolve(cwd, …)
    expect(WebFetchTool.specifierKind).toBe('opaque')
  })
})

describe('WebFetchTool.run', () => {
  beforeEach(() => __clearCache())
  afterEach(() => __resetFetchImpl())

  it('rejects a missing url', async () => {
    const res = await WebFetchTool.run({}, makeCtx())
    expect(res.isError).toBe(true)
  })

  it('rejects a non-http(s) url', async () => {
    const res = await WebFetchTool.run({ url: 'ftp://example.com/x' }, makeCtx())
    expect(res.isError).toBe(true)
    expect(res.output).toMatch(/http/i)
  })

  it('fetches HTML and returns title + url + markdown', async () => {
    __setFetchImpl(async () =>
      new Response(ARTICLE_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    )
    const res = await WebFetchTool.run({ url: 'https://example.com/post' }, makeCtx())
    expect(res.isError).toBeFalsy()
    expect(res.output).toContain('Test Article Title')
    expect(res.output).toContain('https://example.com/post')
    expect(res.output).toContain('Main Heading')
  })

  it('returns isError for a non-2xx status', async () => {
    __setFetchImpl(async () => new Response('nope', { status: 404, statusText: 'Not Found' }))
    const res = await WebFetchTool.run({ url: 'https://example.com/missing' }, makeCtx())
    expect(res.isError).toBe(true)
    expect(res.output).toContain('404')
  })

  it('returns isError for an unsupported content type', async () => {
    __setFetchImpl(async () =>
      new Response('binarydata', { status: 200, headers: { 'content-type': 'image/png' } }),
    )
    const res = await WebFetchTool.run({ url: 'https://example.com/pic.png' }, makeCtx())
    expect(res.isError).toBe(true)
    expect(res.output).toMatch(/content type/i)
  })

  it('returns plain text bodies as-is', async () => {
    __setFetchImpl(async () =>
      new Response('just some plain text', { status: 200, headers: { 'content-type': 'text/plain' } }),
    )
    const res = await WebFetchTool.run({ url: 'https://example.com/robots.txt' }, makeCtx())
    expect(res.isError).toBeFalsy()
    expect(res.output).toContain('just some plain text')
  })

  it('reports a network failure as isError', async () => {
    __setFetchImpl(async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    })
    const res = await WebFetchTool.run({ url: 'https://no-such-host.invalid/' }, makeCtx())
    expect(res.isError).toBe(true)
    expect(res.output).toMatch(/failed/i)
  })

  it('shows an SPA hint when the HTML has no extractable content', async () => {
    const spa = '<html><head><title>App</title></head><body><div id="root"></div></body></html>'
    __setFetchImpl(async () =>
      new Response(spa, { status: 200, headers: { 'content-type': 'text/html' } }),
    )
    const res = await WebFetchTool.run({ url: 'https://example.com/app' }, makeCtx())
    expect(res.isError).toBeFalsy()
    expect(res.output).toContain('SPA')
  })

  it('truncates output longer than the cap', async () => {
    const huge = `<html><head><title>Big</title></head><body><article><p>${'word '.repeat(40000)}</p></article></body></html>`
    __setFetchImpl(async () =>
      new Response(huge, { status: 200, headers: { 'content-type': 'text/html' } }),
    )
    const res = await WebFetchTool.run({ url: 'https://example.com/big' }, makeCtx())
    // 输出整形(Phase 9):统一 [truncated: …] marker(observation 读者是模型,
    // 与其他工具的英文标记保持一致);正文截断只留头,尾部多为页脚杂讯。
    expect(res.output).toMatch(/\[truncated: output was \d+ chars/)
    expect(res.output).toMatch(/showing first \d+ chars\]/)
  })

  it('serves a second identical request from cache without re-fetching', async () => {
    let calls = 0
    __setFetchImpl(async () => {
      calls++
      return new Response(ARTICLE_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
    })
    const url = 'https://example.com/cached'
    await WebFetchTool.run({ url }, makeCtx())
    await WebFetchTool.run({ url }, makeCtx())
    expect(calls).toBe(1)
  })
})
