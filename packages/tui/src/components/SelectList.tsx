import { Box, Text } from 'ink'
import { useInput } from '../input/useInput.js'
import { useState } from 'react'
import {
  filterGroupedItems,
  clampIndex,
  computeViewport,
  nextSelectableIndex,
  type SelectListItem,
} from './selectListCore.js'

export type { SelectListItem } from './selectListCore.js'

interface SelectListProps {
  items: SelectListItem[]
  /** 回车选中：回传该项的 value。 */
  onSelect: (value: string) => void
  /** Esc 取消。 */
  onCancel: () => void
  /** 可视行数，超出用滚动视口。默认 8。 */
  height?: number
  /**
   * 是否允许输入字符即时模糊过滤。
   * 开启后所有可打印字符进入过滤框、方向键导航（j/k 也是过滤字符，故不再兼作导航）；
   * 关闭时 j/k 与方向键同义，忽略其它字符。
   */
  filterable?: boolean
  /** 过滤框为空时的占位提示（仅 filterable 时显示）。 */
  filterPlaceholder?: string
  /** 标记为「当前」的项 value（如当前模型）：用 ● + 绿色与光标 ❯ 区分。 */
  currentValue?: string
  /**
   * 是否响应键盘输入。默认 true。父组件有多个焦点区(如 /model 的列表 + 选项栏)时，
   * 用它在切焦时停掉本列表的 useInput，避免两个 useInput 抢同一按键。
   */
  isActive?: boolean
}

/**
 * 键盘驱动的单选列表：方向键 / 回车 / Esc，可选输入过滤 + 滚动视口。
 * 纯呈现壳——过滤、下标夹取、视口计算都在 selectList.ts 里单测（见 selectList.test.ts）。
 * 权限批准框与 /model 选择器共用此组件。
 */
export function SelectList({
  items,
  onSelect,
  onCancel,
  height = 8,
  filterable = false,
  filterPlaceholder = '输入以过滤…',
  currentValue,
  isActive = true,
}: SelectListProps) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  // 视口起始下标：随光标移动边贴滚动，存 state 以便每次移动从上一帧位置计算。
  const [offset, setOffset] = useState(0)

  const filtered = filterGroupedItems(items, query)
  const grouped = filtered.some((it) => it.kind === 'header')
  const total = filtered.length
  const rawCursor = clampIndex(selected, total)
  // 光标若落在 header 上(分组列表初始 selected=0 或过滤后位置漂移)，吸附到最近可选项，
  // 保证光标永不停在 header；普通列表无 header，cursor 即 rawCursor，行为不变。
  const cursor =
    filtered[rawCursor]?.kind === 'header' ? nextSelectableIndex(filtered, rawCursor, 1) : rawCursor
  const view = computeViewport(offset, cursor, height, total)
  const visible = filtered.slice(view.offset, view.offset + height)

  // 过滤变化后把光标与视口都归零（候选集换了，停在旧位置无意义）。
  const resetToTop = (): void => {
    setSelected(0)
    setOffset(0)
  }

  const move = (dir: number): void => {
    // 跳过 header 找下一个可选项；分组与普通列表统一走这条(普通列表无 header，等价于 ±1)。
    const next = nextSelectableIndex(filtered, cursor, dir)
    setSelected(next)
    setOffset(computeViewport(offset, next, height, total).offset)
  }

  useInput(
    (input, key) => {
      if (key.escape) {
        onCancel()
        return
      }
      if (key.return) {
        const item = filtered[cursor]
        if (item) onSelect(item.value)
        return
      }
      if (key.upArrow) {
        move(-1)
        return
      }
      if (key.downArrow) {
        move(1)
        return
      }
      if (!filterable) {
        // 非过滤模式：j/k 兼作上下，其余键忽略。
        if (input === 'k') move(-1)
        else if (input === 'j') move(1)
        return
      }
      // 过滤模式：退格删一字符，可打印字符追加到过滤框。
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1))
        resetToTop()
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setQuery((q) => q + input)
        resetToTop()
      }
    },
    { isActive },
  )

  return (
    <Box flexDirection="column">
      {filterable && (
        <Box>
          <Text dimColor>筛选 </Text>
          {query ? <Text>{query}</Text> : <Text dimColor>{filterPlaceholder}</Text>}
          <Text dimColor>▌</Text>
        </Box>
      )}

      {view.hasAbove && <Text dimColor> ↑ 更多</Text>}

      {total === 0 ? (
        <Text dimColor> （无匹配）</Text>
      ) : (
        visible.map((item, i) => {
          // 分组标题行：暗色加粗、顶格、无 ❯/● 标记，不可选。
          if (item.kind === 'header') {
            return (
              <Text key={item.value} bold dimColor>
                {item.label}
              </Text>
            )
          }
          const absIndex = view.offset + i
          const isCursor = absIndex === cursor
          const isCurrent = currentValue !== undefined && item.value === currentValue
          // ❯ 光标行；● 当前激活项（非光标时绿色标注）；其余留空对齐。
          const marker = isCursor ? '❯' : ' '
          const dot = isCurrent ? '●' : ' '
          // 分组模式下 option 行缩进 2 格，缩在组头之下；普通列表不缩进，保持原样。
          const indent = grouped ? '  ' : ''
          return (
            <Text
              key={item.value}
              color={isCursor ? 'cyan' : isCurrent ? 'green' : undefined}
              bold={isCursor}
            >
              {indent}
              {marker} {dot} {item.label}
            </Text>
          )
        })
      )}

      {view.hasBelow && <Text dimColor> ↓ 更多</Text>}
    </Box>
  )
}
