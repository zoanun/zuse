// turndown-plugin-gfm 无类型，其 ambient 声明在同目录 .d.ts。本仓库各包直接编译源码
// （不预构建），故用 triple-slash 引用让任何编译到本文件的 program（含 @zuse/tui）都加载它。
// 这是该机制的必要用法，故对此行豁免 triple-slash-reference 规则。
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./turndown-plugin-gfm.d.ts" />
import { TextDecoder } from 'node:util'
import { JSDOM, VirtualConsole } from 'jsdom'
import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import type { Tool, ToolContext, ToolResult, JSONSchema } from '@zuse/core'
import { shapeHeadTail } from './truncate.js'

/** 单跳抓取超时（毫秒）。注意是**每一跳**各自一个，不是整条重定向链共用一个。 */
const FETCH_TIMEOUT_MS = 30_000
/**
 * 单跳超时的可覆盖读取。存在的唯一理由是让「超时是不是每跳新建」这条能被测到 ——
 * 共用一个 signal 的错误实现下，用户在权限弹框上答慢了，下一跳会以「网络超时」失败，
 * 把锅甩给网络。要测它就得让超时短到秒级以下，否则用例要跑 30 秒。
 */
function fetchTimeoutMs(): number {
  const n = Number(process.env['ZUSE_WEBFETCH_TIMEOUT_MS'])
  return Number.isFinite(n) && n > 0 ? n : FETCH_TIMEOUT_MS
}
/**
 * 会跟随的重定向状态码。**写死这个集合，不要写「是 3xx 就跳」。**
 * 实测（node v22）：现行的 `redirect: 'follow'` 对 300 / 304 **即使带 Location 也不跟随**，
 * 而 301/302/303/307/308 跟随。自己实现循环时写宽了，等于凭空多一条现行实现根本不会走的
 * 出站请求路径 —— 那不是这次改动想要的。
 * （303 会改方法、307/308 保持方法；本工具只发 GET，两者对我们都无影响。）
 */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
/**
 * 一次调用最多跟随几跳。取 10 而不是浏览器/undici 的 20：够用，且超限报错而不是
 * 静默停在中途。**别按「每多一跳多一次弹窗」去压这个数** —— 同主机跳一次都不弹，
 * 弹窗数由链上不同主机的个数决定，与跳数没有单调关系；压到 5 会误伤
 * `http→https→www→尾斜杠→地区→同意页→登录` 这类真实存在的长链。
 */
const MAX_REDIRECTS = 10
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

/**
 * 组装最终输出：有标题则「# 标题 + 来源 URL」抬头，否则仅 URL。
 * `note` 用来说明「这内容其实来自重定向后的另一个地址」—— 只在真跳过时给，
 * 不给无重定向的常见情况增加噪声。
 */
function formatOutput(title: string, url: string, content: string, note?: string): string {
  const header = title ? `# ${title}\n${url}` : url
  return `${header}${note === undefined ? '' : `\n${note}`}\n\n${content}`
}

/**
 * 主机名等价写法归一。**只做 URL 层可判定、无歧义、无副作用的两件事。**
 *
 * 权限规则的限定符匹配是**字面 glob**（permission.ts 的 `globToRegExp(...).test(...)`），
 * 而 `new URL().hostname` 的归一并不完整。实测（node v22）：
 *
 *   http://localhost./          → hostname = 'localhost.'      ← 尾点保留
 *   http://[::ffff:127.0.0.1]/  → hostname = '[::ffff:7f00:1]' ← 且被压成十六进制
 *
 * 而这两个写法**真的连得到**只监听 127.0.0.1 的服务器（实测取到了 payload）。
 * 于是 `deny: WebFetch(localhost)` 挡不住 `http://localhost./` —— 这个洞今天在**入口闸**
 * 上就存在，不需要重定向；重定向路径上更是对方站点用 Location 单方面就能触发。
 *
 * 大小写、IDN、十进制/十六进制 IP、**IPv4 的**尾点，`new URL()` 已经归一好了
 *（实测：EXAMPLE.com→example.com、中国.com→xn--fiqs8s.com、2130706433→127.0.0.1、
 * 0x7f.1→127.0.0.1、127.1→127.0.0.1、127.0.0.1.→127.0.0.1）——
 * **不要再 toLowerCase()，也不要担心大小写绕过。**
 *
 * 其余 IPv6 一律原样返回：自己写通用 IPv6 归一是另一个能出 bug 的坑，而收益是零。
 */
export function canonicalHost(hostname: string): string {
  let h = hostname
  // 末尾单点：'example.com.' 与 'example.com' 是同一台机器，规则却分得开。
  if (h.length > 1 && h.endsWith('.')) h = h.slice(0, -1)
  // IPv4-mapped IPv6 的压缩十六进制形式（Node 实际给出的就是这个形状）。
  const hex = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/i.exec(h)
  if (hex !== null) {
    const hi = parseInt(hex[1]!, 16)
    const lo = parseInt(hex[2]!, 16)
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
  }
  // 字面点分形式：Node 目前不会产出，但别人构造的 URL 字符串里可能有。
  const dotted = /^\[::ffff:(\d{1,3}(?:\.\d{1,3}){3})\]$/.exec(h)
  if (dotted !== null) return dotted[1]!
  return h
}

/**
 * 超过上限则截断并附统一 marker(Phase 9 输出整形,共享 shapeHeadTail)。
 * 只留头不留尾:文章正文头部是信号,尾部多为页脚杂讯;不落盘(重抓有 15min 缓存,代价低)。
 * 注意:作用于含抬头(# 标题 + URL)的最终 output,而非仅正文 ——
 * 目的是给「最终回喂给模型的总文本」设上限,抬头开销(通常 <200 字符)一并计入。
 */
function truncate(text: string): string {
  return shapeHeadTail(text, { headChars: MAX_OUTPUT_CHARS, tailChars: 0 }).body
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
      // 走 canonicalHost 而不是裸 hostname：否则 `http://localhost./` 逃得掉
      // `deny: WebFetch(localhost)`，且它真连得到本机（见 canonicalHost 注释）。
      return canonicalHost(new URL(u).hostname)
    } catch {
      return null
    }
  },
  // 主机名不是文件路径 —— 把它拿去 resolve(cwd, 'github.com') 当路径比是纯属巧合才对得上。
  specifierKind: 'opaque',

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

    // --- 重定向循环 -------------------------------------------------------
    // 用 redirect:'manual' 自己跳，因为 'follow' 之下「跳到哪儿去了」没有任何人再看一眼：
    // 实测配了 deny: WebFetch(127.0.0.1)，从 localhost 302 过去照样把内容取回来了。
    //
    // 地基（必须知道，否则会有人把它「修」回浏览器语义）：WHATWG fetch 规范规定 manual
    // 模式返回 opaque-redirect filtered response（status 0 / header 空 / body null），
    // 照规范读这个方案根本不可能实现。**Node/undici 不是这样** —— 实测 type='basic'、
    // header 全在、Location 读得到、无 Location 时是 null（不是 undefined）。
    let current = parsed
    const hops: URL[] = []
    // 本次调用内已放行过的主机名。没有它，a→b→a→b 会为 b 弹两次框
    //（「仅此一次」不进 sessionAllow，第二次照样问）。
    const approved = new Set([canonicalHost(parsed.hostname)])
    let crossedHost = false
    let res: Response

    for (;;) {
      // 每一跳新建超时，只度量**网络**时间。共用一个的话，用户盯着权限弹框想 40 秒，
      // 下一跳会立刻以「WebFetch timed out」失败 —— 用户点了「允许」却看到网络超时。
      const timeoutMs = fetchTimeoutMs()
      const timeoutSignal = AbortSignal.timeout(timeoutMs)
      const signal = AbortSignal.any([ctx.signal, timeoutSignal])
      try {
        res = await fetchImpl(current.href, {
          redirect: 'manual',
          signal,
          headers: { 'user-agent': USER_AGENT },
        })
      } catch (err) {
        // 判定顺序有意为之：用户中断（ctx.signal）优先于超时。两者同刻触发时，
        // 优先报「已取消」更贴合用户意图。改动这里的顺序前请保留此优先级。
        if (ctx.signal.aborted) return { output: 'WebFetch cancelled.', isError: true }
        if (timeoutSignal.aborted) {
          return { output: `WebFetch timed out after ${timeoutMs}ms (${current.href}).`, isError: true }
        }
        const msg = err instanceof Error ? err.message : String(err)
        return { output: `WebFetch failed: ${msg}`, isError: true }
      }

      // 非重定向状态码、或重定向状态码但没有 Location → 这就是终态响应，交给下面处理。
      const loc = REDIRECT_STATUS.has(res.status) ? res.headers.get('location') : null
      if (loc === null) break

      if (hops.length >= MAX_REDIRECTS) {
        return {
          output: `WebFetch 跟随重定向超过上限（${MAX_REDIRECTS} 跳），停在 ${current.href}。`,
          isError: true,
        }
      }

      let next: URL
      try {
        // base 必须是**当前跳**，不是入口 —— 相对 Location 在第二跳之后就会解析到错误的源。
        next = new URL(loc, current.href)
      } catch {
        return { output: `WebFetch 收到无法解析的 Location：${loc}`, isError: true }
      }
      // 入口的 scheme 检查只查了入口。改成 manual 之后 `Location: file:///…`、`data:`
      // 不再有 undici 兜着，必须每跳自己查。
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        return {
          output: `WebFetch 拒绝跟随到非 http(s) 的重定向：${next.protocol}//… （来自 ${current.href}）`,
          isError: true,
        }
      }

      const host = canonicalHost(next.hostname)
      if (host !== canonicalHost(current.hostname)) {
        crossedHost = true
        if (!approved.has(host)) {
          if (ctx.checkSpecifier === undefined) {
            // fail closed：宁可「跨站重定向抓不了」这种看得见的报错，也不要权限闸静默失效。
            return {
              output:
                `WebFetch 拒绝跟随跨主机重定向（${current.hostname} → ${host}）：` +
                '当前运行环境没有提供权限复检口，无法确认该主机是否被允许。请直接抓取目标 URL。',
              isError: true,
            }
          }
          const verdict = await ctx.checkSpecifier(host)
          if (verdict !== 'allow') {
            return {
              output:
                `WebFetch 跟随重定向到 ${host} 被权限规则拒绝（起自 ${parsed.href}）。` +
                '不要重试同一调用；如确需该主机的内容，请让用户放行它。',
              isError: true,
            }
          }
          approved.add(host)
        }
      }

      hops.push(next)
      current = next
    }

    if (!res.ok) {
      return { output: `HTTP ${res.status} ${res.statusText}`, isError: true }
    }

    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    const body = await res.text()

    // 抬头和 jsdom 的 base URL 都必须是**最终** URL。原来用的是入口 URL —— 输出会告诉
    // 模型「这内容来自 A」而它其实来自 B，页面里的相对链接也会解析到错误的源上。
    const finalUrl = current.href
    const note =
      hops.length === 0 ? undefined : `（经 ${hops.length} 次重定向，起自 ${parsed.href}）`

    let output: string
    if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
      const { title, markdown } = extractContent(body, finalUrl)
      const content =
        markdown.trim() === ''
          ? '正文为空，页面可能为 JS 客户端渲染（SPA）；可尝试其数据接口或直接粘贴内容。'
          : markdown
      output = formatOutput(title, finalUrl, content, note)
    } else if (PLAIN_TYPES.has(contentType)) {
      output = formatOutput('', finalUrl, body, note)
    } else {
      return { output: `Unsupported content type: ${contentType || 'unknown'}`, isError: true }
    }

    output = truncate(output)
    // 跨过主机就不写缓存。这**不是**安全必需项 —— 入口闸今天就是宽的（点「仅此一次」的
    // 结果照样进缓存，15 分钟内第二次不再弹）。这里选更保守的一边，理由是重定向链的目标
    // 主机是**对方站点**用 Location 选的，而入口 URL 是模型自己写的，两者可信度不同。
    // 代价：短链接一类每次真抓，多一次网络往返。入口闸那条已知、本次不改。
    if (!crossedHost) cache.set(cacheKey, output)
    return { output, isError: false }
  },
}

export const toolModule = { make: () => WebFetchTool } satisfies import('./tool-module.js').ToolModule
