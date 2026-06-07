/**
 * 流式请求的瞬时错误自动重试 —— 退避（backoff）工具集。
 *
 * 背景：Agent 循环消费 client 的 sendMessages，一旦收到 `error` 事件就会中止本回合、
 * 丢弃已暂存的一切（什么都不提交）。所以「向下游发出 error 事件」= 整个回合作废。
 * 因此重试必须发生在 client 内部、透明地、且在产出任何事件「之前」完成 ——
 * 一旦已经向下游吐过 message-start/文本，再重试就会重复内容，绝不可重试。
 *
 * 本模块只提供纯函数 + sleep 原语；重试主循环写在两个 client 的 sendMessages 里。
 * 设计刻意从简：不区分前台/后台、不做 fast-mode 回退、不做模型 fallback（对照 cc-haha 的 withRetry，
 * 那些是其更复杂架构的需求），只覆盖「开流前/首块前」的瞬时失败（429 / 5xx / 网络抖动）。
 */

/** 默认最大重试次数（不含首次尝试）。 */
export const DEFAULT_MAX_RETRIES = 5

/** 退避基数默认值（毫秒）：第 attempt 次退避 ≈ base * 2^attempt。 */
export const DEFAULT_RETRY_BASE_MS = 500

/** 退避上限默认值（毫秒）：指数增长封顶。 */
export const DEFAULT_RETRY_CAP_MS = 32_000

/**
 * 从环境变量解析最大重试次数；未设或非法时回退默认值，并钳制为 >= 0。
 * 与 stream-idle.ts 的 resolveStreamIdleMs 风格一致，供运维按环境调参。
 */
export function resolveMaxRetries(): number {
  const raw = process.env.ZUSE_MAX_RETRIES
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n)) return DEFAULT_MAX_RETRIES
  // 钳制为非负整数：负数/小数都向下取整且不低于 0。
  return Math.max(0, Math.floor(n))
}

/**
 * 从环境变量解析退避基数（毫秒）；未设或非法时回退默认值。
 * 主要给测试用，避免单测真的等 500ms*2^n —— 设小一点即可让重试集成测试快速跑完。
 */
export function resolveRetryBaseMs(): number {
  const raw = process.env.ZUSE_RETRY_BASE_MS
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETRY_BASE_MS
}

/** 读取 err 上可能存在的数字状态码（status 或 statusCode）。 */
function readStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const o = err as { status?: unknown; statusCode?: unknown }
  if (typeof o.status === 'number') return o.status
  if (typeof o.statusCode === 'number') return o.statusCode
  return undefined
}

/** 读取 err（含 err.cause 一层）上可能存在的网络错误 code（如 ECONNRESET）。 */
function readCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const o = err as { code?: unknown; cause?: unknown }
  if (typeof o.code === 'string') return o.code
  // 真实网络错误常被 SDK 包一层，原始 code 落在 cause 上，向下挖一层。
  if (typeof o.cause === 'object' && o.cause !== null) {
    const c = o.cause as { code?: unknown }
    if (typeof c.code === 'string') return c.code
  }
  return undefined
}

/** 读取 err.name（含 cause 一层），用于识别 SDK 的连接错误类名。 */
function readName(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const o = err as { name?: unknown; cause?: unknown }
  if (typeof o.name === 'string') return o.name
  if (typeof o.cause === 'object' && o.cause !== null) {
    const c = o.cause as { name?: unknown }
    if (typeof c.name === 'string') return c.name
  }
  return undefined
}

/** 可重试的网络错误 code 集合。 */
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'])

/**
 * 判断错误是否「瞬时、值得重试」。
 *
 * 可重试：HTTP 408 / 409 / 429、以及 500-599；网络抖动（上面的 code 集合）；
 *        SDK 连接错误（name 含 APIConnectionError / APIConnectionTimeoutError）。
 * 不可重试：400 / 401 / 403 / 404 / 422（请求本身有问题，重试只会再失败）；
 *          AbortError / APIUserAbortError（用户或空闲守卫主动中断，绝不能当瞬时错误重试）。
 */
export function isRetryableError(err: unknown): boolean {
  const name = readName(err)
  // 中断类错误优先排除：这是用户 Esc / 空闲超时，重试没有意义且会违背用户意图。
  if (name === 'AbortError' || name === 'APIUserAbortError') return false

  const status = readStatus(err)
  if (status !== undefined) {
    if (status === 408 || status === 409 || status === 429) return true
    if (status >= 500 && status <= 599) return true
    // 其余有明确状态码的（400/401/403/404/422 等客户端错误）一律不重试。
    return false
  }

  // 无状态码：看网络层 code。
  const code = readCode(err)
  if (code && RETRYABLE_CODES.has(code)) return true

  // SDK 抛的连接级错误（无 HTTP 状态码，但语义上是网络问题）。
  if (name && (name.includes('APIConnectionError') || name.includes('APIConnectionTimeoutError'))) {
    return true
  }

  return false
}

/**
 * 从 err.headers 解析 `retry-after`（整数秒）并换算成毫秒；无法解析时返回 null。
 * headers 既可能是普通对象（fetch Response.headers 转出的 plain object），
 * 也可能是 Headers-like（带 .get 方法），两种都兼容。
 */
export function retryAfterMs(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null
  const headers = (err as { headers?: unknown }).headers
  if (!headers || typeof headers !== 'object') return null

  let raw: unknown
  const maybeGet = (headers as { get?: unknown }).get
  if (typeof maybeGet === 'function') {
    // Headers-like：用 .get 读取（大小写不敏感由实现保证）。
    raw = (headers as { get: (k: string) => unknown }).get('retry-after')
  } else {
    // plain object：直接按键取（HTTP 头规范为小写）。
    raw = (headers as Record<string, unknown>)['retry-after']
  }

  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  const seconds = typeof raw === 'number' ? raw : parseInt(raw, 10)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return Math.round(seconds * 1000)
}

/** backoffMs 的可选项；rng 可注入以便确定性测试。 */
export interface BackoffOptions {
  /** 服务端 retry-after（毫秒）。> 0 时直接采用，覆盖指数退避。 */
  retryAfter?: number | null
  /** 退避基数（毫秒），默认取 resolveRetryBaseMs()。 */
  baseMs?: number
  /** 退避上限（毫秒），默认 DEFAULT_RETRY_CAP_MS。 */
  capMs?: number
  /** 随机数源，默认 Math.random；注入 () => 0.5 可得确定值。 */
  rng?: () => number
}

/**
 * 计算第 attempt 次（从 0 起）的退避时长（毫秒）。
 * 指数退避：base * 2^attempt，封顶 capMs，再叠加 ±25% 抖动（用 rng 生成）。
 * 若提供了正的 retryAfter（服务端 Retry-After 头），直接返回它（从简：不再叠加抖动）。
 */
export function backoffMs(attempt: number, opts?: BackoffOptions): number {
  const retryAfter = opts?.retryAfter
  // 服务端明示的 retry-after 优先：它是权威指令，直接遵从。
  if (retryAfter !== null && retryAfter !== undefined && retryAfter > 0) {
    return retryAfter
  }

  const base = opts?.baseMs ?? resolveRetryBaseMs()
  const cap = opts?.capMs ?? DEFAULT_RETRY_CAP_MS
  const rng = opts?.rng ?? Math.random

  const exp = Math.min(base * Math.pow(2, attempt), cap)
  // ±25% 抖动：rng∈[0,1) → 系数∈[0.75,1.25)，打散并发客户端的重试时刻避免惊群。
  const jitter = exp * (0.75 + rng() * 0.5)
  return Math.round(jitter)
}

/**
 * 可被中断打断的 sleep：到点 resolve；signal abort 时立即 resolve（不抛错），
 * 这样一个 pending 的退避等待不会卡住用户的 Esc —— 调用方在 sleep 返回后会自行
 * 检查 signal.aborted 并走中断分支。clear 定时器与监听，无泄漏。
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    // 退避定时器纯属等待，不应单独拖住进程退出。
    timer.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
