import { Box, Text } from 'ink'
import type { ResolvedSettings } from '@zuse/core'
import { buildModelOptions } from '../commands/registry.js'
import { SelectList, type SelectListItem } from './SelectList.js'

interface ModelSelectProps {
  settings: ResolvedSettings
  currentProviderId: string
  currentModel: string
  /** 回车确认：切换到目标 provider/model。 */
  onConfirm: (providerId: string, model: string) => void
  /** Esc 取消。 */
  onCancel: () => void
}

/**
 * /model 无参时弹出的交互式选择器。把 40+ 行纯文本 dump 换成键盘驱动 + 输入过滤 + 滚动视口。
 * 候选清单与「当前项」由 buildModelOptions 计算（已单测），呈现复用 SelectList。
 */
export function ModelSelect({ settings, currentProviderId, currentModel, onConfirm, onCancel }: ModelSelectProps) {
  const options = buildModelOptions(settings, currentProviderId, currentModel)
  // value 用下标：模型名理论上可能含 '/'，用下标做不透明键最稳，过滤靠 label。
  const items: SelectListItem[] = options.map((o, i) => ({
    value: String(i),
    label: `${o.providerId}/${o.model}`,
  }))
  const currentIndex = options.findIndex((o) => o.isCurrent)
  const currentValue = currentIndex >= 0 ? String(currentIndex) : undefined

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">选择模型</Text>
      <Text dimColor>方向键移动 · 输入过滤 · 回车切换 · Esc 取消（● = 当前）</Text>
      <Box marginTop={1}>
        <SelectList
          items={items}
          filterable
          filterPlaceholder="输入模型名过滤…"
          currentValue={currentValue}
          onSelect={(value) => {
            const opt = options[Number(value)]
            if (opt) onConfirm(opt.providerId, opt.model)
          }}
          onCancel={onCancel}
        />
      </Box>
    </Box>
  )
}
