/**
 * run 的策略参数。
 *
 * v4 §1 的核心论证是「**两档的差异全部落在策略参数上，机制只有一套**」——
 * 片段档（用户点代码块的「运行」）和项目档（在项目目录里跑长命令）共用同一张注册表、
 * 同一个状态机，只是这里的字段取值不同。所以这个类型**不许长出 `kind: 'snippet' | 'project'`
 * 这种判别字段** —— 一旦有了，状态机里就会开始出现 `if (kind === …)`，两档的机制又分叉了。
 */
export interface RunPolicy {
  /** 墙钟上限；null = 不限（项目档）。片段档 300s。 */
  wallClockMs: number | null
  /**
   * 空闲上限；null = 不限（片段档有墙钟兜底，不需要）。项目档 30 分钟。
   *
   * 30 分钟不是随手写的：gradle 大工程首次构建可以十几分钟不吐一个字节，
   * 阈值小了会把正常构建杀掉（v4 §3）。
   */
  idleMs: number | null
  /** 发出终止信号后等多久升级/放弃。见 run.ts 的 kill 兑现流程。 */
  killGraceMs: number
  /** 订阅者全走光时怎么办。片段档 kill（没人看了就没必要跑），项目档 keep（可重连）。 */
  onDetach: 'kill' | 'keep'
  /**
   * 输出汇。truncate = 满了杀进程；ring = 丢最旧的、进程不动。
   * 预算是**每条流各自**的，不是两条流共享 —— 一个刷屏的 stderr 不该把 stdout 的额度吃光，
   * 那会让「进程报了个警告」表现成「看不到正常输出」。
   */
  sink: { kind: 'truncate'; budget: number } | { kind: 'ring'; bytes: number }
}

/**
 * 片段档：用户点了代码块的「运行」。
 *
 * 有墙钟、无空闲计时（墙钟已经兜住了）、没人看就杀、输出超预算就杀。
 * 300s 与 200_000 字符都是可注入的 —— 测试必须能传 200ms 那一档，
 * 否则「墙钟到点被杀」这条按字面写就是一个 5 分钟的测试（spec §7.1）。
 */
export const SNIPPET_POLICY: RunPolicy = {
  wallClockMs: 300_000,
  idleMs: null,
  killGraceMs: 3_000,
  onDetach: 'kill',
  sink: { kind: 'truncate', budget: 200_000 },
}

/**
 * 项目档：在项目目录里跑长命令（dev server、构建）。
 *
 * 无墙钟、空闲 30 分钟、断连保留可重连、环形缓冲不杀。
 *
 * **本步（步骤 2）不接线** —— 片段档用不上它。放在这里是因为 v4 §1 的论证要求
 * 两档共用一套机制；只做一档的话，状态机会按 truncate 档的形状长出来，
 * 步骤 4 接项目档时又要改。
 */
export const PROJECT_POLICY: RunPolicy = {
  wallClockMs: null,
  idleMs: 30 * 60_000,
  killGraceMs: 3_000,
  onDetach: 'keep',
  sink: { kind: 'ring', bytes: 400_000 },
}
