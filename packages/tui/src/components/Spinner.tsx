import { useEffect, useState } from 'react'
import { Text } from 'ink'

// 无依赖的盲文（braille）旋转动画。在回复还在流式输出时用作助手标记，
// 让圆点本身"在思考"（Claude Code 风格）。
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

interface SpinnerProps {
  color?: string
}

export function Spinner({ color = 'yellow' }: SpinnerProps) {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length)
    }, 80)
    return () => clearInterval(timer)
  }, [])

  return <Text color={color}>{FRAMES[frame]}</Text>
}
