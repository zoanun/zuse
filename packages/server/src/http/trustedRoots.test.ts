import { describe, it, expect } from 'vitest'
import { parseTrustedRootsRequest, partitionTrustedRoots } from './trustedRoots.js'

/**
 * 这两条都是**实测**出来的，不是读代码推的（独立评审对着在跑的 daemon 复现过）：
 *
 * 1. 撤销信任被「目录必须存在」挡住 —— 目录删掉之后那条记录再也删不掉，
 *    而同一路径日后被重建时会直接继承信任。
 * 2. `trusted` 字段只认布尔字面量 false，**其余一切都落进「授予」分支** ——
 *    发字符串 `"false"` 的结果是**授予信任**。这和读表侧刻意 fail-closed
 *    （认不出就不信任）的立场直接反着。
 */
describe('POST /api/trusted-roots 的请求体解析', () => {
  it('trusted:false → 撤销，且**不带**存在性校验', () => {
    // 撤销是安全方向。给它设门槛只会堵死唯一的补救路。
    expect(parseTrustedRootsRequest({ root: 'E:/gone', trusted: false }))
      .toEqual({ kind: 'untrust', root: 'E:/gone' })
  })

  it('省略 trusted → 授予（TrustNotice 只发 {root}，不能破）', () => {
    expect(parseTrustedRootsRequest({ root: 'E:/proj' }))
      .toEqual({ kind: 'trust', root: 'E:/proj' })
  })

  it('trusted:true → 授予', () => {
    expect(parseTrustedRootsRequest({ root: 'E:/proj', trusted: true }))
      .toEqual({ kind: 'trust', root: 'E:/proj' })
  })

  // 这一组是那个 fail-open 的洞
  for (const bad of ['false', 'true', 0, 1, null, {}, []] as const) {
    it(`trusted 是 ${JSON.stringify(bad)} → 拒绝，绝不当成授予`, () => {
      const r = parseTrustedRootsRequest({ root: 'E:/proj', trusted: bad })
      expect(r.kind).toBe('reject')
    })
  }

  for (const bad of ['', '   ', 42, null, undefined] as const) {
    it(`root 是 ${JSON.stringify(bad)} → 拒绝`, () => {
      expect(parseTrustedRootsRequest({ root: bad }).kind).toBe('reject')
    })
  }

  it('body 不是对象 → 拒绝（不是崩）', () => {
    expect(parseTrustedRootsRequest(null).kind).toBe('reject')
    expect(parseTrustedRootsRequest('nope').kind).toBe('reject')
  })

  /**
   * `resolve('')` = daemon 的 cwd。空串放过去等于「撤销 daemon 自己项目根的信任」，
   * 而那条路径上的信任在别处还有豁免逻辑 —— 症状会非常难查。
   */
  it('空 root 即使带 trusted:false 也拒绝', () => {
    expect(parseTrustedRootsRequest({ root: '  ', trusted: false }).kind).toBe('reject')
  })
})

describe('信任表里的陈旧条目', () => {
  it('目录不在的挑出来放进 missing，roots 仍是全量', () => {
    const r = partitionTrustedRoots(['E:/a', 'E:/gone', 'E:/b'], (p) => p !== 'E:/gone')
    expect(r.roots).toEqual(['E:/a', 'E:/gone', 'E:/b'])
    expect(r.missing).toEqual(['E:/gone'])
  })

  it('全都在 → missing 为空', () => {
    expect(partitionTrustedRoots(['E:/a'], () => true).missing).toEqual([])
  })

  /** roots 必须是副本：直接把内部数组透出去，调用方一改就改到了信任表本身。 */
  it('roots 是副本，不是同一个数组', () => {
    const src = ['E:/a']
    expect(partitionTrustedRoots(src, () => true).roots).not.toBe(src)
  })
})
