import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sweepDeadSnapshots, isPidAlive } from './shell-snapshot.js'

/**
 * shell 快照按 PID 命名，只在那个进程存活期间被 source。进程退出后就是垃圾，
 * 但此前从不清理 —— 实测累到 278 个 / 18MB。这里钉的是清理的判据：
 * 死进程删、活进程留、名字不认识的一概不动。
 */

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'zuse-sweep-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** 一个几乎不可能存活的 PID：探测它必然 ESRCH。 */
const DEAD_PID = 0x7ffffff0

function touch(name: string): string {
  const p = join(dir, name)
  writeFileSync(p, '# snapshot')
  return p
}

describe('sweepDeadSnapshots', () => {
  it('删掉死进程的快照，保留当前进程的', () => {
    touch(`snapshot-bash-${DEAD_PID}.sh`)
    const mine = touch(`snapshot-bash-${process.pid}.sh`)

    expect(sweepDeadSnapshots(dir)).toBe(1)
    expect(existsSync(join(dir, `snapshot-bash-${DEAD_PID}.sh`))).toBe(false)
    expect(existsSync(mine)).toBe(true)   // 自己这份正在用，绝不能删
  })

  it('认早期的无 label 命名 snapshot-<pid>.sh', () => {
    touch(`snapshot-${DEAD_PID}.sh`)
    expect(sweepDeadSnapshots(dir)).toBe(1)
    expect(readdirSync(dir)).toEqual([])
  })

  it('keep 参数保护指定文件，哪怕它的 PID 已死', () => {
    const keep = touch(`snapshot-bash-${DEAD_PID}.sh`)
    expect(sweepDeadSnapshots(dir, keep)).toBe(0)
    expect(existsSync(keep)).toBe(true)
  })

  it('不认识的文件名一概不碰', () => {
    touch('README.md')
    touch('snapshot-bash-notanumber.sh')
    touch('snapshot-fish-123.sh')          // 只认 bash/zsh 与无 label 两种
    expect(sweepDeadSnapshots(dir)).toBe(0)
    expect(readdirSync(dir).sort()).toEqual(['README.md', 'snapshot-bash-notanumber.sh', 'snapshot-fish-123.sh'])
  })

  it('目录不存在时安静返回 0，不抛', () => {
    expect(sweepDeadSnapshots(join(dir, 'nope'))).toBe(0)
  })
})

/**
 * 判据本身单独测。EPERM 分支（进程活着、只是不归我们管）在真实环境里不可移植地制造，
 * 但它正是防止「删掉别人正在 source 的快照」的安全阀 —— 不直接测的话，把
 * `code !== 'ESRCH'` 写成 `false` 这种变异能全身而退（实测过：5 条用例一条不红）。
 */
describe('isPidAlive —— 探测判据', () => {
  afterEach(() => { vi.restoreAllMocks() })

  const throwWith = (code: string) => () => {
    const e = new Error(code) as NodeJS.ErrnoException
    e.code = code
    throw e
  }

  it('ESRCH（查无此进程）→ 死', () => {
    vi.spyOn(process, 'kill').mockImplementation(throwWith('ESRCH') as never)
    expect(isPidAlive(4242)).toBe(false)
  })

  it('EPERM（进程在、不归我们管）→ 当作活着，不删它的快照', () => {
    vi.spyOn(process, 'kill').mockImplementation(throwWith('EPERM') as never)
    expect(isPidAlive(4242)).toBe(true)
  })

  it('探测成功 → 活', () => {
    vi.spyOn(process, 'kill').mockImplementation((() => true) as never)
    expect(isPidAlive(4242)).toBe(true)
  })

  it('PID 不合法（0/负数/NaN）→ 保守当作活着', () => {
    expect(isPidAlive(0)).toBe(true)
    expect(isPidAlive(-1)).toBe(true)
    expect(isPidAlive(Number.NaN)).toBe(true)
  })
})
