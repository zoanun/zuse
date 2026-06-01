import { useEffect, useState } from 'react'
import { Text } from 'ink'

// Dependency-free braille spinner. Used as the assistant marker while a reply
// is still streaming, so the bullet itself "thinks" (Claude Code style).
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
