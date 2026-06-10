import { Box, Text } from 'ink'
import { useInput } from '../input/useInput.js'
import { useState } from 'react'
import type { ResolvedSettings } from '@zuse/core'
import { buildModelOptions } from '../commands/registry.js'
import { buildModelSelectItems } from './modelSelectItems.js'
import { SelectList } from './SelectList.js'

interface ModelSelectProps {
  settings: ResolvedSettings
  currentProviderId: string
  currentModel: string
  /** 回车确认：切换到目标 provider/model；persist=true 时一并写盘(--save)。 */
  onConfirm: (providerId: string, model: string, persist: boolean) => void
  /** Esc 取消。 */
  onCancel: () => void
}

/** 选项栏的开关定义。新增一个写盘外的 flag = 在这里加一条(数据驱动)，渲染与键位无需改。 */
interface ToggleDef {
  key: string
  label: string
}
const TOGGLES: ToggleDef[] = [{ key: 'save', label: '--save 写盘' }]

/**
 * /model 无参时弹出的交互式选择器。
 * 列表区：按 provider 分组(组头在上、模型在下) + 输入过滤 + 滚动视口，复用 SelectList。
 * 选项栏：底部常驻的开关区(当前仅 --save)，Tab 在两区间切焦 —— 焦点在哪区，哪区才吃键。
 * 候选清单与「当前项」由 buildModelOptions 计算(已单测)，分组由 buildModelSelectItems 派生(已单测)。
 */
export function ModelSelect({
  settings,
  currentProviderId,
  currentModel,
  onConfirm,
  onCancel,
}: ModelSelectProps) {
  const options = buildModelOptions(settings, currentProviderId, currentModel)
  const items = buildModelSelectItems(options)
  const currentIndex = options.findIndex((o) => o.isCurrent)
  const currentValue = currentIndex >= 0 ? String(currentIndex) : undefined

  // 焦点区:'list' 列表 / 'options' 选项栏。flags 持各开关状态，optionIndex 是选项栏内聚焦的开关。
  const [focusZone, setFocusZone] = useState<'list' | 'options'>('list')
  const [flags, setFlags] = useState<Record<string, boolean>>({})
  const [optionIndex, setOptionIndex] = useState(0)
  const onOptions = focusZone === 'options'

  // 选项栏的键位。Tab 永远响应(切焦)；其余键仅当焦点在选项栏时处理，
  // 列表区的方向/回车/过滤交给 SelectList(下方 isActive 门控，避免两个 useInput 抢键)。
  useInput((input, key) => {
    if (key.tab) {
      setFocusZone((z) => (z === 'list' ? 'options' : 'list'))
      return
    }
    if (!onOptions) return
    if (key.escape) {
      onCancel()
      return
    }
    if (key.leftArrow) {
      setOptionIndex((i) => Math.max(0, i - 1))
      return
    }
    if (key.rightArrow) {
      setOptionIndex((i) => Math.min(TOGGLES.length - 1, i + 1))
      return
    }
    // 空格 / 回车翻转当前聚焦的开关(选项栏里回车不确认模型，确认只发生在列表区)。
    if (input === ' ' || key.return) {
      const t = TOGGLES[optionIndex]
      if (t) setFlags((f) => ({ ...f, [t.key]: !f[t.key] }))
    }
  })

  const hint = onOptions
    ? 'Tab 回列表 · ←→ 选择 · 空格/回车 勾选 · Esc 取消'
    : '方向键移动 · 输入过滤 · 回车切换 · Tab 切到选项 · Esc 取消（● = 当前）'

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        选择模型
      </Text>
      <Text dimColor>{hint}</Text>
      <Box marginTop={1}>
        <SelectList
          items={items}
          filterable
          filterPlaceholder="输入模型名过滤…"
          currentValue={currentValue}
          isActive={!onOptions}
          onSelect={(value) => {
            const opt = options[Number(value)]
            if (opt) onConfirm(opt.providerId, opt.model, flags['save'] ?? false)
          }}
          onCancel={onCancel}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor={!onOptions}>选项 </Text>
        {TOGGLES.map((t, i) => {
          const checked = flags[t.key] ?? false
          const focused = onOptions && i === optionIndex
          return (
            <Text
              key={t.key}
              color={focused ? 'cyan' : undefined}
              bold={focused}
              dimColor={!onOptions && !checked}
            >
              {checked ? '[✓]' : '[ ]'} {t.label}
              {i < TOGGLES.length - 1 ? '   ' : ''}
            </Text>
          )
        })}
      </Box>
    </Box>
  )
}
