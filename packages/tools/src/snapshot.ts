/**
 * 影子 git 快照 —— 检查点与回滚的存储底座(Phase 12)。
 *
 * 独立 `--git-dir`(落 `~/.zuse/snapshots/<cwd-slug>/`)+ `--work-tree` 指向项目根:
 * 与用户自己的 `.git` 完全隔离(绝不碰其 index/HEAD/refs),项目不是 git 仓库也照样
 * 工作。每个用户回合开始前 track() 一次得到 commit hash;restore(hash) 让工作区精确
 * 回到该时刻 —— read-tree 重置影子 index、checkout-index 写回内容(覆盖改动/复活被删
 * 文件)、clean -fd 删掉快照之后新建的文件(.gitignore 忽略的不动,node_modules 安全)。
 *
 * 降级契约(spec D5):ensure/track 任何失败(git 缺失/超时/权限)都不抛 ——
 * 快照机制自己不能成为新故障点;restore/diffStat 失败则抛错,调用方必须把
 * 「没回滚成」明确告知用户,不能静默。
 *
 * 设计与决策见 docs/superpowers/specs/2026-06-12-zuse-checkpoint-revert-design.md。
 */
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * cwd → 单个安全目录段(盘符冒号、斜杠都归一成 -)。与自动会话的目录编码一致 ——
 * 同一 cwd 的会话与快照在各自根下用同一个 slug,排查时对得上号。
 * sessionStore(tui)从这里复用,不再各自维护一份。
 */
export function cwdSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** 影子仓库存放根(测试经 ZUSE_SNAPSHOTS_DIR 注入临时目录)。 */
function snapshotsRoot(): string {
  return process.env.ZUSE_SNAPSHOTS_DIR ?? join(homedir(), '.zuse', 'snapshots')
}

/** 单条 git 命令的硬超时:巨仓 add -A 秒级,放宽到 60s;真卡死也不能拖住进程。 */
const GIT_TIMEOUT_MS = 60_000

export interface SnapshotStore {
  /** 懒初始化影子仓库;git 不可用/初始化失败返回 false(后续 track 全部降级)。 */
  ensure(): Promise<boolean>
  /** 给当前工作区打检查点,返回 commit hash;失败返回 null(降级,绝不抛)。 */
  track(): Promise<string | null>
  /** 工作区精确回到 hash 时刻。失败抛错 —— 调用方必须把失败告知用户。 */
  restore(hash: string): Promise<void>
  /** 自 hash 以来的改动摘要(git diff --stat,含新建未跟踪文件),供回滚确认 UI。 */
  diffStat(hash: string): Promise<string>
}

export interface SnapshotStoreOptions {
  /** git 可执行文件,默认 'git'。测试注入不存在的名字以验证降级路径。 */
  gitBin?: string
}

export function createSnapshotStore(cwd: string, opts: SnapshotStoreOptions = {}): SnapshotStore {
  const gitBin = opts.gitBin ?? 'git'
  const gitDir = join(snapshotsRoot(), cwdSlug(cwd))
  let ensured: Promise<boolean> | undefined

  /** 跑一条影子 git 命令(显式 --git-dir/--work-tree,绝不落到用户仓库)。 */
  const run = (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(
        gitBin,
        ['--git-dir', gitDir, '--work-tree', cwd, ...args],
        { timeout: GIT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) reject(new Error(`git ${args[0]} 失败:${stderr.trim() || err.message}`))
          else resolve(stdout.trim())
        },
      )
    })

  const doEnsure = async (): Promise<boolean> => {
    try {
      await mkdir(gitDir, { recursive: true })
      // 已初始化则跳过;rev-parse 失败(空目录)才 init,重复 ensure 幂等。
      try {
        await run(['rev-parse', '--git-dir'])
      } catch {
        await run(['init'])
      }
      // 收紧影子仓库自身行为,屏蔽用户全局配置的干扰面:
      //   autocrlf false —— Windows 上防换行符归一造出整仓假 diff;
      //   本地身份      —— commit 必需,新机器可能没有全局 user.name/email;
      //   gpgsign false —— 用户全局开了签名会卡在 gpg 弹窗上;
      //   gc.auto 0     —— 回合中途绝不能被 auto-gc 拖慢。
      await run(['config', 'core.autocrlf', 'false'])
      await run(['config', 'user.name', 'zuse-snapshot'])
      await run(['config', 'user.email', 'snapshot@zuse.local'])
      await run(['config', 'commit.gpgsign', 'false'])
      await run(['config', 'gc.auto', '0'])
      return true
    } catch {
      return false // git 缺失/权限问题:全程降级为「无检查点」,绝不打断对话
    }
  }

  const ensure = (): Promise<boolean> => {
    ensured ??= doEnsure()
    return ensured
  }

  return {
    ensure,

    async track(): Promise<string | null> {
      if (!(await ensure())) return null
      try {
        await run(['add', '-A'])
        // --allow-empty:无改动也打点,保住「每回合一个检查点」的不变量;
        // --no-verify:影子仓库绝不能被用户的 commit hooks 拖挂。
        await run(['commit', '-m', new Date().toISOString(), '--allow-empty', '--no-verify'])
        return await run(['rev-parse', 'HEAD'])
      } catch {
        return null
      }
    },

    async restore(hash: string): Promise<void> {
      if (!(await ensure())) {
        throw new Error('影子仓库不可用(git 缺失或初始化失败),无法回滚。')
      }
      // 先验 hash 存在,把「检查点丢了」与「回滚中途失败」区分开。
      try {
        await run(['cat-file', '-e', `${hash}^{commit}`])
      } catch {
        throw new Error(`检查点 ${hash.slice(0, 12)} 在影子仓库里不存在(可能已被清理)。`)
      }
      // 三连:重置影子 index 到快照树 → 全量写回工作区(覆盖改动/复活被删文件)
      // → 删掉快照之后新建的文件(此时它们不在 index 里 = untracked;ignored 不动)。
      await run(['read-tree', `${hash}^{tree}`])
      await run(['checkout-index', '-a', '-f'])
      await run(['clean', '-fd'])
    },

    async diffStat(hash: string): Promise<string> {
      if (!(await ensure())) throw new Error('影子仓库不可用,无法对比。')
      // 先 add -A 把当前工作区(含新建未跟踪文件)刷进影子 index,
      // 再用 --cached 对比 —— 否则 untracked 文件不会出现在 diff 里。
      await run(['add', '-A'])
      const out = await run(['diff', '--cached', '--stat', hash])
      return out || '(无改动)'
    },
  }
}
