import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DirPicker } from './DirPicker.js'
import { navigateDirs } from '../state/manageApi.js'

vi.mock('../state/manageApi.js', () => ({ navigateDirs: vi.fn() }))
const mockNav = vi.mocked(navigateDirs)

beforeEach(() => mockNav.mockReset())

describe('DirPicker', () => {
  it('shows the cwd basename on the trigger button', () => {
    render(<DirPicker cwd="E:/ai-study/zuse" onChange={() => {}} />)
    expect(screen.getByRole('button', { name: /zuse/ })).toBeInTheDocument()
  })

  it('opens, lists subdirs + drives, and descends into a subdir', async () => {
    mockNav.mockResolvedValueOnce({ path: 'E:/ai-study/zuse', parent: 'E:/ai-study', dirs: [{ name: 'packages', path: 'E:/ai-study/zuse/packages' }], drives: ['C:\\', 'E:\\'] })
    render(<DirPicker cwd="E:/ai-study/zuse" onChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /zuse/ }))
    expect(await screen.findByText('packages')).toBeInTheDocument()
    expect(screen.getByText('C:\\')).toBeInTheDocument()

    mockNav.mockResolvedValueOnce({ path: 'E:/ai-study/zuse/packages', parent: 'E:/ai-study/zuse', dirs: [{ name: 'core', path: 'E:/ai-study/zuse/packages/core' }], drives: [] })
    fireEvent.click(screen.getByText('packages'))
    expect(await screen.findByText('core')).toBeInTheDocument()
    expect(mockNav).toHaveBeenLastCalledWith('E:/ai-study/zuse/packages')
  })

  /**
   * 回溯审计：这个浮层挂着 `role="dialog"` 却没处理 Esc —— 打开后按 Esc 关不掉，
   * 而且 Esc 会穿透到 Composer 的 window 级监听，把**正在跑的回合**停掉。
   *
   * 这条测的是「DirPicker 真的把 hook 接上了」。escapeToClose.test.tsx 里那条静态扫描
   * 只能发现「压根没写 Esc」，发现不了「import 了但没接线」—— 那种情况下
   * 文件里照样出现 useEscapeToClose 这个词。所以行为测试必须在这里补一条。
   */
  it('打开后按 Esc 关掉，且不把 Esc 漏给下层（下层 = 停止回合）', async () => {
    mockNav.mockResolvedValue({ path: '/projects/x', parent: '/projects', dirs: [], drives: [] })
    const downstream = vi.fn()
    window.addEventListener('keydown', downstream)
    try {
      render(<DirPicker cwd="/projects/x" onChange={() => {}} />)
      fireEvent.click(screen.getByRole('button', { name: /x/ }))
      await screen.findByText('/projects/x')

      fireEvent.keyDown(window, { key: 'Escape' })
      expect(screen.queryByText(/使用此目录/)).not.toBeInTheDocument()
      expect(downstream).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', downstream)
    }
  })

  it('confirm fires onChange with the current path (→ new session there)', async () => {
    const onChange = vi.fn()
    mockNav.mockResolvedValue({ path: '/projects/x', parent: '/projects', dirs: [], drives: [] })
    render(<DirPicker cwd="/projects/x" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /x/ }))
    await screen.findByText('/projects/x') // current-path header
    fireEvent.click(screen.getByText(/使用此目录/))
    expect(onChange).toHaveBeenCalledWith('/projects/x')
  })
})
