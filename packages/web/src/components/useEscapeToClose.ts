import { useEffect } from 'react'

/**
 * 「按 Esc 关掉这层浮层」。
 *
 * ## 为什么是 capture 阶段 + stopPropagation
 *
 * Composer 在 window 上也听 Escape：菜单开着时收起菜单，回合在跑时**停止回合**
 *（`Composer.tsx` 的 `onStop()`）。浮层开着时按 Esc，用户的意思是「关掉这个浮层」，
 * 不是「打断正在跑的任务」。capture 阶段先拿到、并 stopPropagation 掐断，
 * 才能保证 Esc 只作用在最上面那一层。
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
