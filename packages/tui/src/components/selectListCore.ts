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
  /**
   * 行类型。缺省 'option'(可选项)；'header' 为分组标题：不可选、导航跳过、不参与过滤匹配，
   * 但占一行随列表滚动。仅 /model 选择器用到分组；权限框等普通列表不传 → 全是 option。
   */
  kind?: 'header' | 'option'
  /** 标为不可选:渲染灰显,回车不确认(导航仍可经过,让用户看到标签)。 */
  disabled?: boolean
  /** 行尾标签(如「额度耗尽」),仅展示用。 */
  badge?: string
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

/**
 * 分组过滤：只对 option 行做模糊过滤；某组 header 之后若无任一命中 option，连 header 一并隐藏。
 * 列表无 header(普通列表)时退化为 filterItems，行为与之完全一致。
 */
export function filterGroupedItems(items: SelectListItem[], query: string): SelectListItem[] {
  const hasHeader = items.some((it) => it.kind === 'header')
  if (!hasHeader) return filterItems(items, query)
  const kept = new Set(
    filterItems(
      items.filter((it) => it.kind !== 'header'),
      query,
    ).map((it) => it.value),
  )
  const result: SelectListItem[] = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!
    if (it.kind === 'header') {
      // 向后看到下一个 header 为止，本组内是否还有被保留的 option。
      let hasVisible = false
      for (let j = i + 1; j < items.length && items[j]!.kind !== 'header'; j++) {
        if (kept.has(items[j]!.value)) {
          hasVisible = true
          break
        }
      }
      if (hasVisible) result.push(it)
    } else if (kept.has(it.value)) {
      result.push(it)
    }
  }
  return result
}

/** 列表里第一个可选(非 header)项的下标；无可选项 / 空列表返回 0。 */
export function firstSelectableIndex(items: SelectListItem[]): number {
  for (let i = 0; i < items.length; i++) {
    if (items[i]?.kind !== 'header') return i
  }
  return 0
}

/**
 * 从 from 沿 dir(+1 向下 / -1 向上)找下一个可选(非 header)项的下标，跳过 header。
 * 该方向再无可选项时停在原地(from 自身是 header 时回退到首个可选项，保证光标永不停在 header 上)。
 */
export function nextSelectableIndex(items: SelectListItem[], from: number, dir: number): number {
  let i = from + dir
  while (i >= 0 && i < items.length) {
    if (items[i]?.kind !== 'header') return i
    i += dir
  }
  return items[from]?.kind === 'header' ? firstSelectableIndex(items) : from
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
