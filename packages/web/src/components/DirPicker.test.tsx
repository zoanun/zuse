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

  it('confirm fires onChange with the current path (→ new session there)', async () => {
    const onChange = vi.fn()
    mockNav.mockResolvedValue({ path: '/projects/x', parent: '/projects', dirs: [], drives: [] })
    render(<DirPicker cwd="/projects/x" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /x/ }))
    await screen.findByText('/projects/x') // current-path header
    fireEvent.click(screen.getByText(/Use this folder/))
    expect(onChange).toHaveBeenCalledWith('/projects/x')
  })
})
