import { describe, expect, it, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { RunRegistry, RunLimitError } from './registry.js'
import type { RunDeps } from './run.js'
import type { RunPolicy } from './policy.js'
import type { ShellChildProcess } from '../proc/spawn.js'

afterEach(() => { vi.useRealTimers() })

const POLICY: RunPolicy = {
  wallClockMs: null, idleMs: null, killGraceMs: 50,
  onDetach: 'keep', sink: { kind: 'truncate', budget: 1000 },
}

function harness(opts: { maxConcurrent?: number; maxFinished?: number } = {}) {
  const procs: (EventEmitter & { pid: number })[] = []
  const killed: number[] = []
  let nextPid = 1000
  const deps: RunDeps = {
    spawn: () => {
      const p = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number }
      p.stdout = new EventEmitter()
      p.stderr = new EventEmitter()
      p.pid = ++nextPid
      procs.push(p)
      return p as unknown as ShellChildProcess
    },
    killTree: (pid: number) => { killed.push(pid) },
    oemLabel: null,
  }
  const reg = new RunRegistry({ deps, ...opts })
  const start = (sessionId = 's1') => reg.start({ command: 'x', cwd: 'E:/tmp', sessionId, policy: POLICY })
  return { reg, start, procs, killed, close: (i: number, code = 0) => procs[i]!.emit('close', code) }
}

describe('RunRegistry —— 注册与查找', () => {
  it('start 返回带唯一 id 的 run，get 能拿回同一个', () => {
    const { reg, start } = harness()
    const a = start(), b = start()
    expect(a.id).not.toBe(b.id)
    expect(reg.get(a.id)).toBe(a)
    expect(reg.get('nope')).toBeUndefined()
  })

  it('list 给出摘要：id / 命令 / 会话 / 状态', () => {
    const { reg, start, close } = harness()
    const a = start('s1')
    start('s2')
    close(0)
    const rows = reg.list()
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.id === a.id)!.status).toBe('exited')
    expect(rows.map((r) => r.sessionId).sort()).toEqual(['s1', 's2'])
  })
})

describe('RunRegistry —— 并发上限', () => {
  /** v4 §2 提到「永久占住一个并发额度」却没定义额度是多少，spec §7.4 补上：默认 8。 */
  it('超过上限时抛 RunLimitError（HTTP 层据此回 429）', () => {
    const { start } = harness({ maxConcurrent: 2 })
    start(); start()
    expect(() => start()).toThrow(RunLimitError)
  })

  it('已结束的 run 不占额度', () => {
    const { start, close } = harness({ maxConcurrent: 2 })
    start(); start()
    close(0)
    expect(() => start()).not.toThrow()
  })

  /**
   * **zombie 仍然占额度。** 它的语义是「信号发了、升级也发了，进程还活着」——
   * 那个进程还在占系统资源。不算额度的话，一串杀不掉的进程会被无限放行。
   */
  it('zombie 仍然占额度', () => {
    vi.useFakeTimers()
    const { reg, start } = harness({ maxConcurrent: 1 })
    const a = start()
    a.kill('killed')
    vi.advanceTimersByTime(50)   // 升级
    vi.advanceTimersByTime(50)   // 转 zombie
    expect(a.status).toBe('zombie')
    expect(() => start()).toThrow(RunLimitError)
    expect(reg.list().find((r) => r.id === a.id)!.status).toBe('zombie')  // 列表里要标出来
  })
})

describe('RunRegistry —— 逐出', () => {
  /**
   * 结束的 run **不立刻删** —— SSE 那头可能刚要接进来补历史，`GET /api/runs` 也要能
   * 显示「上一条跑完了、退出码是几」。但也不能无限留着，所以按结束顺序保留最近 N 条。
   */
  it('结束的 run 仍可 get 到（能补历史、能看退出码）', () => {
    const { reg, start, close } = harness()
    const a = start()
    close(0)
    expect(reg.get(a.id)).toBe(a)
    expect(reg.get(a.id)!.exitCode).toBe(0)
  })

  it('已结束的留存超过 maxFinished 时，丢最早结束的那个', () => {
    const { reg, start, close } = harness({ maxFinished: 2 })
    const a = start(), b = start(), c = start()
    close(0); close(1); close(2)
    expect(reg.get(a.id)).toBeUndefined()   // 最早结束的被挤掉
    expect(reg.get(b.id)).toBeTruthy()
    expect(reg.get(c.id)).toBeTruthy()
  })

  /**
   * zombie 是唯一会**同时**出现在「已结束队列」里又还活着的状态：它发过 end
   * （所以进了队列），但进程没死（所以还占资源）。淘汰时删掉它 = 那个还在跑的进程
   * 从此谁也找不到 —— 正是 run.ts 第一条规则要防的事。
   *
   * 而且遇到它必须**跳过继续找**，不能停下来：队头卡一个杀不掉的 zombie 就让淘汰
   * 彻底停摆的话，已结束队列会无限增长。这条测试同时钉住这两点。
   */
  it('zombie 排在队头也不被淘汰，且不挡住后面的淘汰', () => {
    vi.useFakeTimers()
    const { reg, start, close } = harness({ maxFinished: 1 })
    const z = start()
    z.kill('killed')
    vi.advanceTimersByTime(50); vi.advanceTimersByTime(50)   // 升级 → zombie，发过 end
    expect(z.status).toBe('zombie')
    const a = start(), b = start()
    close(1); close(2)
    expect(reg.get(z.id)).toBe(z)           // zombie 还在（进程没死，不能失联）
    expect(reg.get(a.id)).toBeUndefined()   // 淘汰照常进行，没被 zombie 挡住
    expect(reg.get(b.id)).toBeTruthy()
  })

  it('在飞的 run 永远不会被留存上限挤掉', () => {
    const { reg, start, close } = harness({ maxFinished: 1 })
    const live = start()
    const a = start(), b = start()
    close(1); close(2)
    expect(reg.get(live.id)).toBe(live)     // 还在跑，不参与淘汰
    expect(reg.get(a.id)).toBeUndefined()
    expect(reg.get(b.id)).toBeTruthy()
  })
})

describe('RunRegistry —— 清场', () => {
  it('stop(id) 发终止信号，但**不立刻删**（要等 close）', () => {
    vi.useFakeTimers()
    const { reg, start, killed } = harness()
    const a = start()
    expect(reg.stop(a.id, 'killed')).toBe(true)
    expect(killed).toHaveLength(1)
    expect(reg.get(a.id)).toBe(a)           // 还在表里，进程还没死
    expect(a.status).toBe('killing')
  })

  it('stop 一个不存在的 id → false，不抛', () => {
    const { reg } = harness()
    expect(reg.stop('nope', 'killed')).toBe(false)
  })

  /** 删掉一个会话时，它名下的 run 不该变成孤儿（spec §7.4）。 */
  it('killSession 只杀该会话的 run', () => {
    vi.useFakeTimers()
    const { reg, start, killed } = harness()
    const a = start('s1'); start('s2'); const c = start('s1')
    expect(reg.killSession('s1')).toBe(2)
    expect(killed).toHaveLength(2)
    expect(a.status).toBe('killing')
    expect(c.status).toBe('killing')
    expect(reg.list().find((r) => r.sessionId === 's2')!.status).toBe('running')
  })

  it('closeAll 杀掉全部在飞的（daemon 关停用）', () => {
    vi.useFakeTimers()
    const { reg, start, killed, close } = harness()
    start(); start()
    close(0)                                 // 已结束的不必再杀
    reg.closeAll()
    expect(killed).toHaveLength(1)
  })

  it('closeAll 之后 start 会抛 —— 关停中不该再接新活', () => {
    const { reg, start } = harness()
    reg.closeAll()
    expect(() => start()).toThrow()
  })
})
