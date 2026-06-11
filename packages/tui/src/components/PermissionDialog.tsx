import { Box, Text } from 'ink'
import type { PermissionRequest, PermissionVerdict } from '@zuse/core'
import { SelectList, type SelectListItem } from './SelectList.js'

interface PermissionDialogProps {
  req: PermissionRequest
  onDecision: (verdict: PermissionVerdict) => void
  /** 权限队列总长(含当前显示的队头)。>1 时标题显示 (1/N),提示后面还有排队的请求。 */
  queueLength?: number
}

// 四档裁决映射成可选列表项。value 即 PermissionVerdict，呈现层不改判定语义
// （Phase 5 permission.ts 的 decide 与四档裁决保持不变，这里只换交互形态）。
const OPTIONS: SelectListItem[] = [
  { value: 'allow', label: '允许本次' },
  { value: 'allow_session', label: '本会话总是允许' },
  { value: 'allow_persist', label: '总是允许并写入配置（写盘）' },
  { value: 'deny', label: '拒绝' },
]

/**
 * 工具调用批准对话框。CC 风格的可选列表：方向键 / j k 移动，回车选中，Esc 取消（= 拒绝）。
 * 取代旧的单键裁决（y/a/A/n）——呈现层打磨，不动权限判定逻辑。
 */
export function PermissionDialog({ req, onDecision, queueLength }: PermissionDialogProps) {
  const detail = req.specifier ? `${req.toolName}: ${req.specifier}` : req.toolName
  const title = queueLength !== undefined && queueLength > 1 ? `权限请求 (1/${queueLength})` : '权限请求'

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">{title}</Text>
      <Text>{detail}</Text>
      {req.reason && <Text color="red">⚠ 安全检查：{req.reason}</Text>}
      <Box marginTop={1}>
        <SelectList
          items={OPTIONS}
          onSelect={(value) => onDecision(value as PermissionVerdict)}
          onCancel={() => onDecision('deny')}
        />
      </Box>
    </Box>
  )
}
