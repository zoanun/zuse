import { openMemoryStore, type MemoryStore, type MemoryType } from '@zuse/tools'
import type { MemoryItem } from '@zuse/protocol'

export interface MemoryServiceOpts {
  /** 库路径(测试注入临时 db;缺省走 openMemoryStore 的默认 `~/.zuse/memory.db`)。 */
  dbPath?: string
  /** injectable for tests(注入 fake store / 计数 open 次数)。 */
  openStore?: typeof openMemoryStore
}

/**
 * Memory CRUD 的薄服务层(M1)。
 *
 * 持有一个**惰性打开**的 `MemoryStore`:构造时不碰磁盘(better-sqlite3 是同步阻塞,
 * 也好让 startServer 的降级路径不会在构造时炸),首次真正用到时才开库。库一旦打开就
 * 复用(单连接);`close()` 关闭并允许后续再惰性重开。
 *
 * better-sqlite3 同文件多连接安全 —— SessionManager 自动巩固时自己开/关连接,与本
 * service 的连接并存无碍(spec §3.1)。MemoryItem 的形状 = MemoryRow。
 *
 * better-sqlite3 全同步,故 store 方法同步;本 service 方法也保持同步(无谓 async)。
 */
export class MemoryService {
  private readonly dbPath?: string
  private readonly openStore: typeof openMemoryStore
  private store: MemoryStore | null = null

  constructor(opts: MemoryServiceOpts = {}) {
    this.dbPath = opts.dbPath
    this.openStore = opts.openStore ?? openMemoryStore
  }

  /** 惰性打开并复用底层 store。 */
  private getStore(): MemoryStore {
    if (!this.store) {
      this.store = this.dbPath ? this.openStore(this.dbPath) : this.openStore()
    }
    return this.store
  }

  /**
   * 列出/搜索记忆。
   * - 有 `q` → 全文检索(`store.search(q, project ?? '', limit)`,范围 = 项目 ∪ 全局)。
   * - 否则 `project` 给定 → `store.list(project)`(项目 ∪ 全局)。
   * - 都没有 → `store.all()`(全量,管理面板"全部"视图)。
   */
  list(opts: { project?: string; q?: string; limit?: number } = {}): MemoryItem[] {
    const store = this.getStore()
    if (opts.q) return store.search(opts.q, opts.project ?? '', opts.limit)
    if (opts.project !== undefined) return store.list(opts.project)
    return store.all()
  }

  /**
   * 新增一条记忆;project 缺省 `''`(全局)。
   * 不变量:`user` 型恒为全局(用户是谁与项目无关)——与 Memory 工具一致,强制 `project=''`。
   */
  create(fields: { type: MemoryType; content: string; project?: string; hook?: string }): MemoryItem {
    const project = fields.type === 'user' ? '' : fields.project ?? ''
    return this.getStore().save(fields.type, fields.content, project, fields.hook)
  }

  /**
   * 原地更新;未命中返回 null。同 create 的不变量:若把类型改成 `user`(或本就是 user 由前端带上),
   * 强制 `project=''`,不让 user 记忆挂到某个项目上。
   */
  update(
    id: number,
    fields: { type?: MemoryType; content?: string; hook?: string; project?: string },
  ): MemoryItem | null {
    const f = fields.type === 'user' ? { ...fields, project: '' } : fields
    return this.getStore().update(id, f)
  }

  /** 删除;未命中返回 false(透传 store.remove)。 */
  remove(id: number): boolean {
    return this.getStore().remove(id)
  }

  /** 关闭底层连接(若已打开);之后再用会惰性重开。 */
  close(): void {
    this.store?.close()
    this.store = null
  }
}
