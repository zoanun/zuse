import { Box, Text } from 'ink'
import type { CommandInfo } from '../commands/types.js'

interface CommandMenuProps {
  /** 已过滤好的候选（非空时才由父组件渲染本组件）。 */
  items: CommandInfo[]
  /** 当前高亮项下标（由 InputBox 夹取到有效范围后传入）。 */
  selectedIndex: number
}

// 命令名列对齐宽度："/" + 最长命令名 terminal-setup(14) = 15，留 1 空。
const NAME_COL = 16

/**
 * `/` 命令选择菜单的纯呈现壳：列出过滤后的命令 + 高亮当前项 + 底部提示行。
 * 不含 useInput —— 导航/选中/关闭全由 InputBox 在其 useInput 里驱动（按键模型仿 cc-haha：
 * ↑↓ 导航环绕 / Tab·Enter 选中 / Esc 关闭），本组件只按 selectedIndex 渲染。
 */
export function CommandMenu({ items, selectedIndex }: CommandMenuProps) {
  return (
    <Box flexDirection="column">
      {items.map((c, i) => {
        const isCursor = i === selectedIndex
        const label = `/${c.name}`.padEnd(NAME_COL)
        return (
          <Box key={c.name}>
            <Text color={isCursor ? 'cyan' : undefined} bold={isCursor}>
              {isCursor ? '❯' : ' '} {label}
            </Text>
            <Text dimColor>{c.description}</Text>
          </Box>
        )
      })}
      <Text dimColor>↑↓ 选择 · Tab/Enter 确认 · Esc 关闭</Text>
    </Box>
  )
}
