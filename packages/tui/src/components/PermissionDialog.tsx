import { Box, Text, useInput } from 'ink'
import type { PermissionRequest, PermissionVerdict } from '@zuse/core'

interface PermissionDialogProps {
  req: PermissionRequest
  onDecision: (verdict: PermissionVerdict) => void
}

/**
 * 工具调用批准对话框。四个按键：
 *  y → 本次允许；a → 本会话总是允许（仅内存）；
 *  A(Shift+A) → 总是允许并写入 settings.local.json（持久）；n/Esc → 拒绝。
 */
export function PermissionDialog({ req, onDecision }: PermissionDialogProps) {
  useInput((input, key) => {
    if (key.escape || input === 'n') onDecision('deny')
    else if (input === 'y') onDecision('allow')
    else if (input === 'a') onDecision('allow_session')
    else if (input === 'A') onDecision('allow_persist') // Shift+A
  })

  const detail = req.specifier ? `${req.toolName}: ${req.specifier}` : req.toolName

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">权限请求</Text>
      <Text>{detail}</Text>
      <Text dimColor>
        [y] 允许  [a] 本会话总是  [A] 总是并写盘  [n]/Esc 拒绝
      </Text>
    </Box>
  )
}
