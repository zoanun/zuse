import type { PermissionRequest, PermissionVerdict } from '@zuse/core'

/**
 * 权限请求队列的队列项。canUseTool 每次被调用就入队一项;UI 一次只显示队头,
 * 用户裁决后经 resolveHead 出队并兑现 resolve,让对应的 gateAndRunTool 继续。
 * 取代旧的单例 resolver —— 并发 ask(同轮只读批 / 将来的并行 subagent)互不覆盖。
 */
export interface PendingPermission {
  /** 入队时生成,仅作 React key / 调试标识。 */
  id: string
  /** 含 toolName/input/specifier/rule/reason,直接喂给 PermissionDialog。 */
  req: PermissionRequest
  /** 兑现即让 agent 循环里 await 此请求的 gateAndRunTool 继续。 */
  resolve: (v: PermissionVerdict) => void
}

/**
 * 队头兑现(纯函数):返回被兑现的项与剩余队列,不修改入参、不调 resolve ——
 * 副作用(依次调用 settled[i].resolve(verdict))由调用方执行,便于单测。
 *
 * allow_session / allow_persist 时清扫队列中相同 rule 的等待项一并兑现:语义与
 * decide() 一致 —— 这些项若晚一点过权限闸,本来就会被刚加进 sessionAllow 的规则
 * 自动放行,提前兑现只是省去无意义的重复弹框。allow(仅本次)/ deny 不清扫,
 * 逐个问,保守正确。rule 按字面相等比较(buildRule 的整串),不做前缀/glob 推断。
 */
export function resolveHead(
  queue: readonly PendingPermission[],
  verdict: PermissionVerdict,
): { settled: PendingPermission[]; rest: PendingPermission[] } {
  if (queue.length === 0) return { settled: [], rest: [] }
  const head = queue[0]!
  const tail = queue.slice(1)
  if (verdict === 'allow_session' || verdict === 'allow_persist') {
    return {
      settled: [head, ...tail.filter((p) => p.req.rule === head.req.rule)],
      rest: tail.filter((p) => p.req.rule !== head.req.rule),
    }
  }
  return { settled: [head], rest: tail }
}
