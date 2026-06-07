/**
 * 把扁平的 ModelOption[] 按 provider 分组成 SelectList 候选。
 * 与 selectListCore 一样是不依赖 React/ink 的纯函数，便于单测。
 */

import type { ModelOption } from '../commands/registry.js'
import type { SelectListItem } from './selectListCore.js'

/**
 * 按 provider 分组：每组前插一条 header 行(provider 名)，其后是该 provider 的各模型行。
 * 依赖 buildModelOptions 已按 provider 顺序展开 —— 连续同 providerId 即同一组。
 *
 * - option 的 value 用其在原数组里的下标(不透明键)，onConfirm 按它回查 ModelOption。
 * - label 只显模型名(provider 已在组头，避免重复)。
 * - filterText 用 `provider/model` 全名，这样按 provider 名也能过滤到其下模型。
 * - header 的 value 含下标，保证唯一(buildModelOptions 末尾补的「当前项」可能重复某 provider，
 *   用下标做 key 避免 React key 撞车)。
 */
export function buildModelSelectItems(options: ModelOption[]): SelectListItem[] {
  const items: SelectListItem[] = []
  let lastProvider: string | undefined
  options.forEach((o, i) => {
    if (o.providerId !== lastProvider) {
      items.push({ value: `__header__${i}`, label: o.providerId, kind: 'header' })
      lastProvider = o.providerId
    }
    items.push({ value: String(i), label: o.model, filterText: `${o.providerId}/${o.model}` })
  })
  return items
}
