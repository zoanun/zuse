import { useEffect } from 'react'

/**
 * 「按 Esc 关掉这层浮层」。
 *
 * ## 为什么是 capture 阶段 + stopPropagation
 *
 * Composer 也处理 Escape：菜单开着时收起菜单，**回合在跑时停止回合**
 *（`Composer.tsx:593` 的 `onStop()`）。浮层开着时按 Esc，用户的意思是「关掉这个浮层」，
 * 不是「打断正在跑的任务」。
 *
 * **别把 Composer 那个说成 window 监听** —— 它是 textarea 上的 React `onKeyDown`
 *（`Composer.tsx` 里一个 `addEventListener` 都没有；这条是设计审计纠正的，我原来写错了）。
 * capture 依然是对的，但理由不同：React 18 把事件监听挂在 root 容器上，
 * **window 的 capture 阶段先于 root 容器**，所以这里能抢在 Composer 之前拿到并掐断。
 * 理由写错比不写更糟 —— 下一个人照着「window 监听」这个模型去推事件顺序会得出错误结论。
 *
 * 这个写法本仓已有先例（ImageLightbox / TextLightbox / ConfirmDialog 各写了一份），
 * 抽出来是因为 **DirPicker 和 ModelPicker 这两个 `role="dialog"` 漏了** ——
 * 打开之后按 Esc 关不掉，而如果这时正好有回合在跑，Esc 会穿透下去把回合停掉。
 * 复制粘贴的第四份、第五份必然会再漏，所以给它一个名字。
 *
 * @param enabled 浮层是否打开。false 时不挂监听 —— 关着的浮层不该抢 Esc。
 */
export function useEscapeToClose(enabled: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [enabled, onClose])
}
