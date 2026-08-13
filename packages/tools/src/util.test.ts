import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findOnPath, killTree } from './util.js'

describe('findOnPath', () => {
  it('finds node on PATH', () => {
    // node 一定在 PATH 上（测试用 node 跑）
    const exe = process.platform === 'win32' ? 'node.exe' : 'node'
    expect(findOnPath(exe)).toBeTruthy()
  })
  it('returns undefined for a missing executable', () => {
    expect(findOnPath('definitely-not-a-real-exe-xyz.zzz')).toBeUndefined()
  })
  it.skipIf(process.platform !== 'win32')('resolves a bare name to a .cmd via PATHEXT (win32)', () => {
    // Windows 上 npm 全局命令多是 .CMD 启动器；裸名查找必须经 PATHEXT 命中扩展名，
    // 否则"命令在不在"会漏报（正是 LSP server 没装时死等 30s 而非快速失败的根因）。
    const dir = mkdtempSync(path.join(tmpdir(), 'zuse-fop-'))
    writeFileSync(path.join(dir, 'zuse-fake-tool.cmd'), '@echo off\r\n')
    const saved = process.env.PATH
    try {
      process.env.PATH = dir + path.delimiter + (saved ?? '')
      const found = findOnPath('zuse-fake-tool')
      expect(found).toBeTruthy()
      expect(found!.toLowerCase()).toBe(path.join(dir, 'zuse-fake-tool.cmd').toLowerCase())
    } finally {
      process.env.PATH = saved
    }
  })
})

describe('killTree', () => {
  it('is a no-op for undefined pid', () => {
    expect(() => killTree(undefined)).not.toThrow()
  })

  /**
   * **spawn 失败必须被咽掉，不能变成未处理的 `'error'` 事件。**
   *
   * `ChildProcess` 在 spawn 失败（PATH 里没有 taskkill、权限不足…）时，
   * **同步的 `spawn()` 不抛**，而是异步 emit 一个 `'error'`；没有监听者时 Node 直接 throw。
   * 而 `killTree` 的调用点全在定时器 / abort 回调里（`bash.ts` 的超时、`run.ts` 的 kill），
   * 那条栈上没有任何 catch，**本仓也没有 process 级 uncaughtException 兜底**
   *（`run.ts:292` 和 `http/server.ts:230` 两处注释都写着这件事）。
   *
   * 所以后果是：一次找不到 taskkill → **整个 daemon 连同所有会话一起死**。
   * 实测（scratchpad/probe-killtree.mjs）：
   * ```
   * spawn() 同步返回了，没抛 —— 所以调用点的 try/catch 白写
   * node:events:497  throw er; // Unhandled 'error' event
   * Error: spawn taskkill_does_not_exist ENOENT
   * ```
   * 后面排的那个 setTimeout 永远没跑到 —— 进程已经没了。
   *
   * POSIX 分支一直是包在 try/catch 里的，只有 Windows 分支裸奔。
   *
   * 这条测试用一个必然不存在的 pid 触发真实的 taskkill 失败路径（Windows），
   * 在 POSIX 上则触发 `process.kill` 的 ESRCH —— 两边都必须无声吞掉。
   */
  it.runIf(process.platform === 'win32')(
    'spawn 失败不许炸出去 —— 它跑在没有 catch 的定时器栈上，炸了整个 daemon 一起死',
    async () => {
      // **必须让 `spawn` 本身失败，不能只让 taskkill 退出码非 0。**
      // 拿一个不存在的 pid 是测不到这条的：那样 taskkill 会正常启动、然后报「找不到进程」，
      // 走的是 exit 路径而不是 spawn 的 ENOENT 路径 —— 而 ENOENT 才是打死进程的那条。
      // 清空 PATH 让系统找不到 taskkill，是能真实触发它的最小手段。
      const savedPath = process.env.PATH
      const savedSystemRoot = process.env.SystemRoot
      // 未处理的 'error' 会走 process 级 uncaughtException（vitest 装了自己的钩子，
      // 断言拿不到），所以这里自己挂一个来观测。
      const caught: unknown[] = []
      const onUncaught = (e: unknown): void => { caught.push(e) }
      process.on('uncaughtException', onUncaught)
      try {
        process.env.PATH = ''
        delete process.env.SystemRoot   // Windows 会从这里兜底找 System32
        expect(() => killTree(999_999)).not.toThrow()   // 同步不抛（本来就不抛，是异步事件）
        // 'error' 是**异步**事件 —— 不等这一拍，断言必然通过、什么也没测到。
        await new Promise((r) => setTimeout(r, 500))
        expect(caught).toEqual([])
      } finally {
        process.off('uncaughtException', onUncaught)
        process.env.PATH = savedPath
        if (savedSystemRoot !== undefined) process.env.SystemRoot = savedSystemRoot
      }
    },
  )
})
