import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, access, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createSnapshotStore, cwdSlug } from './snapshot.js'

const execFileP = promisify(execFile)

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  )

// 影子 git 是进程基建,这里起真 git 做集成测试(临时目录,ZUSE_SNAPSHOTS_DIR 注入)。
describe('SnapshotStore(影子 git)', () => {
  let work: string
  let snapRoot: string

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'zuse-snap-work-'))
    snapRoot = await mkdtemp(join(tmpdir(), 'zuse-snap-root-'))
    process.env.ZUSE_SNAPSHOTS_DIR = snapRoot
  })

  afterEach(async () => {
    delete process.env.ZUSE_SNAPSHOTS_DIR
    await rm(work, { recursive: true, force: true })
    await rm(snapRoot, { recursive: true, force: true })
  })

  it('ensure 在快照根下按 cwd-slug 建影子仓库,重复调用幂等', async () => {
    const store = createSnapshotStore(work)
    expect(await store.ensure()).toBe(true)
    expect(await store.ensure()).toBe(true)
    // 影子 git-dir 落在 <root>/<slug>/,有 HEAD 即已初始化。
    expect(await exists(join(snapRoot, cwdSlug(work), 'HEAD'))).toBe(true)
    // 工作区里不产生 .git(影子仓库与工作区分离)。
    expect(await exists(join(work, '.git'))).toBe(false)
  })

  it('track 产出 commit hash;内容变化产新 hash;无改动也产新 hash(--allow-empty)', async () => {
    const store = createSnapshotStore(work)
    await writeFile(join(work, 'a.txt'), 'v1')
    const a = await store.track()
    expect(a).toMatch(/^[0-9a-f]{40}$/)
    await writeFile(join(work, 'a.txt'), 'v2')
    const b = await store.track()
    expect(b).toMatch(/^[0-9a-f]{40}$/)
    expect(b).not.toBe(a)
    // 无改动:仍要产出新检查点(每回合一个的不变量),--allow-empty 兜住。
    const c = await store.track()
    expect(c).toMatch(/^[0-9a-f]{40}$/)
    expect(c).not.toBe(b)
  }, 30_000)

  it('restore 让工作区精确回到快照时刻:改的复原、删的复活、新建的删掉', async () => {
    const store = createSnapshotStore(work)
    await writeFile(join(work, 'a.txt'), 'v1')
    await writeFile(join(work, 'b.txt'), 'keep')
    const snap = await store.track()
    expect(snap).toBeTruthy()

    await writeFile(join(work, 'a.txt'), 'v2') // 改
    await unlink(join(work, 'b.txt')) // 删
    await writeFile(join(work, 'c.txt'), 'new') // 增

    await store.restore(snap!)
    expect(await readFile(join(work, 'a.txt'), 'utf8')).toBe('v1')
    expect(await readFile(join(work, 'b.txt'), 'utf8')).toBe('keep')
    expect(await exists(join(work, 'c.txt'))).toBe(false)
  }, 30_000)

  it('.gitignore 的文件不进快照:restore 不复原它、clean 不删它', async () => {
    const store = createSnapshotStore(work)
    await writeFile(join(work, '.gitignore'), 'ignored.txt\n')
    await writeFile(join(work, 'ignored.txt'), 'secret-v1')
    const snap = await store.track()

    await writeFile(join(work, 'ignored.txt'), 'secret-v2')
    await store.restore(snap!)
    // 被忽略的文件不受保护(spec 已知边界),但也绝不能被 clean 误删。
    expect(await readFile(join(work, 'ignored.txt'), 'utf8')).toBe('secret-v2')
  }, 30_000)

  it('工作区本身是 git 仓库时,影子操作不碰用户的 .git', async () => {
    await execFileP('git', ['init'], { cwd: work })
    await writeFile(join(work, 'mine.txt'), 'user file')

    const store = createSnapshotStore(work)
    const snap = await store.track()
    await writeFile(join(work, 'extra.txt'), 'x')
    await store.restore(snap!)

    // 用户仓库完好:.git 仍在且 git 命令照常工作。
    expect(await exists(join(work, '.git'))).toBe(true)
    const { stdout } = await execFileP('git', ['status', '--porcelain'], { cwd: work })
    expect(typeof stdout).toBe('string')
  }, 30_000)

  it('git 不可用时优雅降级:ensure false、track null、restore 抛错', async () => {
    const store = createSnapshotStore(work, { gitBin: 'zuse-definitely-no-such-git' })
    expect(await store.ensure()).toBe(false)
    expect(await store.track()).toBe(null)
    await expect(store.restore('0'.repeat(40))).rejects.toThrow()
  })

  it('restore 对不存在的 hash 抛错,而非静默成功', async () => {
    const store = createSnapshotStore(work)
    await writeFile(join(work, 'a.txt'), 'v1')
    await store.track()
    await expect(store.restore('deadbeef'.repeat(5))).rejects.toThrow(/不存在/)
  }, 30_000)

  it('diffStat 给出自检查点以来的改动摘要(含新建的未跟踪文件)', async () => {
    const store = createSnapshotStore(work)
    await writeFile(join(work, 'a.txt'), 'v1')
    const snap = await store.track()
    await writeFile(join(work, 'new.txt'), 'hello')
    const stat = await store.diffStat(snap!)
    expect(stat).toContain('new.txt')
  }, 30_000)
})
