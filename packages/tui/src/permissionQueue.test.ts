import { describe, it, expect } from 'vitest'
import { resolveHead, type PendingPermission } from './permissionQueue.js'
import type { PermissionVerdict } from '@zuse/core'

/** 造一个队列项;resolve 记录被兑现的裁决,便于断言。 */
function entry(id: string, rule: string, log?: string[]): PendingPermission {
  return {
    id,
    req: { toolName: 'Bash', input: {}, specifier: rule, rule },
    resolve: (v: PermissionVerdict) => log?.push(`${id}:${v}`),
  }
}

describe('resolveHead', () => {
  it('空队列幂等返回空,不抛', () => {
    expect(resolveHead([], 'allow')).toEqual({ settled: [], rest: [] })
  })

  it('allow 只兑现队头,rest 顺序不变', () => {
    const q = [entry('a', 'Bash(x)'), entry('b', 'Bash(x)'), entry('c', 'Bash(y)')]
    const { settled, rest } = resolveHead(q, 'allow')
    expect(settled.map((p) => p.id)).toEqual(['a'])
    expect(rest.map((p) => p.id)).toEqual(['b', 'c'])
  })

  it('deny 只兑现队头', () => {
    const q = [entry('a', 'Bash(x)'), entry('b', 'Bash(x)')]
    const { settled, rest } = resolveHead(q, 'deny')
    expect(settled.map((p) => p.id)).toEqual(['a'])
    expect(rest.map((p) => p.id)).toEqual(['b'])
  })

  it('allow_session 清扫队列中同 rule 项(中间+队尾混排),不同 rule 不动', () => {
    const q = [
      entry('a', 'Bash(x)'),
      entry('b', 'Bash(y)'),
      entry('c', 'Bash(x)'),
      entry('d', 'Bash(z)'),
      entry('e', 'Bash(x)'),
    ]
    const { settled, rest } = resolveHead(q, 'allow_session')
    expect(settled.map((p) => p.id)).toEqual(['a', 'c', 'e']) // 保持原顺序
    expect(rest.map((p) => p.id)).toEqual(['b', 'd'])
  })

  it('allow_persist 清扫行为与 allow_session 相同', () => {
    const q = [entry('a', 'Bash(x)'), entry('b', 'Bash(x)'), entry('c', 'Bash(y)')]
    const { settled, rest } = resolveHead(q, 'allow_persist')
    expect(settled.map((p) => p.id)).toEqual(['a', 'b'])
    expect(rest.map((p) => p.id)).toEqual(['c'])
  })

  it('纯函数:不修改入参数组', () => {
    const q = [entry('a', 'Bash(x)'), entry('b', 'Bash(x)')]
    const snapshot = [...q]
    resolveHead(q, 'allow_session')
    expect(q).toEqual(snapshot)
  })

  it('不在内部调 resolve(副作用归调用方)', () => {
    const log: string[] = []
    const q = [entry('a', 'Bash(x)', log), entry('b', 'Bash(x)', log)]
    resolveHead(q, 'allow_session')
    expect(log).toEqual([]) // resolveHead 本身不触发任何 resolve
  })
})
