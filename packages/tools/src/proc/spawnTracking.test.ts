import { describe, it, expect } from 'vitest'
import { __trackedPidsForTest } from '@zuse/core'
import { spawnShellCommand } from './spawn.js'

/**
 * `spawnShellCommand` 必须把起出来的进程登记进兜底册子（回溯审计 F P2）。
 *
 * 登记点选在 spawnShellCommand 里而不是各个调用点：这是 run 服务与 Bash 工具起子进程的
 * 唯一入口，新增调用点自动就有兜底。这条测试锁的就是那个「唯一入口」的约定。
 */
describe('spawnShellCommand 的兜底登记', () => {
  it('运行中在册；退出后（exit，不是 close）注销', async () => {
    const child = spawnShellCommand(`"${process.execPath}" -e "setTimeout(()=>{},300)"`, {
      cwd: process.cwd(),
    })
    expect(child.pid).toBeGreaterThan(0)
    expect(__trackedPidsForTest()).toContain(child.pid)

    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    // 'exit' 的监听器按注册顺序跑，spawnShellCommand 里那个先注册，所以这里已经注销了。
    expect(__trackedPidsForTest()).not.toContain(child.pid)
  }, 30_000)
})
