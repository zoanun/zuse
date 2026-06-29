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

/**
 * 暖场重试(结果会「变多」型)。
 *
 * 背景:textDocument/references 在 didOpen 后立刻发出时,tsserver 往往还在后台加载工程,
 * 此刻只返回**声明本身**(就在刚打开的那个文件里),漏掉别的文件里的使用;工程索引建好后
 * 再发才返回全部。与 queryWithWarmup 不同——这里冷查询结果**非空但不完整**,不能拿首个非空
 * 结果就走,故冷态(未暖场)时跑满整个退避预算,**取见过的最大结果集**(随工程加载,references
 * 只增不减)。暖场后单发即权威。abort 时返回当前最佳但**不置 warmed**(留给下次重试)。
 */
export async function queryWithWarmupGrow<T>(
  run: () => Promise<T[]>,
  state: { warmed: boolean },
  delays: number[],
  sleep: (ms: number) => Promise<void>,
  aborted: () => boolean = () => false,
): Promise<T[]> {
  let best = await run()
  // 已暖场:工程已加载,单次查询就是完整结果。
  if (state.warmed) return best
  for (const d of delays) {
    if (aborted()) return best // 中断:不置 warmed,下次再暖
    await sleep(d)
    const r = await run()
    if (r.length > best.length) best = r
  }
  state.warmed = true
  return best
}
