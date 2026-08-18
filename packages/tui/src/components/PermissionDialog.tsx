import { Box, Text } from 'ink'
import type { PermissionRequest, PermissionVerdict } from '@zuse/core'
import { isMustConfirm } from '@zuse/core'
import { SelectList, type SelectListItem } from './SelectList.js'

/** 单个值截断到多少字符 —— 一张卡不能被一个字段刷屏。 */
const VALUE_CAP = 160

/** 剥控制字符：入参是模型输出，会被打进**终端** —— ESC/OSC 能清屏、移光标、伪造提示行。 */
function scrub(text: string): string {
  let out = ''
  for (const ch of text) {
    const c = ch.charCodeAt(0)
    out += (c < 0x20 || c === 0x7f) ? ' ' : ch
  }
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * 限定符没说的那部分。判据与 web 侧同一条：**把值等于限定符的字段丢掉**。
 * 不写「哪些工具要显示」的清单 —— 清单必然漂移，而症状是「这张卡又变盲了」，
 * 没有任何东西会提醒你。
 */
function inputPreview(input: unknown, specifier: string | null): string {
  if (input === null || typeof input !== 'object') return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const text = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)
    if (specifier !== null && text === specifier) continue
    const clean = scrub(text)
    if (clean === '') continue
    parts.push(`${k}: ${clean.length > VALUE_CAP ? clean.slice(0, VALUE_CAP) + '…' : clean}`)
  }
  return parts.join('  ·  ').slice(0, 400)
}

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
  const preview = inputPreview(req.input, req.specifier)
  // **「必须确认」档要藏掉两个「总是允许」选项。** 服务端对这一档什么都不记，
  // 点了与「允许本次」完全等价 —— 显示一个点了不算数的选项比不显示更坏。
  // TUI 这边直接判（`PermissionRequest` 里没有 mustConfirm 字段，而这是纯函数、
  // 与 `decide()` 第 3.2 步同一张表）。
  const mustConfirm = isMustConfirm(req.toolName, req.specifier, process.cwd())
  const options = mustConfirm ? OPTIONS.filter((o) => !String(o.value).startsWith('allow_')) : OPTIONS

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">{title}</Text>
      <Text>{detail}</Text>
      {/*
        **不要在这里加类别前缀。** 原来这行写死了「⚠ 安全检查：」——那时只有 Bash
        安全检查会填 reason；现在重定向判定、后台记忆整理都会填，写死前缀就会造出
        「⚠ 安全检查：后台记忆整理：新增 3 条」这种假话。框定现在由 `decide()`
        写进 reason 本身（类别只有它知道）。这里只负责显示。
      */}
      {req.reason && <Text color="yellow">{req.reason}</Text>}
      {preview !== '' && <Text dimColor>{preview}</Text>}
      {mustConfirm && <Text dimColor>这一档每次都会问 —— 它写的是以后每个会话都会读到的东西。</Text>}
      <Box marginTop={1}>
        <SelectList
          items={options}
          onSelect={(value) => onDecision(value as PermissionVerdict)}
          onCancel={() => onDecision('deny')}
        />
      </Box>
    </Box>
  )
}
