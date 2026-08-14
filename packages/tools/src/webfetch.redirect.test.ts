import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  WebFetchTool,
  canonicalHost,
  __setFetchImpl,
  __resetFetchImpl,
  __clearCache,
} from './webfetch.js'
import { createFileTracker, type ToolContext } from '@zuse/core'

/**
 * D5：重定向不能绕过权限闸。
 * 设计与实测依据：docs/superpowers/specs/2026-08-14-webfetch-redirect-design.md
 *
 * 这一组测试的核心防线是：**桩要记录 `checkSpecifier` 收到的参数**。
 * 一个「拿入口主机名去问」的实现（`ctx.checkSpecifier(parsed.hostname)`）是个
 * 永远 allow 的空闸 —— 只断言「拒了/放了」的测试对它一样绿。
 */

function makeCtx(): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, tracker: createFileTracker() }
}

/** 记录每次 checkSpecifier 调用的桩；裁决可按主机名区分。 */
function makeCheck(verdict: (host: string) => 'allow' | 'deny' | Promise<'allow' | 'deny'>): {
  ctx: ToolContext
  calls: string[]
} {
  const calls: string[] = []
  const ctx: ToolContext = {
    ...makeCtx(),
    checkSpecifier: async (spec: string) => {
      calls.push(spec)
      return await verdict(spec)
    },
  }
  return { ctx, calls }
}

/** 按 URL 派发的 fetch 桩；记录请求过的 URL 顺序。 */
function makeRouter(routes: Record<string, () => Response>): { urls: string[] } {
  const urls: string[] = []
  __setFetchImpl(async (input, init) => {
    const url = String(input)
    urls.push(url)
    // 真 fetch 会尊重 signal —— 桩也必须，否则「超时是不是每跳新建」根本测不出来
    // （共用一个已 abort 的 signal 时，不检查就静默成功，用例假绿）。
    if (init?.signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
    const make = routes[url]
    if (!make) return new Response('no route', { status: 404, statusText: 'Not Found' })
    return make()
  })
  return { urls }
}

const redirectTo =
  (loc: string, status = 302): (() => Response) =>
  () =>
    new Response('redirecting', { status, headers: { location: loc } })

const okHtml =
  (body: string): (() => Response) =>
  () =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })

const PAYLOAD =
  '<html><head><title>Secret Page</title></head><body><article><p>' +
  'TOPSECRET body text that readability will happily treat as the main content of this page. '.repeat(8) +
  '</p></article></body></html>'

describe('canonicalHost —— 主机名等价写法归一', () => {
  it('去掉末尾单点（URL 解析器对非 IPv4 主机名不做这件事）', () => {
    // 实测：new URL('http://localhost./').hostname === 'localhost.'，
    // 字面 glob 的 deny: WebFetch(localhost) 就匹配不上 —— 而它真连得到本机。
    expect(canonicalHost('localhost.')).toBe('localhost')
    expect(canonicalHost('example.com.')).toBe('example.com')
  })

  it('拆开 IPv4-mapped IPv6（Node 把它压成十六进制，不是点分四段）', () => {
    // 实测：new URL('http://[::ffff:127.0.0.1]/').hostname === '[::ffff:7f00:1]'
    expect(canonicalHost('[::ffff:7f00:1]')).toBe('127.0.0.1')
    expect(canonicalHost('[::ffff:127.0.0.1]')).toBe('127.0.0.1')
    expect(canonicalHost('[::ffff:c0a8:1]')).toBe('192.168.0.1')
  })

  it('其余一律原样（别自己写通用 IPv6 归一，那是另一个能出 bug 的坑）', () => {
    expect(canonicalHost('[::1]')).toBe('[::1]')
    expect(canonicalHost('example.com')).toBe('example.com')
    expect(canonicalHost('127.0.0.1')).toBe('127.0.0.1')
    expect(canonicalHost('.')).toBe('.')
  })
})

describe('WebFetchTool.run —— 跨主机重定向要过权限闸', () => {
  beforeEach(() => __clearCache())
  afterEach(() => __resetFetchImpl())

  it('1. 目标主机被拒 → 报错、不发第二次请求、不含目标正文，且闸门收到的是【目标】主机名', async () => {
    const { urls } = makeRouter({
      'https://a.example/': redirectTo('https://b.example/'),
      'https://b.example/': okHtml(PAYLOAD),
    })
    const { ctx, calls } = makeCheck(() => 'deny')
    const res = await WebFetchTool.run({ url: 'https://a.example/' }, ctx)
    expect(res.isError).toBe(true)
    expect(res.output).not.toContain('TOPSECRET')
    expect(urls).toEqual(['https://a.example/'])
    expect(calls).toEqual(['b.example'])
  })

  it('2. 目标主机放行 → 拿到正文，抬头是最终 URL 且注明经过几跳', async () => {
    makeRouter({
      'https://a.example/': redirectTo('https://b.example/x'),
      'https://b.example/x': okHtml(PAYLOAD),
    })
    const { ctx, calls } = makeCheck(() => 'allow')
    const res = await WebFetchTool.run({ url: 'https://a.example/' }, ctx)
    expect(res.isError).toBeFalsy()
    expect(res.output).toContain('TOPSECRET')
    expect(res.output).toContain('https://b.example/x')
    expect(res.output).toContain('经 1 次重定向')
    expect(res.output).toContain('https://a.example/')
    expect(calls).toEqual(['b.example'])
  })

  it('3. 同主机跳（只换路径）一次都不问', async () => {
    makeRouter({
      'https://a.example/': redirectTo('https://a.example/second'),
      'https://a.example/second': okHtml(PAYLOAD),
    })
    const { ctx, calls } = makeCheck((h) => (h === 'b.example' ? 'deny' : 'allow'))
    const res = await WebFetchTool.run({ url: 'https://a.example/' }, ctx)
    expect(res.isError).toBeFalsy()
    expect(calls).toEqual([])
  })

  it('4. 相对 Location 按【当前跳】解析而不是入口（必须两跳才分得出）', async () => {
    makeRouter({
      'https://a.example/x': redirectTo('https://b.example/y'),
      'https://b.example/y': redirectTo('/z'),
      'https://b.example/z': okHtml(PAYLOAD),
      'https://a.example/z': okHtml('<html><body><p>WRONG BASE</p></body></html>'),
    })
    const { ctx } = makeCheck(() => 'allow')
    const res = await WebFetchTool.run({ url: 'https://a.example/x' }, ctx)
    expect(res.isError).toBeFalsy()
    expect(res.output).toContain('https://b.example/z')
    expect(res.output).not.toContain('WRONG BASE')
  })

  it('5. Location 指向非 http(s) → 拒绝（follow 下这是 undici 在兜，manual 之后要自己兜）', async () => {
    makeRouter({ 'https://a.example/': redirectTo('file:///C:/Windows/win.ini') })
    const { ctx } = makeCheck(() => 'allow')
    const res = await WebFetchTool.run({ url: 'https://a.example/' }, ctx)
    expect(res.isError).toBe(true)
    expect(res.output).toMatch(/file:/)
  })

  it('6. 跳数上限成对：10 跳成功、11 跳超限报错', async () => {
    const chain = (n: number): Record<string, () => Response> => {
      const r: Record<string, () => Response> = {}
      for (let i = 0; i < n; i++) r[`https://a.example/${i}`] = redirectTo(`https://a.example/${i + 1}`)
      r[`https://a.example/${n}`] = okHtml(PAYLOAD)
      return r
    }
    const { ctx } = makeCheck(() => 'allow')

    makeRouter(chain(10))
    const ok = await WebFetchTool.run({ url: 'https://a.example/0' }, ctx)
    expect(ok.isError).toBeFalsy()

    __clearCache()
    makeRouter(chain(11))
    const bad = await WebFetchTool.run({ url: 'https://a.example/0' }, ctx)
    expect(bad.isError).toBe(true)
    expect(bad.output).toMatch(/重定向/)
  })

  it('7. 重定向状态码但没有 Location → 当终态响应报 HTTP 302，不崩', async () => {
    makeRouter({
      'https://a.example/': () => new Response('body', { status: 302, statusText: 'Found' }),
    })
    const { ctx } = makeCheck(() => 'allow')
    const res = await WebFetchTool.run({ url: 'https://a.example/' }, ctx)
    expect(res.isError).toBe(true)
    expect(res.output).toContain('302')
  })

  it('8. 300 / 304 带 Location 也不跟随（锁住实测的现行 follow 行为）', async () => {
    for (const status of [300, 304]) {
      __clearCache()
      const { urls } = makeRouter({
        'https://a.example/': () =>
          new Response(status === 304 ? null : 'multi', {
            status,
            headers: { location: 'https://b.example/' },
          }),
        'https://b.example/': okHtml(PAYLOAD),
      })
      const { ctx } = makeCheck(() => 'allow')
      const res = await WebFetchTool.run({ url: 'https://a.example/' }, ctx)
      expect(res.isError).toBe(true)
      expect(res.output).toContain(String(status))
      expect(urls).toEqual(['https://a.example/'])
    }
  })

  it('9. ctx.checkSpecifier 缺席 + 跨主机跳 → 拒绝（fail closed）', async () => {
    const { urls } = makeRouter({
      'https://a.example/': redirectTo('https://b.example/'),
      'https://b.example/': okHtml(PAYLOAD),
    })
    const res = await WebFetchTool.run({ url: 'https://a.example/' }, makeCtx())
    expect(res.isError).toBe(true)
    expect(res.output).not.toContain('TOPSECRET')
    expect(urls).toEqual(['https://a.example/'])
  })

  it('10. 跨过主机的结果不写缓存（否则「仅此一次」会变成「15 分钟内随便」）', async () => {
    const { urls } = makeRouter({
      'https://a.example/': redirectTo('https://b.example/'),
      'https://b.example/': okHtml(PAYLOAD),
    })
    const { ctx } = makeCheck(() => 'allow')
    await WebFetchTool.run({ url: 'https://a.example/' }, ctx)
    await WebFetchTool.run({ url: 'https://a.example/' }, ctx)
    expect(urls).toEqual([
      'https://a.example/',
      'https://b.example/',
      'https://a.example/',
      'https://b.example/',
    ])
  })

  it('11. 没有重定向的普通 200 照旧写缓存，且抬头不提重定向', async () => {
    const { urls } = makeRouter({ 'https://a.example/': okHtml(PAYLOAD) })
    const { ctx } = makeCheck(() => 'allow')
    const first = await WebFetchTool.run({ url: 'https://a.example/' }, ctx)
    await WebFetchTool.run({ url: 'https://a.example/' }, ctx)
    expect(urls).toEqual(['https://a.example/'])
    expect(first.output).not.toContain('重定向')
  })

  it('12. a→b→a→b 链上，b 只问一次', async () => {
    makeRouter({
      'https://a.example/1': redirectTo('https://b.example/1'),
      'https://b.example/1': redirectTo('https://a.example/2'),
      'https://a.example/2': redirectTo('https://b.example/2'),
      'https://b.example/2': okHtml(PAYLOAD),
    })
    const { ctx, calls } = makeCheck(() => 'allow')
    const res = await WebFetchTool.run({ url: 'https://a.example/1' }, ctx)
    expect(res.isError).toBeFalsy()
    expect(calls).toEqual(['b.example'])
  })

  it('13. 入口闸也补上了：specifierFor 走同一个归一', () => {
    expect(WebFetchTool.specifierFor?.({ url: 'http://localhost./' })).toBe('localhost')
    expect(WebFetchTool.specifierFor?.({ url: 'http://[::ffff:127.0.0.1]/' })).toBe('127.0.0.1')
  })

  it('14. 权限弹框答得慢，不该被算进抓取超时（超时必须每跳新建）', async () => {
    const prev = process.env['ZUSE_WEBFETCH_TIMEOUT_MS']
    process.env['ZUSE_WEBFETCH_TIMEOUT_MS'] = '40'
    try {
      makeRouter({
        'https://a.example/': redirectTo('https://b.example/'),
        'https://b.example/': okHtml(PAYLOAD),
      })
      const { ctx } = makeCheck(async (): Promise<'allow'> => {
        await new Promise((r) => setTimeout(r, 120)) // 比一跳的超时还久
        return 'allow'
      })
      const res = await WebFetchTool.run({ url: 'https://a.example/' }, ctx)
      expect(res.isError).toBeFalsy()
      expect(res.output).toContain('TOPSECRET')
    } finally {
      if (prev === undefined) delete process.env['ZUSE_WEBFETCH_TIMEOUT_MS']
      else process.env['ZUSE_WEBFETCH_TIMEOUT_MS'] = prev
    }
  })
})
