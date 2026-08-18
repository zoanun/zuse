/**
 * `POST /api/trusted-roots` 的请求体解析。
 *
 * ## 为什么单拎出来
 *
 * 这条路由原来把「目录必须存在」的校验写在分派 trust / untrust **之前**，
 * 于是**撤销也被这道门挡住**：目录删掉之后那条信任记录再也删不掉（产品里又没有
 * 撤销界面，手搓 curl 是唯一的路，而那条路正好被 400 堵死）。而信任表比的是
 * **路径字面量**（`trusted-roots.ts` 明确拒绝 realpath，理由是 TOCTOU），
 * 所以同一个路径日后被重建 —— 比如把另一个仓库 clone 回原来的位置 ——
 * 会直接继承那份信任。补救路被堵死，这条陈旧记录就摘不掉了。
 *
 * 拆成纯函数是为了让「存在性校验只挂在授予那条分支上」成为**结构上的**事实：
 * 调用方拿到的是一个已经分好类的 action，想给 untrust 再加一道门得先改类型。
 */
export type TrustedRootsAction =
  | { kind: 'trust'; root: string }
  | { kind: 'untrust'; root: string }
  | { kind: 'reject'; message: string }

export function parseTrustedRootsRequest(body: unknown): TrustedRootsAction {
  if (typeof body !== 'object' || body === null) {
    return { kind: 'reject', message: 'body must be an object' }
  }
  const { root, trusted } = body as { root?: unknown; trusted?: unknown }
  if (typeof root !== 'string' || root.trim() === '') {
    return { kind: 'reject', message: 'root is required' }
  }
  // **空串在上面就挡掉了**：`resolve('')` 是 daemon 的 cwd，放过去等于
  // 「撤销 daemon 自己项目根的信任」——而那条路径另有豁免逻辑，症状会极难查。

  // 三态显式判，**不给「其余一律授予」留口子**。原来写的是
  // `if (trusted === false) untrust else trust`，于是字符串 "false"、0、null
  // 全都落进授予分支 —— 实测发 `{"trusted":"false"}` 的结果是**授予信任**。
  // 读表那侧是刻意 fail-closed（认不出就不信任），写表这侧却 fail-open，
  // 同一个功能两个方向的立场反着，这种不一致迟早被人踩中。
  if (trusted === false) return { kind: 'untrust', root }
  // 字段缺省 = 授予：`TrustNotice` 只发 `{root}`，这是现有调用方，不能破。
  if (trusted === undefined || trusted === true) return { kind: 'trust', root }
  return { kind: 'reject', message: 'trusted must be a boolean' }
}

/**
 * 把信任表分成「目录还在」和「目录已经没了」两拨。
 *
 * 存在与否交给调用方注入，是为了让这段能纯测 —— 也为了不在这里再写一次
 * fs 访问。**这个信息必须给到界面**：陈旧条目是这个功能最危险的形态
 * （信任比的是路径字面量，同一路径日后被重建会直接继承信任），
 * 而用户看不见它就不会去清。
 */
export function partitionTrustedRoots(
  roots: readonly string[],
  exists: (root: string) => boolean,
): { roots: string[]; missing: string[] } {
  const missing = roots.filter((r) => !exists(r))
  return { roots: [...roots], missing }
}
