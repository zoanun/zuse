import { tmpdir } from 'node:os'
import path from 'node:path'
import { killTreeSync } from '@zuse/core'
import { LspClient } from './client.js'
import type { LanguageServerConfig } from './servers.js'

/** 启动一个 client 的函数签名（默认 LspClient.start；测试可注入桩）。 */
export type ClientStarter = (
  config: LanguageServerConfig,
  cwd: string,
  dataDir: string | undefined,
  signal: AbortSignal,
) => Promise<LspClient>

/**
 * 会话级语言服务器进程池：按语言懒启动 + 复用 + 退出清理。
 * - clients：已就绪的 client，按 langId 索引。
 * - starting：正在启动中的 Promise，防止并发重复 spawn 同一语言。
 */
export class LspManager {
  /** 当前工作目录，首次调用 setCwd 时固定。 */
  private cwd: string | undefined
  /** 已就绪的 client 映射：langId → LspClient。 */
  private clients = new Map<string, LspClient>()
  /** 启动中的 Promise 映射：langId → Promise<LspClient>。 */
  private starting = new Map<string, Promise<LspClient>>()
  /** process exit/SIGINT 兜底清理是否已注册。 */
  private cleanupArmed = false

  constructor(private readonly starter: ClientStarter = LspClient.start) {}

  /**
   * 首次 run 时由工具传入 ctx.cwd；之后忽略（进程池与 cwd 绑定，不跨会话切目录）。
   */
  setCwd(cwd: string): void {
    if (this.cwd === undefined) this.cwd = cwd
  }

  /**
   * 取（或懒启动）某语言的 client。
   * 并发相同语言：只 spawn 一次，其余等同一个 Promise（去重）。
   * 已就绪：直接返回缓存 client。
   */
  async getClient(config: LanguageServerConfig, signal: AbortSignal): Promise<LspClient> {
    // 首次调用时注册进程退出兜底，保证孤儿进程被清理。
    this.armCleanup()

    const cwd = this.cwd ?? process.cwd()

    // 已就绪：直接复用。
    const existing = this.clients.get(config.id)
    if (existing !== undefined) return existing

    // 启动中：并发请求等同一个 Promise，避免重复 spawn。
    const inflight = this.starting.get(config.id)
    if (inflight !== undefined) return inflight

    // 需要为带 dataDirArg 的服务器（如 jdtls）准备独立数据目录。
    const dataDir = config.dataDirArg !== undefined
      ? path.join(tmpdir(), `zuse-lsp-${config.id}`)
      : undefined

    // 启动新 client，成功后移入 clients，失败后从 starting 删除允许重试。
    const p = this.starter(config, cwd, dataDir, signal)
      .then((c) => {
        this.clients.set(config.id, c)
        this.starting.delete(config.id)
        return c
      })
      .catch((e: unknown) => {
        this.starting.delete(config.id)
        throw e
      })

    this.starting.set(config.id, p)
    return p
  }

  /**
   * 进程退出兜底：主进程退出或收到 SIGINT 时，强制关闭所有存活 client。
   *
   * ## `exit` 与 `SIGINT` **必须走不同的路**（原来两条都调 `dispose()`，那是空操作）
   *
   * `exit` 阶段**定时器与 nextTick 都不跑**，只有 microtask 跑。实测（node v22）：
   * 在 exit handler 里排的 `setTimeout` / `process.nextTick` 一个都不执行，
   * 而 `spawnSync` 正常返回。
   *
   * 而 `LspClient.dispose()` 真正的杀进程动作是
   * `setTimeout(() => killTree(pid), KILL_DELAY)` —— **那一刀在 exit 阶段永远不会落**。
   * 回溯审计在本机实测到 3 个残留的 tsserver。
   *
   * 所以 `exit` 走**同步**杀树；`SIGINT` 那条事件循环还活着，仍走优雅 `dispose()`
   *（先发 LSP shutdown/exit 握手，给它自己退的机会）。
   *
   * 同款先例：`tmux-isolation.ts` 用的就是 `spawnSync`。
   */
  private armCleanup(): void {
    if (this.cleanupArmed) return
    this.cleanupArmed = true
    process.once('exit', () => {
      for (const c of this.clients.values()) killTreeSync(c.pid)
    })
    process.once('SIGINT', () => {
      for (const c of this.clients.values()) void c.dispose()
    })
  }

  /** 优雅关闭所有 client（会话结束时调用）。 */
  async dispose(): Promise<void> {
    const all = [...this.clients.values()]
    this.clients.clear()
    await Promise.all(all.map((c) => c.dispose()))
  }
}
