import { useEffect, useRef, type RefObject } from 'react'

/**
 * 把键盘焦点关在一个 `aria-modal="true"` 的容器里，关闭后还回原处。
 *
 * ## 为什么必须做
 *
 * `aria-modal="true"` 是对辅助技术**下的承诺**：这层之外的东西都不可达。
 * 本仓 ConfirmDialog / ManageDrawer 都写了这个属性，但没有任何焦点管理 ——
 * 弹窗开着时按 Tab 照样能跑到背后的页面上去。读屏软件按这个属性把背景当作
 * 「不存在」来播报，用户却能 Tab 到那些「不存在」的控件上，比不写这个属性更糟。
 *
 * ConfirmDialog 尤其要紧：它的确认键是**销毁性动作**（「放弃修改」）。焦点乱跑时
 * 用户很容易在看不见焦点在哪的情况下敲回车。
 *
 * ## 三件事，缺一不可
 *
 * 1. **开时把焦点移进去**，否则第一次 Tab 还是从 body 起步、直接落到背景上。
 *    移到容器本身（需要 tabIndex={-1}）而不是第一个按钮：落在「取消」上还好，
 *    落在「放弃修改」上就是把销毁性动作放在回车键底下。
 * 2. **Tab / Shift+Tab 循环**：到尾了回到头，到头了回到尾。
 * 3. **关时把焦点还回去**，还给打开它的那个元素 —— 否则焦点回到 body，
 *    键盘用户得从头 Tab 一遍才能回到原来的位置。
 *
 * 焦点集合是**每次按键时现查**的，不是开的时候缓存一份：弹窗里的按钮可能随状态
 * 增减（比如「保存中…」时禁用），缓存下来的名单会指向已经不可聚焦的元素。
 */
const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function useFocusTrap(enabled: boolean, ref: RefObject<HTMLElement | null>): void {
  // 存「开之前焦点在谁身上」。用 ref 而不是 state：改它不该触发重渲染。
  const restoreTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!enabled) return
    const el = ref.current
    if (!el) return

    restoreTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    el.focus()

    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      // **不要按 offsetParent 过滤「看不见的」元素。** 两个理由，一个比一个实在：
      //   1. `offsetParent` 对 `position: fixed` 的元素也是 null —— 而本仓的弹窗遮罩
      //      正是 fixed，按它过滤会把弹窗里所有控件都判成「不可见」，围栏直接失效。
      //   2. jsdom 不做布局，offsetParent 恒为 null，于是单测里同样全军覆没
      //      （我第一版就是这么写的，4 条用例当场红，才发现 1 这个问题）。
      // 选择器本身已经排掉了 disabled 和 tabindex="-1"，够用了。
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (items.length === 0) {
        // 没有可聚焦的子元素：焦点钉在容器上，别让 Tab 把它送出去。
        e.preventDefault()
        el.focus()
        return
      }
      const first = items[0]!
      const last = items[items.length - 1]!
      const active = document.activeElement
      // 焦点还在容器本身（刚打开）时，Tab 应该进第一个、Shift+Tab 进最后一个 ——
      // 否则第一下 Tab 会跳出容器。
      if (active === el) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
        return
      }
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }

    // capture 阶段：容器内的组件可能自己也听 Tab（比如输入框里的补全），
    // 围栏要先于它们生效，否则焦点已经出去了再拦就晚了。
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      // 还焦点。元素可能已经从 DOM 里没了（打开弹窗的按钮本身被卸载），此时不还。
      const back = restoreTo.current
      if (back && back.isConnected) back.focus()
      restoreTo.current = null
    }
  }, [enabled, ref])
}
