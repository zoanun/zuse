// turndown-plugin-gfm 无类型，其 ambient 声明在同目录 .d.ts。本仓库各包直接编译源码
// （不预构建），故用 triple-slash 引用让任何编译到本文件的 program（含 @zuse/tui）都加载它。
/// <reference path="./turndown-plugin-gfm.d.ts" />
import { TextDecoder } from 'node:util'
import { JSDOM, VirtualConsole } from 'jsdom'
import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import type { Tool, ToolContext, ToolResult, JSONSchema } from '@zuse/core'

/** 抓取超时（毫秒）。 */
const FETCH_TIMEOUT_MS = 30_000
/** 缓存存活时间（毫秒）：15 分钟，进程重启即清空。 */
const CACHE_TTL_MS = 15 * 60_000
/** 输出字符上限（约 1.2 万~2.5 万 token），超出截断。 */
const MAX_OUTPUT_CHARS = 50_000
/** 拟真浏览器 User-Agent，减少被简单反爬拦截。 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 zuse-webfetch'

/** 内存缓存接口：键为规范化 URL，值为已格式化的输出文本。 */
export interface FetchCache {
  get(key: string): string | undefined
  set(key: string, value: string): void
}

/**
 * 创建带 TTL 的内存缓存。`now` 可注入便于单测过期逻辑；生产用 Date.now。
 * 命中即返回；过期则删除并返回 undefined（惰性清理，无后台定时器）。
 */
export function createFetchCache(ttlMs: number, now: () => number = Date.now): FetchCache {
  const store = new Map<string, { value: string; expiresAt: number }>()
  return {
    get(key: string): string | undefined {
      const entry = store.get(key)
      if (!entry) return undefined
      if (now() >= entry.expiresAt) {
        store.delete(key)
        return undefined
      }
      return entry.value
    },
    set(key: string, value: string): void {
      store.set(key, { value, expiresAt: now() + ttlMs })
    },
  }
}

/**
 * 解码 Cloudflare 邮箱混淆的 hex(来自 data-cfemail 属性或 email-protection#hex 片段）。
 * 算法：hex 首字节是 XOR key，其余字节逐个异或还原；CF 每次加载随机换 key，所以每次
 * 都重新取首字节，对 key 轮换天然免疫。非法输入（非 hex / 奇数长度 / 不足 2 字节）返回 null。
 * 注意：CF 会混淆任何形如 x@y 的文本，哪怕不是真邮箱（如 python@3.12）—— 正是本仓库要还原的。
 */
function decodeCfEmail(hex: string): string | null {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < 4 || hex.length % 2 !== 0) return null
  const pairs = hex.match(/../g)
  if (!pairs) return null
  const bytes = pairs.map((h) => parseInt(h, 16))
  const key = bytes[0]!
  const out = new Uint8Array(bytes.length - 1)
  for (let i = 1; i < bytes.length; i++) out[i - 1] = bytes[i]! ^ key
  return new TextDecoder().decode(out)
}

/**
 * 就地还原文档里所有 Cloudflare 混淆的邮箱/文本：把混淆节点替换成解码后的纯文本节点，
 * 等价于浏览器端 email-decode.min.js 跑完后的 DOM。两种来源都覆盖：
 *   1. 任意元素上的 data-cfemail 属性（a / span 等）
 *   2. href 携带 hex 片段的链接（原文为 mailto: 时可能只有这种）
 * 不抓取时无网络无 JS，CF 的占位符 [email protected] 会原样进 markdown；这里把它还原。
 * 必须在 readability/turndown 之前、且在 fallback 快照之前调用（见 extractContent）。
 */
function deobfuscateCfEmails(dom: JSDOM): void {
  const doc = dom.window.document
  for (const el of Array.from(doc.querySelectorAll('[data-cfemail]'))) {
    const decoded = decodeCfEmail(el.getAttribute('data-cfemail') ?? '')
    if (decoded !== null) el.replaceWith(doc.createTextNode(decoded))
  }
  for (const a of Array.from(doc.querySelectorAll('a[href*="/cdn-cgi/l/email-protection#"]'))) {
    const decoded = decodeCfEmail((a.getAttribute('href') ?? '').split('#')[1] ?? '')
    if (decoded !== null) a.replaceWith(doc.createTextNode(decoded))
  }
}

/**
 * 把 HTML 抽成「标题 + 正文 Markdown」。纯函数、无网络、无 IO。
 * 流程：jsdom 解析 → readability 取主正文（失败/为空则回退整个 body）→ turndown 转 Markdown。
 * readability 会就地改写传入的 document，所以回退所需的标题/正文先存成字符串快照再调用它。
 */
export function extractContent(html: string, url: string): { title: string; markdown: string } {
  // 用一个无监听的 VirtualConsole 吞掉 jsdom 的 CSS/资源解析噪声，避免污染日志。
  const virtualConsole = new VirtualConsole()
  const dom = new JSDOM(html, { url, virtualConsole })
  const doc = dom.window.document

  // 先还原 Cloudflare 邮箱混淆：必须早于下面的 fallback 快照与 readability/turndown，
  // 否则两条路径都会漏解码，markdown 里仍是占位符 [email protected]。
  deobfuscateCfEmails(dom)

  // 先取快照：readability 解析会改写 doc。
  const fallbackTitle = doc.title || ''
  const fallbackBody = doc.body?.innerHTML ?? ''

  let title = fallbackTitle
  let contentHtml = fallbackBody
  try {
    const article = new Readability(doc).parse()
    if (article && article.content && article.content.trim() !== '') {
      title = article.title || fallbackTitle
      contentHtml = article.content
    }
  } catch {
    // 抽取异常 → 沿用 body 快照。
  }

  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  turndown.use(gfm)
  const markdown = turndown.turndown(contentHtml).trim()
  return { title: title.trim(), markdown }
}

// --- 网络 seam ---------------------------------------------------------------
// run 的网络调用走 fetchImpl 而非直接 globalThis.fetch，单测可注入假实现、不打网络。
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

// --- 缓存实例 ---------------------------------------------------------------
let cache = createFetchCache(CACHE_TTL_MS)
/** 仅供测试：清空缓存，避免用例间相互污染。 */
export function __clearCache(): void {
  cache = createFetchCache(CACHE_TTL_MS)
}

// 一组当作正文原样返回的非 HTML 文本类型。
const PLAIN_TYPES = new Set(['text/plain', 'application/json', 'text/markdown'])

/** 组装最终输出：有标题则「# 标题 + 来源 URL」抬头，否则仅 URL。 */
function formatOutput(title: string, url: string, content: string): string {
  const header = title ? `# ${title}\n${url}` : url
  return `${header}\n\n${content}`
}

/**
 * 超过上限则截断并附提示。
 * 注意：作用于含抬头（# 标题 + URL）的最终 output，而非仅正文 ——
 * 目的是给「最终回喂给模型的总文本」设上限，抬头开销（通常 <200 字符）一并计入。
 */
function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return text.slice(0, MAX_OUTPUT_CHARS) + `\n\n[内容已截断，原文超过 ${MAX_OUTPUT_CHARS} 字符]`
}

interface WebFetchInput {
  url: string
}

const inputSchema: JSONSchema = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      description: 'The absolute http(s) URL to fetch. Returns the page main content as Markdown.',
    },
  },
  required: ['url'],
}

/**
 * WebFetchTool —— 抓取一个网页，抽取正文并转为 Markdown 返回，由主模型自行阅读。
 * 不在工具内调用任何 LLM（方案 B）。非 readOnly：网络出口有副作用语义，不在 default 模式自动放行。
 * 已知限制：不执行 JS，抓不到 SPA 客户端渲染的正文（与 curl 相同），此时返回提示而非空白。
 */
export const WebFetchTool: Tool = {
  name: 'WebFetch',
  description:
    'Fetch a web page over http(s) and return its main content as Markdown. ' +
    'Extracts the primary article text, stripping nav/ads/scripts. ' +
    'Does not execute JavaScript, so it cannot read content rendered client-side (SPAs). ' +
    'Results are cached briefly. Input: a single absolute url.',
  inputSchema,
  // 故意不设 readOnly：网络出口不应像本地只读那样在 default 模式自动放行。
  specifierFor: (input: unknown): string | null => {
    const u = (input as { url?: unknown }).url
    if (typeof u !== 'string') return null
    try {
      return new URL(u).hostname
    } catch {
      return null
    }
  },

  async run(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = (rawInput ?? {}) as WebFetchInput
    if (!input.url || typeof input.url !== 'string') {
      return { output: 'WebFetch requires a url.', isError: true }
    }

    let parsed: URL
    try {
      parsed = new URL(input.url)
    } catch {
      return { output: `Invalid URL: ${input.url}`, isError: true }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { output: 'Invalid URL: only http and https are supported.', isError: true }
    }

    // 缓存 key 去掉 fragment（#... 不影响服务端响应）。
    const cacheKey = parsed.origin + parsed.pathname + parsed.search
    const cached = cache.get(cacheKey)
    if (cached !== undefined) return { output: cached, isError: false }

    // 超时与用户中断合并：任一触发都中止抓取。
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
    const signal = AbortSignal.any([ctx.signal, timeoutSignal])

    let res: Response
    try {
      res = await fetchImpl(parsed.href, {
        redirect: 'follow',
        signal,
        headers: { 'user-agent': USER_AGENT },
      })
    } catch (err) {
      // 判定顺序有意为之：用户中断（ctx.signal）优先于超时。两者同刻触发时，
      // 优先报「已取消」更贴合用户意图。改动这里的顺序前请保留此优先级。
      if (ctx.signal.aborted) return { output: 'WebFetch cancelled.', isError: true }
      if (timeoutSignal.aborted) {
        return { output: `WebFetch timed out after ${FETCH_TIMEOUT_MS}ms.`, isError: true }
      }
      const msg = err instanceof Error ? err.message : String(err)
      return { output: `WebFetch failed: ${msg}`, isError: true }
    }

    if (!res.ok) {
      return { output: `HTTP ${res.status} ${res.statusText}`, isError: true }
    }

    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    const body = await res.text()

    let output: string
    if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
      const { title, markdown } = extractContent(body, parsed.href)
      const content =
        markdown.trim() === ''
          ? '正文为空，页面可能为 JS 客户端渲染（SPA）；可尝试其数据接口或直接粘贴内容。'
          : markdown
      output = formatOutput(title, parsed.href, content)
    } else if (PLAIN_TYPES.has(contentType)) {
      output = formatOutput('', parsed.href, body)
    } else {
      return { output: `Unsupported content type: ${contentType || 'unknown'}`, isError: true }
    }

    output = truncate(output)
    cache.set(cacheKey, output)
    return { output, isError: false }
  },
}
