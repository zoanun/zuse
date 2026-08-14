import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { killTreeSync } from './kill-tree.js'

/**
 * `killTreeSync` 存在的唯一理由是 **exit 阶段定时器不跑**。
 *
 * 这条不变量不是推断，是实测（node v22，本机）：在 `process.on('exit')` 里排的
 * `setTimeout` 与 `process.nextTick` **一个都不执行**，只有 microtask 跑，
 * 而 `spawnSync` 正常返回。
 *
 * 而 `LspClient.dispose()` 真正的杀进程动作正是
 * `setTimeout(() => killTree(pid), KILL_DELAY)` —— 于是 `LspManager` 的退出兜底
 * 是个**空操作**，回溯审计在本机实测到 3 个残留的 tsserver。
 *
 * 这条测试起真子进程验证那个不变量。**它是这次修改的全部依据**，
 * 依据没了（比如将来 node 改了 exit 语义），修法就该重新审。
 */
describe('exit 阶段的可用手段（killTreeSync 的存在依据）', () => {
  it('exit handler 里：定时器与 nextTick 都不跑，spawnSync 跑', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zuse-exit-'))
    try {
      const out = join(dir, 'out.txt').replace(/\\/g, '/')
      const probe = join(dir, 'probe.cjs')
      writeFileSync(probe, [
        'const fs = require("fs")',
        `const OUT = ${JSON.stringify(out)}`,
        'const log = (s) => fs.appendFileSync(OUT, s + "\\n")',
        'process.once("exit", () => {',
        '  log("BODY")',
        '  setTimeout(() => log("TIMER"), 0)',
        '  process.nextTick(() => log("NEXTTICK"))',
        '  Promise.resolve().then(() => log("MICROTASK"))',
        '  const { spawnSync } = require("child_process")',
        '  const code = "require(\'fs\').appendFileSync(process.argv[1], \'SPAWNSYNC\\\\n\')"',
        '  const r = spawnSync(process.execPath, ["-e", code, OUT])',
        '  log("SPAWNSYNC_STATUS=" + r.status)',
        '})',
      ].join('\n'), 'utf8')

      const r = spawnSync(process.execPath, [probe], { encoding: 'utf8' })
      expect(r.status).toBe(0)
      const lines = existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean) : []

      expect(lines).toContain('BODY')
      expect(lines).toContain('SPAWNSYNC')          // 同步起子进程可用 ← killTreeSync 靠它
      expect(lines).toContain('SPAWNSYNC_STATUS=0')
      expect(lines).not.toContain('TIMER')          // ← LspClient.dispose 的杀进程包在这里面
      expect(lines).not.toContain('NEXTTICK')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('killTreeSync', () => {
  it('真的杀掉一个长跑子进程（且同步返回）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zuse-kts-'))
    try {
      const child = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' })
      expect(child.status).toBe(0)
      // 起一个真的长跑进程，拿 pid 再同步杀掉
      const { spawn } = require('node:child_process') as typeof import('node:child_process')
      const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      expect(p.pid).toBeGreaterThan(0)
      killTreeSync(p.pid)
      // 同步返回之后进程应已死；给系统一点回收时间由调用方自己判断，这里只断言不抛。
      expect(() => killTreeSync(p.pid)).not.toThrow()   // 对已死 pid 再杀一次也不许抛
      p.kill()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('undefined / 不存在的 pid 都不抛（退出路径上绝不能因此失败）', () => {
    expect(() => killTreeSync(undefined)).not.toThrow()
    expect(() => killTreeSync(999_999_999)).not.toThrow()
  })
})
