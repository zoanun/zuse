import { Box, Text } from 'ink'
import { useInput } from '../input/useInput.js'
import { useState } from 'react'
import { emptyBuffer, reduce, splitForRender, type TextBuffer } from './textBuffer.js'
import { keyToEvent } from './inputKeymap.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { CommandMenu } from './CommandMenu.js'
import { isCommandMenuActive, commandMenuQuery, filterCommands, wrapIndex } from './commandMenuCore.js'
import type { CommandInfo } from '../commands/types.js'

interface InputBoxProps {
  onSubmit: (text: string) => void
  isDisabled: boolean
  /** 全部可用命令的元信息，驱动 `/` 输入时的命令选择菜单。 */
  commands: CommandInfo[]
}

/**
 * 多行输入框：自绘的行缓冲 + 光标，替代单行的 ink-text-input。
 * 编辑逻辑全在纯模块（textBuffer / inputKeymap）里单测，本组件只做按键分发与渲染。
 * 绑定：Enter 发送、Ctrl+Enter 换行（普通终端本就发裸 LF 即可用；VSCode 系集成终端会吃掉
 * Ctrl+Enter,需 /terminal-setup 重映射,见 inputKeymap 注释）、方向键移动、
 * Ctrl+A/E 行首尾、退格删除。
 *
 * 仿 Claude Code：输入框随内容自由增高、不封顶，且横向占满终端宽度。已完成的消息由 App
 * 用 Ink <Static> 打进终端滚动区，实时帧不再钉死终端高度，故输入框增高不会再触发重绘错位。
 */
export function InputBox({ onSubmit, isDisabled, commands }: InputBoxProps) {
  const [buf, setBuf] = useState<TextBuffer>(emptyBuffer)
  // 命令菜单高亮项下标；输入变化时归零（见编辑分支）。
  const [selectedIndex, setSelectedIndex] = useState(0)
  // Esc 关闭菜单时记下当时的文本：只要文本不变就保持关闭，避免按 Esc 后菜单立刻重开；
  // 用户一改动输入文本（与此值不等）菜单即恢复。
  const [dismissedText, setDismissedText] = useState<string | null>(null)

  // 菜单候选：仅在「输入是斜杠命令起始 token」时计算；过滤逻辑见 commandMenu（已单测）。
  const menuItems = isCommandMenuActive(buf.text) ? filterCommands(commands, commandMenuQuery(buf.text)) : []
  // 菜单真正展开：有候选、未被 Esc 关闭、且输入框可用。
  const menuOpen = !isDisabled && menuItems.length > 0 && dismissedText !== buf.text
  // 高亮下标夹到有效范围（候选随输入收缩时，旧下标可能越界）。
  const cursor = menuOpen ? Math.min(selectedIndex, menuItems.length - 1) : 0

  const handleSubmit = (): void => {
    const text = buf.text.trim()
    if (text && !isDisabled) {
      onSubmit(text)
      setBuf(emptyBuffer)
      // 清空输入即重置菜单态：高亮归零、撤销之前的 Esc 关闭记录。否则提交后原样重打
      // 同一串斜杠文本，会因 dismissedText 仍等于该文本而被压住、菜单不弹。
      setSelectedIndex(0)
      setDismissedText(null)
    }
  }

  // 选中一条命令：无参命令直接执行（走与手输一致的提交路径）；需参数命令补全为「/名字 」等待输入。
  const acceptCommand = (cmd: CommandInfo | undefined): void => {
    // isDisabled 兜底:无参命令直接走 onSubmit,绕过了 handleSubmit 的禁用判断;此处补一道,
    // 不依赖 useInput 的 isActive 单点拦截,避免将来放开门控时菜单在流式中误提交命令。
    if (!cmd || isDisabled) return
    if (cmd.takesArgs) {
      // 补全为「/名字 」，光标置末；输入框出现空格 → 菜单自动隐藏（isCommandMenuActive=false）。
      const text = `/${cmd.name} `
      setBuf({ text, cursor: text.length })
    } else {
      onSubmit(`/${cmd.name}`)
      setBuf(emptyBuffer)
    }
    setSelectedIndex(0)
    setDismissedText(null)
  }

  // isActive 在禁用时关掉，等待响应期间不吞按键。
  useInput(
    (input, key) => {
      // 菜单展开时：方向键导航、Tab/Enter 选中、Esc 关闭（仿 cc-haha）；其余键照常编辑并重置高亮。
      if (menuOpen) {
        if (key.upArrow) {
          setSelectedIndex(wrapIndex(cursor - 1, menuItems.length))
          return
        }
        if (key.downArrow) {
          setSelectedIndex(wrapIndex(cursor + 1, menuItems.length))
          return
        }
        if (key.tab || key.return) {
          acceptCommand(menuItems[cursor])
          return
        }
        if (key.escape) {
          setDismissedText(buf.text)
          return
        }
        // 落到编辑：插入/退格等照常改缓冲，并把高亮归零（候选集变了，停在旧位置无意义）。
        const ev = keyToEvent(input, key)
        setBuf((b) => reduce(b, ev))
        setSelectedIndex(0)
        return
      }

      const ev = keyToEvent(input, key)
      if (ev.type === 'submit') {
        handleSubmit()
        return
      }
      setBuf((b) => reduce(b, ev))
      // 菜单未展开时的编辑也归零高亮：Esc 关菜单后继续输入会改变候选集，
      // 重开时应回到顶部，与 SelectList 随过滤词重置同步。
      setSelectedIndex(0)
    },
    { isActive: !isDisabled },
  )

  const showCursor = !isDisabled
  const placeholder = isDisabled ? '等待响应…' : '输入消息…（Enter 发送，Ctrl+Enter 换行）'
  const isEmpty = buf.text.length === 0
  // 渲染全部行,随内容自由增高（不再开窗封顶）。
  const renderLines = splitForRender(buf)

  // 上下两条横线代替圆角边框:横线随列宽响应式重排,缩放时不会像定宽边框那样错位。
  // 用 useTerminalSize 拿当前列宽,resize 时本组件重渲染、横线按新宽度重画。
  const { columns } = useTerminalSize()
  const rule = '─'.repeat(Math.max(1, columns))

  return (
    <Box flexDirection="column" width="100%">
      {/* 命令菜单浮在输入框上方（仿 Claude Code）：仅 `/` 起始且有候选时出现。 */}
      {menuOpen && <CommandMenu items={menuItems} selectedIndex={cursor} />}
      <Text dimColor>{rule}</Text>
      {isEmpty ? (
        <Box>
          <Text color="cyan">❯ </Text>
          {showCursor ? <Text inverse> </Text> : <Text> </Text>}
          <Text dimColor>{placeholder}</Text>
        </Box>
      ) : (
        renderLines.map((ln, i) => (
          <Box key={i}>
            {/* 仅首行用提示符,其余续行缩进对齐 */}
            <Text color="cyan">{i === 0 ? '❯ ' : '  '}</Text>
            <Text>{ln.before}</Text>
            {ln.hasCursor && showCursor ? <Text inverse>{ln.cursor}</Text> : <Text>{ln.cursor}</Text>}
            <Text>{ln.after}</Text>
          </Box>
        ))
      )}
      <Text dimColor>{rule}</Text>
    </Box>
  )
}
