import { describe, it, expect, afterEach } from 'vitest'
import { createFileTracker, type ToolContext, type WebSearchConfig } from '@zuse/core'
import { createWebSearchTool, __setFetchImpl, __resetFetchImpl } from './websearch.js'

function ctx(signal?: AbortSignal): ToolContext {
  return { cwd: process.cwd(), signal: signal ?? new AbortController().signal, tracker: createFileTracker() }
}

/** 造一个 Tavily 风格的 JSON 响应。 */
function tavilyResponse(results: Array<{ title: string; url: string; content: string }>): Response {
  return new Response(JSON.stringify({ results }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** 造一个 Brave 风格的 JSON 响应（结果在 web.results，摘要字段是 description）。 */
function braveResponse(results: Array<{ title: string; url: string; description: string }>): Response {
  return new Response(JSON.stringify({ web: { results } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** 按目标 host 路由 fetch：tavily / brave 各给一个处理器，命中谁看 URL。 */
function routeFetch(routes: {
  tavily?: () => Response | Promise<Response>
  brave?: () => Response | Promise<Response>
}): void {
  __setFetchImpl(async (url) => {
    const u = String(url)
    if (u.includes('tavily.com') && routes.tavily) return routes.tavily()
    if (u.includes('brave.com') && routes.brave) return routes.brave()
    return new Response('unrouted', { status: 500, statusText: 'Unrouted' })
  })
}

const SINGLE: WebSearchConfig = {
  backend: 'tavily',
  fallback: [],
  maxResults: 5,
  backends: { tavily: { apiKey: 'tvly-x' } },
}

/** tavily 主 + brave 回退；回退用例用 routeFetch 按 URL 给两个真实后端各造响应。 */
const WITH_FALLBACK: WebSearchConfig = {
  backend: 'tavily',
  fallback: ['brave'],
  maxResults: 5,
  backends: { tavily: { apiKey: 'tvly-x' }, brave: { apiKey: 'BSA-x' } },
}

afterEach(() => {
  __resetFetchImpl()
})

describe('WebSearch — query 拼装', () => {
  it('把 max_results / allowed_domains / blocked_domains 映射进 Tavily body；空域名不出现', async () => {
    let captured: Record<string, unknown> = {}
    __setFetchImpl(async (_url, init) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>
      return tavilyResponse([])
    })
    const tool = createWebSearchTool(SINGLE)
    await tool.run(
      { query: 'rust async 2026', max_results: 3, allowed_domains: ['docs.rs'], blocked_domains: [] },
      ctx(),
    )
    expect(captured.query).toBe('rust async 2026')
    expect(captured.max_results).toBe(3)
    expect(captured.include_domains).toEqual(['docs.rs'])
    expect('exclude_domains' in captured).toBe(false) // 空数组不写进 body
  })
})

describe('WebSearch — 结果格式化', () => {
  it('多结果 → 编号 Markdown 列表', async () => {
    __setFetchImpl(async () =>
      tavilyResponse([
        { title: 'A', url: 'https://a.test', content: 'about a' },
        { title: 'B', url: 'https://b.test', content: 'about b' },
      ]),
    )
    const result = await createWebSearchTool(SINGLE).run({ query: 'q' }, ctx())
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('Found 2 results for "q":')
    expect(result.output).toContain('1. [A](https://a.test)')
    expect(result.output).toContain('about a')
    expect(result.output).toContain('2. [B](https://b.test)')
  })

  it('超长摘要被截断', async () => {
    const long = 'x'.repeat(2000)
    __setFetchImpl(async () => tavilyResponse([{ title: 'A', url: 'https://a.test', content: long }]))
    const result = await createWebSearchTool(SINGLE).run({ query: 'q' }, ctx())
    expect(result.output).toContain('…')
    expect(result.output.length).toBeLessThan(1000)
  })

  it('空结果 → No results，且不是错误', async () => {
    __setFetchImpl(async () => tavilyResponse([]))
    const result = await createWebSearchTool(SINGLE).run({ query: 'nothing' }, ctx())
    expect(result.isError).toBeFalsy()
    expect(result.output).toBe('No results for: nothing')
  })
})

describe('WebSearch — 回退', () => {
  it('主后端 401（可回退）且无下家 → 返回错误', async () => {
    __setFetchImpl(async () => new Response('nope', { status: 401, statusText: 'Unauthorized' }))
    const result = await createWebSearchTool(SINGLE).run({ query: 'q' }, ctx())
    expect(result.isError).toBe(true)
    expect(result.output).toContain('401')
  })

  it('主后端 401 → 回退到 brave 并成功，输出含回退 note', async () => {
    routeFetch({
      tavily: () => new Response('nope', { status: 401, statusText: 'Unauthorized' }),
      brave: () => braveResponse([{ title: 'B', url: 'https://b.test', description: 'from brave' }]),
    })
    const result = await createWebSearchTool(WITH_FALLBACK).run({ query: 'q' }, ctx())
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('from brave')
    expect(result.output).toContain('[note:')
    expect(result.output).toContain('tavily failed (401)')
  })

  it('主后端 400（不可回退）→ 直接返回错误，不试 brave', async () => {
    let braveCalled = false
    routeFetch({
      tavily: () => new Response('bad', { status: 400, statusText: 'Bad Request' }),
      brave: () => {
        braveCalled = true
        return braveResponse([])
      },
    })
    const result = await createWebSearchTool(WITH_FALLBACK).run({ query: 'q' }, ctx())
    expect(result.isError).toBe(true)
    expect(result.output).toContain('400')
    expect(braveCalled).toBe(false)
  })

  it('主后端空结果（200）→ 不回退，直接 No results', async () => {
    let braveCalled = false
    routeFetch({
      tavily: () => tavilyResponse([]),
      brave: () => {
        braveCalled = true
        return braveResponse([{ title: 'B', url: 'https://b.test', description: 'from brave' }])
      },
    })
    const result = await createWebSearchTool(WITH_FALLBACK).run({ query: 'q' }, ctx())
    expect(result.output).toBe('No results for: q')
    expect(braveCalled).toBe(false)
  })

  it('链上后端全 retryable 失败 → 返回最后一个错误', async () => {
    routeFetch({
      tavily: () => new Response('down', { status: 503, statusText: 'Unavailable' }),
      brave: () => new Response('down', { status: 502, statusText: 'Bad Gateway' }),
    })
    const result = await createWebSearchTool(WITH_FALLBACK).run({ query: 'q' }, ctx())
    expect(result.isError).toBe(true)
    expect(result.output).toContain('502')
  })
})

describe('WebSearch — 会话内拉黑（401/403 不再重试）', () => {
  it('401 后端在同一工具实例的后续调用中被跳过，不再发请求', async () => {
    let tavilyCalls = 0
    let braveCalls = 0
    routeFetch({
      tavily: () => {
        tavilyCalls++
        return new Response('nope', { status: 401, statusText: 'Unauthorized' })
      },
      brave: () => {
        braveCalls++
        return braveResponse([{ title: 'B', url: 'https://b.test', description: 'from brave' }])
      },
    })
    const tool = createWebSearchTool(WITH_FALLBACK)

    // 第 1 次：tavily 吃 401 → 回退 brave，且带回退 note
    const r1 = await tool.run({ query: 'q1' }, ctx())
    expect(r1.isError).toBeFalsy()
    expect(r1.output).toContain('from brave')
    expect(r1.output).toContain('tavily failed (401)')

    // 第 2 次：tavily 已被拉黑 → 直接走 brave，不再请求 tavily，也不再有回退 note
    const r2 = await tool.run({ query: 'q2' }, ctx())
    expect(r2.isError).toBeFalsy()
    expect(r2.output).toContain('from brave')
    expect(r2.output).not.toContain('[note:')

    expect(tavilyCalls).toBe(1) // 只在第 1 次试过一次
    expect(braveCalls).toBe(2)
  })

  it('唯一后端 401 被拉黑后，后续调用返回“本会话已禁用”错误', async () => {
    __setFetchImpl(async () => new Response('nope', { status: 401, statusText: 'Unauthorized' }))
    const tool = createWebSearchTool(SINGLE)
    const r1 = await tool.run({ query: 'q1' }, ctx())
    expect(r1.isError).toBe(true)
    expect(r1.output).toContain('401')
    const r2 = await tool.run({ query: 'q2' }, ctx())
    expect(r2.isError).toBe(true)
    expect(r2.output).toContain('disabled this session')
  })

  it('临时失败（503）不拉黑：后续调用仍会重试该后端', async () => {
    let tavilyCalls = 0
    routeFetch({
      tavily: () => {
        tavilyCalls++
        return new Response('down', { status: 503, statusText: 'Unavailable' })
      },
      brave: () => braveResponse([{ title: 'B', url: 'https://b.test', description: 'from brave' }]),
    })
    const tool = createWebSearchTool(WITH_FALLBACK)
    await tool.run({ query: 'q1' }, ctx())
    await tool.run({ query: 'q2' }, ctx())
    expect(tavilyCalls).toBe(2) // 503 是临时的，每次都重试，不拉黑
  })
})

describe('WebSearch — 取消与缺后端', () => {
  it('ctx.signal 已 abort → 返回 cancelled，不发请求', async () => {
    let called = false
    __setFetchImpl(async () => {
      called = true
      return tavilyResponse([])
    })
    const ac = new AbortController()
    ac.abort()
    const result = await createWebSearchTool(SINGLE).run({ query: 'q' }, ctx(ac.signal))
    expect(result.output).toBe('WebSearch cancelled.')
    expect(called).toBe(false)
  })

  it('缺 query → 报错', async () => {
    const result = await createWebSearchTool(SINGLE).run({}, ctx())
    expect(result.isError).toBe(true)
  })

  it('链上无可用后端（配置指向未实现的后端）→ 报错', async () => {
    const cfg: WebSearchConfig = {
      backend: 'bing', // 未实现
      fallback: [],
      maxResults: 5,
      backends: { bing: { apiKey: 'x' } },
    }
    const result = await createWebSearchTool(cfg).run({ query: 'q' }, ctx())
    expect(result.isError).toBe(true)
    expect(result.output).toContain('no usable backend')
  })
})

describe('WebSearch — brave 后端', () => {
  it('backend 设为 brave 时直接走 brave，结果取 web.results[].description', async () => {
    const cfg: WebSearchConfig = {
      backend: 'brave',
      fallback: [],
      maxResults: 5,
      backends: { brave: { apiKey: 'BSA-x' } },
    }
    routeFetch({
      brave: () => braveResponse([{ title: 'Brave A', url: 'https://a.test', description: 'desc a' }]),
    })
    const result = await createWebSearchTool(cfg).run({ query: 'q' }, ctx())
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('1. [Brave A](https://a.test)')
    expect(result.output).toContain('desc a')
  })

  it('allowed/blocked 域名拼成 site:/-site: 查询操作符', async () => {
    const cfg: WebSearchConfig = {
      backend: 'brave',
      fallback: [],
      maxResults: 5,
      backends: { brave: { apiKey: 'BSA-x' } },
    }
    let q = ''
    __setFetchImpl(async (url) => {
      q = new URL(String(url)).searchParams.get('q') ?? ''
      return braveResponse([])
    })
    await createWebSearchTool(cfg).run(
      { query: 'rust', allowed_domains: ['docs.rs', 'crates.io'], blocked_domains: ['spam.test'] },
      ctx(),
    )
    expect(q).toContain('rust')
    expect(q).toContain('(site:docs.rs OR site:crates.io)')
    expect(q).toContain('-site:spam.test')
  })
})

describe('WebSearch — 元数据', () => {
  it('非 readOnly，无 specifierFor（裸 WebSearch 授权）', () => {
    const tool = createWebSearchTool(SINGLE)
    expect(tool.readOnly).toBeFalsy()
    expect(tool.specifierFor).toBeUndefined()
    expect(tool.name).toBe('WebSearch')
  })
})
