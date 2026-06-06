import { tmpdir } from 'node:os'
import path from 'node:path'
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
   * 避免语言服务器进程成为孤儿。只注册一次。
   */
  private armCleanup(): void {
    if (this.cleanupArmed) return
    this.cleanupArmed = true
    const kill = (): void => {
      for (const c of this.clients.values()) void c.dispose()
    }
    process.once('exit', kill)
    process.once('SIGINT', kill)
  }

  /** 优雅关闭所有 client（会话结束时调用）。 */
  async dispose(): Promise<void> {
    const all = [...this.clients.values()]
    this.clients.clear()
    await Promise.all(all.map((c) => c.dispose()))
  }
}
