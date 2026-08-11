import type { ReactNode } from 'react'

export type TaskStatus = 'done' | 'doing' | 'todo'

/**
 * 任务状态的视觉标记：done/todo 是重新着色的原生 checkbox，doing 是一个实心方块。
 *
 * **两个调用方共享的其实只有 doing 那个方块。** 聊天区（Markdown.tsx）只在
 * `[ ]`/`[x]` 之外的「进行中」写法上调本函数，普通勾选框走的是 remark-gfm 自己渲染的
 * checkbox（DOM 里没有 `cbx-native` 类）。原注释说 checkbox 也是共享的，是错的 ——
 * 照那句话去改这里，是影响不到聊天区的。
 */
export function taskMarker(status: TaskStatus): ReactNode {
  if (status === 'doing') return <span className="cbx doing" aria-hidden="true" />
  // `checked` 而**不是** `defaultChecked`：后者是非受控的，只在挂载那一次生效。真实事故：
  // 待办面板复用同一个 <input> 节点重渲染时，一行从「已完成」改成「未开始」，DOM 里的勾
  // 摘不掉 —— 界面显示已完成，真值是 pending，且不会自愈。受控写法让状态永远是权威。
  // readOnly 是表意用的（这个勾纯展示、不接受点击），**不是**压警告所必需 ——
  // 实测 disabled 单独就够了。别以为删掉 readOnly 会招来 React 警告而不敢动。
  return (
    <input
      type="checkbox"
      className="cbx-native"
      checked={status === 'done'}
      readOnly
      disabled
      aria-hidden="true"
    />
  )
}
