import { Box, Text, useInput } from 'ink'
import { useState } from 'react'
import { emptyBuffer, reduce, viewport, type TextBuffer } from './textBuffer.js'
import { keyToEvent } from './inputKeymap.js'

interface InputBoxProps {
  onSubmit: (text: string) => void
  isDisabled: boolean
}

/**
 * 输入框最多显示的文本行数。超过则内部开窗滚动（光标恒可见），不再继续增高——
 * 否则输入框会把整屏输出顶过终端高度，触发 Ink 重绘错位（上面的行会"消失"）。
 */
const MAX_INPUT_ROWS = 8

/**
 * 多行输入框：自绘的行缓冲 + 光标，替代单行的 ink-text-input。
 * 编辑逻辑全在纯模块（textBuffer / inputKeymap）里单测，本组件只做按键分发与渲染。
 * 绑定：Enter 发送、Alt+Enter 换行、方向键移动、Ctrl+A/E 行首尾、退格删除。
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
  const placeholder = isDisabled ? '等待响应…' : '输入消息…（Enter 发送，Alt+Enter 换行）'
  const isEmpty = buf.text.length === 0
  // 开窗：行数超过 MAX_INPUT_ROWS 时只渲染含光标的一段，框高恒定、不顶屏。
  const vp = viewport(buf, MAX_INPUT_ROWS)

  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
      {isEmpty ? (
        <Box>
          <Text color="cyan">❯ </Text>
          {showCursor ? <Text inverse> </Text> : <Text> </Text>}
          <Text dimColor>{placeholder}</Text>
        </Box>
      ) : (
        <>
          {vp.hiddenAbove > 0 && <Text dimColor>{`  ⋯ 上面还有 ${vp.hiddenAbove} 行`}</Text>}
          {vp.lines.map((ln, i) => (
            <Box key={i}>
              {/* 仅真正的首行（未向上滚动且是窗口第一行）用提示符,其余续行缩进对齐 */}
              <Text color="cyan">{vp.hiddenAbove === 0 && i === 0 ? '❯ ' : '  '}</Text>
              <Text>{ln.before}</Text>
              {ln.hasCursor && showCursor ? <Text inverse>{ln.cursor}</Text> : <Text>{ln.cursor}</Text>}
              <Text>{ln.after}</Text>
            </Box>
          ))}
          {vp.hiddenBelow > 0 && <Text dimColor>{`  ⋯ 下面还有 ${vp.hiddenBelow} 行`}</Text>}
        </>
      )}
    </Box>
  )
}
