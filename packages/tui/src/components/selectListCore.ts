/**
 * SelectList 的纯逻辑核心：过滤、下标夹取、滚动视口计算。
 * 抽成不依赖 React/ink 的纯函数，既能单测，也让组件壳保持轻薄
 *（与 registry.ts 把 editDistance/nearestMatch 抽出来单测同一套路）。
 */

export interface SelectListItem {
  /** 选中后回传给 onSelect 的不透明值。 */
  value: string
  /** 列表里展示的文案。 */
  label: string
  /** 过滤匹配用的文本；缺省回落到 label。中文 label 配英文 filterText 时尤为有用。 */
  filterText?: string
}

/**
 * 子序列模糊匹配：query 的字符按顺序出现在 text 中即命中（大小写不敏感）。
 * 空 query 命中一切。比连续子串更宽容——"mimo" 也能命中散落字符。
 */
export function matchesFilter(text: string, query: string): boolean {
  if (query === '') return true
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  let qi = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++
  }
  return qi === q.length
}

/** 按 query 过滤候选，保持原有顺序。匹配优先用 filterText，缺省用 label。 */
export function filterItems(items: SelectListItem[], query: string): SelectListItem[] {
  if (query === '') return items
  return items.filter((it) => matchesFilter(it.filterText ?? it.label, query))
}

/** 把下标夹到 [0, length-1]；空列表返回 0。 */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  if (index < 0) return 0
  if (index > length - 1) return length - 1
  return index
}

export interface Viewport {
  /** 可视窗口的起始下标（含）。可视项为 items.slice(offset, offset + height)。 */
  offset: number
  /** 上方还有被裁掉的项（渲染 ↑ 更多）。 */
  hasAbove: boolean
  /** 下方还有被裁掉的项（渲染 ↓ 更多）。 */
  hasBelow: boolean
}

/**
 * 计算滚动视口（边贴滚动 edge-anchored）：在上一帧 offset 的基础上，
 * 只在选中项跑出窗口时才滚动，并保证选中项始终可见——比"每次居中"更稳、不抖。
 * 纯函数，prevOffset 由组件持有 state 传入。
 */
export function computeViewport(
  prevOffset: number,
  selected: number,
  height: number,
  total: number,
): Viewport {
  if (total <= height) {
    return { offset: 0, hasAbove: false, hasBelow: false }
  }
  let offset = prevOffset
  if (selected < offset) offset = selected // 选中项在窗口上方：上滚顶到首行
  if (selected >= offset + height) offset = selected - height + 1 // 在下方：下滚压到末行
  // 夹住，避免越界（如 prevOffset 残留了过大的值）。
  offset = Math.max(0, Math.min(offset, total - height))
  return {
    offset,
    hasAbove: offset > 0,
    hasBelow: offset + height < total,
  }
}
