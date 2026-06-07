import { Box, Text, useInput } from 'ink'
import { useState } from 'react'
import { emptyBuffer, reduce, splitForRender, type TextBuffer } from './textBuffer.js'
import { keyToEvent } from './inputKeymap.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'

interface InputBoxProps {
  onSubmit: (text: string) => void
  isDisabled: boolean
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
export function InputBox({ onSubmit, isDisabled }: InputBoxProps) {
  const [buf, setBuf] = useState<TextBuffer>(emptyBuffer)

  const handleSubmit = (): void => {
    const text = buf.text.trim()
    if (text && !isDisabled) {
      onSubmit(text)
      setBuf(emptyBuffer)
    }
  }

  // isActive 在禁用时关掉，等待响应期间不吞按键。
  useInput(
    (input, key) => {
      const ev = keyToEvent(input, key)
      if (ev.type === 'submit') {
        handleSubmit()
        return
      }
      setBuf((b) => reduce(b, ev))
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
