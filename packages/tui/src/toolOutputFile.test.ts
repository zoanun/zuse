import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneOldTempFiles, pruneOldTempFilesAt } from './toolOutputFile.js'

const DIR = join(tmpdir(), 'zuse')

describe('pruneOldTempFiles', () => {
  beforeEach(() => { mkdirSync(DIR, { recursive: true }) })

  it('删除超龄文件、保留未超龄文件', () => {
    const old = join(DIR, 'prunetest-old.txt')
    const fresh = join(DIR, 'prunetest-fresh.txt')
    writeFileSync(old, 'x'); writeFileSync(fresh, 'y')
    // 用真实时间级别的 now（utimesSync 在 Windows 上对遥远未来时间戳处理有限）
    const now = Date.now()
    // old 的 mtime 设到 now - 8 天;fresh 设到 now - 1 小时
    const sec = (ms: number) => ms / 1000
    utimesSync(old, sec(now - 8 * 86400_000), sec(now - 8 * 86400_000))
    utimesSync(fresh, sec(now - 3600_000), sec(now - 3600_000))
    pruneOldTempFiles(7 * 86400_000, now)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    rmSync(fresh, { force: true })
  })

  it('目录不存在不报错', () => {
    const gone = join(tmpdir(), 'zuse-nonexistent-xyz')
    expect(() => pruneOldTempFilesAt(gone, 1000, Date.now())).not.toThrow()
  })
})
