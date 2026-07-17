import type { Tool, ToolContext, ToolResult, JSONSchema, WebSearchConfig } from '@zuse/core'
import { clampPositiveInt } from './util.js'

/** 搜索请求超时（毫秒）。 */
const SEARCH_TIMEOUT_MS = 15_000
/** 单条摘要字符上限：超出截断，避免一次搜索撑爆上下文。 */
const MAX_SNIPPET_CHARS = 500

/** 一条搜索结果的统一中间形态（各后端的响应都归一到这里）。 */
export interface SearchResult {
  title: string
  url: string
  snippet: string
}

/** 传给后端 search 函数的选项。apiKey 按后端逐个填入。 */
export interface SearchOpts {
  apiKey: string
  maxResults: number
  allowedDomains?: string[]
  blockedDomains?: string[]
}

/**
 * 后端失败时抛此错。retryable 决定 orchestrator 是否回退到下一个后端：
 * 坏 key（401/403）、限流（429）、5xx、网络/超时都可回退；400/422 等不可回退。
 */
export class WebSearchBackendError extends Error {
  readonly retryable: boolean
  readonly status?: number
  constructor(message: string, retryable: boolean, status?: number) {
    super(message)
    this.name = 'WebSearchBackendError'
    this.retryable = retryable
    this.status = status
  }
}

/** 后端搜索函数签名：纯请求/解析，失败抛 WebSearchBackendError。 */
export type SearchBackend = (
  query: string,
  opts: SearchOpts,
  signal: AbortSignal,
) => Promise<SearchResult[]>

// --- 网络 seam ---------------------------------------------------------------
// 后端的网络调用走 fetchImpl 而非直接 globalThis.fetch，单测可注入假实现、不打网络。
const realFetch: typeof fetch = (input, init) => globalThis.fetch(input, init)
let fetchImpl: typeof fetch = realFetch
/** 仅供测试：替换网络实现。 */
export function __setFetchImpl(fn: typeof fetch): void {
  fetchImpl = fn
}
/** 仅供测试：恢复真实网络实现。 */
export function __resetFetchImpl(): void {
  fetchImpl = realFetch
}

/** HTTP 状态码是否可回退：坏 key / 限流 / 服务端故障可回退，客户端请求错（4xx 其余）不可。 */
function statusRetryable(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status >= 500
}

/**
 * Tavily 后端：POST api.tavily.com/search。
 * 空域名数组不写进 body（写空数组会被 Tavily 当成「限定到零个域名」）。
 * 摘要取响应的 content 字段。失败按 statusRetryable 映射成可/不可回退。
 */
const searchTavily: SearchBackend = async (query, opts, signal) => {
  const body: Record<string, unknown> = {
    api_key: opts.apiKey,
    query,
    max_results: opts.maxResults,
  }
  if (opts.allowedDomains && opts.allowedDomains.length > 0) body.include_domains = opts.allowedDomains
  if (opts.blockedDomains && opts.blockedDomains.length > 0) body.exclude_domains = opts.blockedDomains

  let res: Response
  try {
    res = await fetchImpl('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    // 网络错误 / 超时 / abort：可回退（用户主动取消由 orchestrator 先行拦截）。
    const msg = err instanceof Error ? err.message : String(err)
    throw new WebSearchBackendError(`tavily request failed: ${msg}`, true)
  }
  if (!res.ok) {
    throw new WebSearchBackendError(
      `tavily HTTP ${res.status} ${res.statusText}`,
      statusRetryable(res.status),
      res.status,
    )
  }
  let data: unknown
  try {
    data = await res.json()
  } catch {
    throw new WebSearchBackendError('tavily returned invalid JSON', true)
  }
  const results = (data as { results?: unknown }).results
  if (!Array.isArray(results)) return []
  return results.map((r): SearchResult => {
    const item = r as { title?: unknown; url?: unknown; content?: unknown }
    return {
      title: typeof item.title === 'string' ? item.title : '',
      url: typeof item.url === 'string' ? item.url : '',
      snippet: typeof item.content === 'string' ? item.content : '',
    }
  })
}

/** Brave 单次返回条数上限（API 约束）。 */
const BRAVE_MAX_COUNT = 20

/**
 * 把域名过滤拼成 Brave 的查询操作符：Brave 没有 include/exclude 数组参数，
 * 只能用 `site:` / `-site:` 写进 q。allowed 多个用括号 OR 包起来。
 */
function braveQueryWithDomains(query: string, opts: SearchOpts): string {
  let q = query
  if (opts.allowedDomains && opts.allowedDomains.length > 0) {
    q += ' (' + opts.allowedDomains.map((d) => `site:${d}`).join(' OR ') + ')'
  }
  if (opts.blockedDomains && opts.blockedDomains.length > 0) {
    q += ' ' + opts.blockedDomains.map((d) => `-site:${d}`).join(' ')
  }
  return q
}

/**
 * Brave 后端：GET api.search.brave.com/res/v1/web/search。
 * key 走 X-Subscription-Token 头；count 上限 20。
 * 摘要取响应 web.results[].description。失败按 statusRetryable 映射成可/不可回退。
 */
const searchBrave: SearchBackend = async (query, opts, signal) => {
  const params = new URLSearchParams({
    q: braveQueryWithDomains(query, opts),
    count: String(Math.min(opts.maxResults, BRAVE_MAX_COUNT)),
  })
  let res: Response
  try {
    res = await fetchImpl(`https://api.search.brave.com/res/v1/web/search?${params.toString()}`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'accept-encoding': 'gzip',
        'x-subscription-token': opts.apiKey,
      },
      signal,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new WebSearchBackendError(`brave request failed: ${msg}`, true)
  }
  if (!res.ok) {
    throw new WebSearchBackendError(
      `brave HTTP ${res.status} ${res.statusText}`,
      statusRetryable(res.status),
      res.status,
    )
  }
  let data: unknown
  try {
    data = await res.json()
  } catch {
    throw new WebSearchBackendError('brave returned invalid JSON', true)
  }
  const results = (data as { web?: { results?: unknown } }).web?.results
  if (!Array.isArray(results)) return []
  return results.map((r): SearchResult => {
    const item = r as { title?: unknown; url?: unknown; description?: unknown }
    return {
      title: typeof item.title === 'string' ? item.title : '',
      url: typeof item.url === 'string' ? item.url : '',
      snippet: typeof item.description === 'string' ? item.description : '',
    }
  })
}

/**
 * 数据驱动的后端注册表：加后端 = 加一条 + 写一个 search 函数。
 * 切换/回退只认这里的 key 名：配置里的 backend / fallback 用同样的名字即可。
 */
const BACKENDS: Record<string, SearchBackend> = {
  tavily: searchTavily,
  brave: searchBrave,
}

/** 单条摘要：去空白并截断到上限。 */
function truncateSnippet(s: string): string {
  const t = s.trim()
  return t.length > MAX_SNIPPET_CHARS ? t.slice(0, MAX_SNIPPET_CHARS) + '…' : t
}

/** 把结果格式化为编号 Markdown 列表，交主模型阅读。空结果给出明确提示。 */
function formatResults(query: string, results: SearchResult[], maxResults: number): string {
  const items = results.slice(0, maxResults)
  if (items.length === 0) return `No results for: ${query}`
  const lines = items.map((r, i) => {
    const title = r.title || r.url || '(untitled)'
    const head = `${i + 1}. [${title}](${r.url})`
    return r.snippet ? `${head}\n   ${truncateSnippet(r.snippet)}` : head
  })
  const count = `Found ${items.length} result${items.length === 1 ? '' : 's'} for "${query}":`
  return `${count}\n\n${lines.join('\n\n')}`
}

interface WebSearchInput {
  query: string
  max_results?: number
  allowed_domains?: string[]
  blocked_domains?: string[]
}

const inputSchema: JSONSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'The search query. Include a year (e.g. "2026") when recency matters.',
    },
    max_results: {
      type: 'number',
      description: 'Maximum number of results to return. Optional; defaults to the configured limit.',
    },
    allowed_domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional: restrict results to these domains (e.g. ["docs.rs"]).',
    },
    blocked_domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional: exclude results from these domains.',
    },
  },
  required: ['query'],
}

/**
 * createWebSearchTool —— 用注入的配置造出 WebSearch 工具。
 * 用工厂而非静态 const：WebSearch 需要 apiKey，而 ToolContext 不携带 settings，
 * 故在构造时把已解析的 config 闭包进去（这是与静态的 WebFetch 的关键差异）。
 *
 * 非 readOnly：网络出口有副作用语义，不在 default 模式自动放行。
 * 不设 specifierFor → 授权规则为裸 `WebSearch`，一次授权覆盖后续所有搜索。
 * 工具内不调用任何 LLM、不抓正文（正文交 WebFetch）。
 */
export function createWebSearchTool(config: WebSearchConfig): Tool {
  // 本会话(本进程)内因鉴权失败(401/403)被拉黑的后端。key 坏了不会自愈,拉黑后
  // 后续调用直接跳过,不再每次都白吃一次 401。闭包于工厂、随进程消亡 —— 不持久化,
  // 下次重启(可能已改对 key)重新来过。仅永久性失败入此集合:429/5xx/网络是临时的,不拉黑。
  const disabledBackends = new Set<string>()
  return {
    name: 'WebSearch',
    description:
      'Search the web and return a ranked list of results (title, URL, snippet) as Markdown. ' +
      'Use this to discover relevant pages, then WebFetch to read a specific one. ' +
      'Does not fetch page bodies itself. Supports optional domain allow/block lists.',
    inputSchema,
    // 故意不设 readOnly / specifierFor：见上方 doc。

    async run(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
      const input = (rawInput ?? {}) as WebSearchInput
      if (!input.query || typeof input.query !== 'string') {
        return { output: 'WebSearch requires a query.', isError: true }
      }
      const query = input.query
      const maxResults = clampPositiveInt(input.max_results, config.maxResults)
      const baseOpts: Omit<SearchOpts, 'apiKey'> = {
        maxResults,
        allowedDomains: Array.isArray(input.allowed_domains) ? input.allowed_domains : undefined,
        blockedDomains: Array.isArray(input.blocked_domains) ? input.blocked_domains : undefined,
      }

      // 候选链：主后端 + fallback，去重，剔除没 key / 没实现 / 本会话已拉黑的后端。
      const chain: string[] = []
      let skippedDisabled = false
      for (const name of [config.backend, ...config.fallback]) {
        if (chain.includes(name)) continue
        if (disabledBackends.has(name)) { skippedDisabled = true; continue } // 本会话已因 401/403 拉黑
        if (!config.backends[name]) continue // 没 key
        if (!BACKENDS[name]) continue // 没实现（如占位的 brave）
        chain.push(name)
      }
      if (chain.length === 0) {
        // 区分两种空链：全被本会话拉黑（key 坏了）vs 压根没配可用后端。
        return {
          output: skippedDisabled
            ? 'WebSearch: all backends disabled this session after auth failure (401/403); fix the API key and restart.'
            : 'WebSearch: no usable backend configured.',
          isError: true,
        }
      }

      const failures: string[] = []
      let lastError: WebSearchBackendError | null = null

      for (const name of chain) {
        if (ctx.signal.aborted) return { output: 'WebSearch cancelled.', isError: true }
        const backend = BACKENDS[name]!
        const apiKey = config.backends[name]!.apiKey
        // 每次尝试各自计时：超时与用户中断合并，任一触发都中止本次请求。
        const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS)
        const signal = AbortSignal.any([ctx.signal, timeoutSignal])
        try {
          const results = await backend(query, { ...baseOpts, apiKey }, signal)
          // 成功（含空结果即停，空结果是有效答案、不回退）。把发生过的回退作为 note 抬头。
          const note = failures.length > 0 ? `[note: ${failures.join('; ')}; used ${name}]\n\n` : ''
          return { output: note + formatResults(query, results, maxResults), isError: false }
        } catch (err) {
          // 用户取消优先于一切（含超时）：直接中止整个工具，不回退。
          if (ctx.signal.aborted) return { output: 'WebSearch cancelled.', isError: true }
          const be =
            err instanceof WebSearchBackendError
              ? err
              : new WebSearchBackendError(err instanceof Error ? err.message : String(err), true)
          lastError = be
          // 鉴权失败本进程内不会自愈：拉黑该后端，本会话后续调用直接跳过，不再白吃 401/403。
          if (be.status === 401 || be.status === 403) disabledBackends.add(name)
          if (be.retryable) {
            failures.push(be.status ? `${name} failed (${be.status})` : `${name} failed (${be.message})`)
            continue // 试下一个后端
          }
          // 不可回退（如 400）：换后端也一样错，立即返回。
          return { output: `WebSearch failed: ${be.message}`, isError: true }
        }
      }
      // 链上所有后端都 retryable 失败。
      return { output: `WebSearch failed: ${lastError?.message ?? 'all backends failed'}`, isError: true }
    },
  }
}

export const toolModule = {
  make: (o) => createWebSearchTool(o.webSearch!),
  enabled: (o) => !!o.webSearch,
} satisfies import('./tool-module.js').ToolModule
