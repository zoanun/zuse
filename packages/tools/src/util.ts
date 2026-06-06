/**
 * 工具间共用的小工具函数。集中放置以免各工具各写一份、日后措辞/语义漂移。
 */

/**
 * 把可选数值夹取为正整数：是数字且 > 0 时向下取整，否则回落到 fallback。
 * 多个工具的分页/上下文参数（head_limit、offset、before/after/context 等）共用这套夹取。
 */
export function clampPositiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && value > 0 ? Math.floor(value) : fallback
}

/** 按数量选单/复数词，避免 "1 entries" 这类拼写散落各处。 */
export function pluralize(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural
}
