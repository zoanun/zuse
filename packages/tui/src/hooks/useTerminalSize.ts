import { useStdout } from 'ink'
import { useEffect, useState } from 'react'

export interface TerminalSize {
  columns: number
  rows: number
}

/**
 * 订阅终端尺寸:读 stdout 的列/行,并监听 'resize' 事件在窗口拖拽时触发重渲染。
 *
 * 为什么需要它:实时帧里凡是按列宽排版的内容(输入框的横线、未来的满宽元素)若只在
 * 首帧读一次 process.stdout.columns,缩放后就会用旧宽度渲染而错位。把宽度变成响应式
 * 状态,resize 时组件重新按当前列宽出图,自然不变形。
 *
 * 注意:已写入 <Static> 滚动区的历史消息无法靠本 hook 重排(它们已冻结),那部分的稳健性
 * 靠「不用定宽边框、改用随文字重排的排版」来保证。本 hook 只服务于会重绘的实时帧。
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout()
  const [size, setSize] = useState<TerminalSize>(() => ({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  }))

  useEffect(() => {
    if (!stdout) return
    const onResize = (): void => {
      setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 })
    }
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])

  return size
}
