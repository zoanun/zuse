import { useCallback, useEffect, useRef, useState } from 'react'

/** 双击判定窗口：两次按下间隔 ≤ 此值才算「双击」。对齐 cc-haha 的 800ms。 */
export const DOUBLE_PRESS_WINDOW_MS = 800

/**
 * 纯判定：本次按下是否与上一次构成双击（落在窗口内）。抽出来便于单测，
 * 不掺 React/定时器（与 registry.ts 把 editDistance 抽出来单测同一套路）。
 * lastPressAt 为 null（从未按过 / 已超时清除）时永远返回 false。
 */
export function isWithinDoublePressWindow(
  lastPressAt: number | null,
  now: number,
  windowMs: number = DOUBLE_PRESS_WINDOW_MS,
): boolean {
  return lastPressAt !== null && now - lastPressAt <= windowMs
}

export interface DoublePressState {
  /** 已按下一次、正等待第二次（用于显示「再按一次…」提示）。 */
  pending: boolean
  /** 登记一次按下：首按进入 pending，窗口内再按触发 onDoublePress。 */
  press: () => void
}

/**
 * 双击触发：第一次按下进入 pending（提示再按一次），窗口内再次按下触发 onDoublePress；
 * 超时未再按则自动清除 pending。用于 Ctrl+C 双击退出——单击不误退，给用户一次反悔机会。
 */
export function useDoublePress(
  onDoublePress: () => void,
  windowMs: number = DOUBLE_PRESS_WINDOW_MS,
): DoublePressState {
  const [pending, setPending] = useState(false)
  const lastPressRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // 卸载时清掉悬挂的定时器。
  useEffect(() => clearTimer, [clearTimer])

  const press = useCallback(() => {
    const now = Date.now()
    if (isWithinDoublePressWindow(lastPressRef.current, now, windowMs)) {
      clearTimer()
      lastPressRef.current = null
      setPending(false)
      onDoublePress()
      return
    }
    // 首按：进入 pending，开窗等待第二次；超时自动复位。
    lastPressRef.current = now
    setPending(true)
    clearTimer()
    timerRef.current = setTimeout(() => {
      setPending(false)
      lastPressRef.current = null
      timerRef.current = null
    }, windowMs)
  }, [onDoublePress, windowMs, clearTimer])

  return { pending, press }
}
