import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { useEscapeToClose } from './useEscapeToClose.js'

afterEach(cleanup)

/**
 * `role="dialog"` 的浮层按 Esc 必须关掉，而且**不能让 Esc 漏下去**。
 *
 * 漏下去的后果是具体的：Composer 在 window 上也听 Escape，回合在跑时它会
 * `onStop()` —— 用户本来只想关掉模型选择框，结果把正在跑的任务打断了。
 * 回溯审计发现 DirPicker / ModelPicker 两个 `role="dialog"` 都没有 Esc。
 */

function Harness({ startOpen }: { startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen)
  useEscapeToClose(open, () => setOpen(false))
  return <div data-testid="state">{open ? 'open' : 'closed'}</div>
}

describe('useEscapeToClose', () => {
  it('打开时按 Esc 关掉', () => {
    const { getByTestId } = render(<Harness startOpen />)
    expect(getByTestId('state').textContent).toBe('open')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(getByTestId('state').textContent).toBe('closed')
  })

  it('Esc 不会漏给下层的 window 监听（否则会打断正在跑的回合）', () => {
    const downstream = vi.fn()
    // 冒泡阶段的 window 监听 = Composer 那个 onStop 的等价物。
    window.addEventListener('keydown', downstream)
    try {
      render(<Harness startOpen />)
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(downstream).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', downstream)
    }
  })

  it('关着的时候不抢 Esc —— 下层照常收到', () => {
    const downstream = vi.fn()
    window.addEventListener('keydown', downstream)
    try {
      render(<Harness startOpen={false} />)
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(downstream).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', downstream)
    }
  })

  it('别的键一律放过', () => {
    const downstream = vi.fn()
    window.addEventListener('keydown', downstream)
    try {
      const { getByTestId } = render(<Harness startOpen />)
      fireEvent.keyDown(window, { key: 'Enter' })
      expect(getByTestId('state').textContent).toBe('open')
      expect(downstream).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', downstream)
    }
  })
})

/**
 * 静态守卫：**每一个 `role="dialog"` / `role="alertdialog"` 的组件都得处理 Esc。**
 *
 * 写成扫文件而不是列一份组件名单 —— 名单挡不住「以后新增第六个浮层又忘了」，
 * 而那正是这条守卫声称要防的事（本仓 styles.hoverControls.test.ts 记过同一个教训：
 * 第一版守卫按名单走，结构上不可能命中它自称的威胁）。
 */
describe('所有 role=dialog 的组件都处理了 Esc', () => {
  it('扫 components 目录，不留漏网的', async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join } = await import('node:path')
    const dir = dirname(fileURLToPath(import.meta.url))

    const offenders: string[] = []
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.tsx') || f.endsWith('.test.tsx')) continue
      const src = readFileSync(join(dir, f), 'utf8')
      if (!/role="(alert)?dialog"/.test(src)) continue
      // 认两种写法：用了这个 hook，或者自己写了 Escape 处理（先例：两个 lightbox / ConfirmDialog）。
      const handled = /useEscapeToClose/.test(src) || /['"]Escape['"]/.test(src)
      if (!handled) offenders.push(f)
    }
    expect(offenders, `这些组件有 role=dialog 却不处理 Esc：${offenders.join(', ')}`).toEqual([])
  })
})
