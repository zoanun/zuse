import { Box, Text } from 'ink'
import { useInput, usePaste } from '../input/useInput.js'
import { useState } from 'react'
import { insert, emptyBuffer, splitForRender, type TextBuffer } from './textBuffer.js'
import { foldPaste, pasteReduce, expand, toDisplay, toDisplayCursor } from './pasteFold.js'
import { keyToEvent } from './inputKeymap.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { CommandMenu } from './CommandMenu.js'
import { isCommandMenuActive, commandMenuQuery, filterCommands, wrapIndex } from './commandMenuCore.js'
import type { CommandInfo } from '../commands/types.js'
import { writeToolOutputFile } from '../toolOutputFile.js'

interface InputBoxProps {
  onSubmit: (text: string, displayText?: string, pasteFiles?: Record<number, string>) => void
  isDisabled: boolean
  /** When true, input is in steer mode — shows ⚡ prefix, submits go through onSteer. */
  isSteerMode?: boolean
  /** Called when user submits in steer mode. */
  onSteer?: (text: string) => void
  /** 全部可用命令的元信息，驱动 `/` 输入时的命令选择菜单。 */
  commands: CommandInfo[]
}

/** InputBox 内部状态:文本缓冲 + 折叠粘贴 Map + 下一个粘贴 id。 */
interface InputModel {
  buf: TextBuffer
  pastes: Map<number, string>
  nextId: number
}

/**
 * 多行输入框：自绘的行缓冲 + 光标，替代单行的 ink-text-input。
 * 编辑逻辑全在纯模块（textBuffer / inputKeymap / pasteFold）里单测，本组件只做按键分发与渲染。
 * 绑定：Enter 发送、Ctrl+Enter 换行（普通终端本就发裸 LF 即可用；VSCode 系集成终端会吃掉
 * Ctrl+Enter,需 /terminal-setup 重映射,见 inputKeymap 注释）、方向键移动、
 * Ctrl+A/E 行首尾、退格删除。
 *
 * 多行粘贴(bracketed paste)折叠成 [粘贴#N · M行 · K字符] 占位符标签渲染,提交时
 * expand() 还原为全文发模型,toDisplay() 串留作 displayText 供滚动区回显。
 *
 * 仿 Claude Code：输入框随内容自由增高、不封顶，且横向占满终端宽度。已完成的消息由 App
 * 用 Ink <Static> 打进终端滚动区，实时帧不再钉死终端高度，故输入框增高不会再触发重绘错位。
 */
export function InputBox({ onSubmit, isDisabled, isSteerMode, onSteer, commands }: InputBoxProps) {
  const [model, setModel] = useState<InputModel>({
    buf: emptyBuffer,
    pastes: new Map(),
    nextId: 1,
  })
  // 命令菜单高亮项下标；输入变化时归零（见编辑分支）。
  const [selectedIndex, setSelectedIndex] = useState(0)
  // Esc 关闭菜单时记下当时的文本：只要文本不变就保持关闭，避免按 Esc 后菜单立刻重开；
  // 用户一改动输入文本（与此值不等）菜单即恢复。
  const [dismissedText, setDismissedText] = useState<string | null>(null)

  // 菜单候选：仅在「输入是斜杠命令起始 token」时计算；过滤逻辑见 commandMenu（已单测）。
  // 命令菜单判定仍用原始 model.buf.text（哨兵占位符不影响斜杠命令识别）。
  const menuItems = !isSteerMode && isCommandMenuActive(model.buf.text)
    ? filterCommands(commands, commandMenuQuery(model.buf.text))
    : []
  // 菜单真正展开：有候选、未被 Esc 关闭、且输入框可用。
  const menuOpen = !isDisabled && menuItems.length > 0 && dismissedText !== model.buf.text
  // 高亮下标夹到有效范围（候选随输入收缩时，旧下标可能越界）。
  const cursor = menuOpen ? Math.min(selectedIndex, menuItems.length - 1) : 0

  const handleSubmit = (): void => {
    // expand 还原哨兵 span 为全文；toDisplay 产出折叠展示串用于回显
    const full = expand(model.buf.text, model.pastes).trim()
    if (!full) return

    // Steer mode: route through onSteer callback, skip normal submit logic.
    if (isSteerMode && onSteer) {
      onSteer(full)
      setModel((m) => ({ buf: emptyBuffer, pastes: new Map(), nextId: m.nextId }))
      setSelectedIndex(0)
      setDismissedText(null)
      return
    }

    if (!isDisabled) {
      let display: string | undefined
      let pasteFiles: Record<number, string> | undefined
      if (model.pastes.size > 0) {
        // 有折叠粘贴：产出折叠展示串，并把每段粘贴内容落盘为临时文件（供 OSC-8 链接）
        display = toDisplay(model.buf.text, model.pastes).trim()
        pasteFiles = {}
        for (const [id, content] of model.pastes) {
          // 落盘失败（磁盘满/权限等）返回 undefined；失败的 id 不进 pasteFiles，标签退化为纯文本
          const f = writeToolOutputFile('paste', content)
          if (f) pasteFiles[id] = f
        }
      }
      onSubmit(full, display, pasteFiles)
      // 清空输入保留 nextId，使后续粘贴 id 单调递增
      setModel((m) => ({ buf: emptyBuffer, pastes: new Map(), nextId: m.nextId }))
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
      setModel((m) => ({ ...m, buf: { text, cursor: text.length } }))
    } else {
      // 无参命令:直接执行,不带 displayText(命令无需折叠回显)
      onSubmit(`/${cmd.name}`)
      setModel((m) => ({ buf: emptyBuffer, pastes: new Map(), nextId: m.nextId }))
    }
    setSelectedIndex(0)
    setDismissedText(null)
  }

  // 订阅粘贴事件:多行→折叠占位符,单行→普通插入。isActive 在禁用时关掉。
  usePaste(
    (content) => {
      if (isDisabled || content.length === 0) return
      if (content.includes('\n')) {
        // 多行粘贴:折叠成占位符标签
        setModel((m) => foldPaste(m.buf, m.pastes, m.nextId, content))
      } else {
        // 单行粘贴:当普通文本插入
        setModel((m) => ({ ...m, buf: insert(m.buf, content) }))
      }
      // 粘贴后重置菜单态:高亮归零、取消 Esc 关闭记录
      setSelectedIndex(0)
      setDismissedText(null)
    },
    { isActive: !isDisabled },
  )

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
          setDismissedText(model.buf.text)
          return
        }
        // 落到编辑：插入/退格等照常改缓冲，并把高亮归零（候选集变了，停在旧位置无意义）。
        // 编辑走 pasteReduce:占位符感知,原子操作 span
        const ev = keyToEvent(input, key)
        setModel((m) => ({ ...m, ...pasteReduce(m.buf, m.pastes, ev) }))
        setSelectedIndex(0)
        return
      }

      const ev = keyToEvent(input, key)
      if (ev.type === 'submit') {
        handleSubmit()
        return
      }
      // 所有编辑走 pasteReduce:占位符感知地处理光标移动、退格、删除等
      setModel((m) => ({ ...m, ...pasteReduce(m.buf, m.pastes, ev) }))
      // 菜单未展开时的编辑也归零高亮：Esc 关菜单后继续输入会改变候选集，
      // 重开时应回到顶部，与 SelectList 随过滤词重置同步。
      setSelectedIndex(0)
    },
    { isActive: !isDisabled },
  )

  const showCursor = !isDisabled
  const promptChar = isSteerMode ? '⚡' : '❯'
  const placeholder = isSteerMode
    ? 'steer the model…'
    : isDisabled ? '等待响应…' : '输入消息…（Enter 发送，Ctrl+Enter 换行）'
  const isEmpty = model.buf.text.length === 0
  // 渲染用 toDisplay/toDisplayCursor 把哨兵 span 转为可见标签,再交 splitForRender 分行
  const displayText = toDisplay(model.buf.text, model.pastes)
  const displayCursor = toDisplayCursor(model.buf.text, model.buf.cursor, model.pastes)
  const renderLines = splitForRender({ text: displayText, cursor: displayCursor })

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
          <Text color={isSteerMode ? 'yellow' : 'cyan'}>{promptChar} </Text>
          {showCursor ? <Text inverse> </Text> : <Text> </Text>}
          <Text dimColor>{placeholder}</Text>
        </Box>
      ) : (
        renderLines.map((ln, i) => (
          <Box key={i}>
            {/* 仅首行用提示符,其余续行缩进对齐 */}
            <Text color={isSteerMode ? 'yellow' : 'cyan'}>{i === 0 ? `${promptChar} ` : '  '}</Text>
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
