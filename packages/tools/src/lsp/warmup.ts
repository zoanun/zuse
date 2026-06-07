/**
 * 冷启动暖场重试。
 *
 * 背景:workspace/symbol(navto)在 didOpen 种子文件后立刻发出时,tsserver 往往还在
 * 后台加载工程(尤其多包仓库要建多个 configured project),此刻 navto 返回空 —— 不是
 * 真没有,而是工程没就绪。等几秒重发即能命中(实测冷查询空、+6s 暖查询命中)。
 *
 * 策略:结果为空且「尚未暖场」时,按 delays 退避重试,直到拿到非空或耗尽预算;一旦
 * 拿到过非空就把 state.warmed 置真,之后空结果直接返回 —— 避免暖场后对「确实不存在」
 * 的符号还白白等满整个预算。state 跨多次调用由调用方(LspClient)持有。
 */
export async function queryWithWarmup<T>(
  run: () => Promise<T[]>,
  state: { warmed: boolean },
  delays: number[],
  sleep: (ms: number) => Promise<void>,
  aborted: () => boolean = () => false,
): Promise<T[]> {
  let r = await run()
  if (r.length > 0) {
    state.warmed = true
    return r
  }
  // 已暖场:空就是真的空,不再重试。
  if (state.warmed) return r
  // 冷启动:工程可能还没加载完,退避重试。
  for (const d of delays) {
    if (aborted()) return r
    await sleep(d)
    r = await run()
    if (r.length > 0) {
      state.warmed = true
      return r
    }
  }
  return r
}
