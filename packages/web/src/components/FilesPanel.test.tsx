import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { DirListing, FilePreview } from '@zuse/protocol'
import { FilesPanel, stripAnsi } from './FilesPanel.js'

const root: DirListing = {
  path: '',
  root: '/projects/demo',
  entries: [
    { name: 'src', path: 'src', type: 'dir' },
    { name: 'readme.md', path: 'readme.md', type: 'file' },
  ],
}
const srcDir: DirListing = { path: 'src', root: '/projects/demo', entries: [{ name: 'a.ts', path: 'src/a.ts', type: 'file' }] }

function setup(over: { loadDir?: typeof defaultLoadDir; loadFile?: typeof defaultLoadFile } = {}) {
  const props = { active: true, loadDir: over.loadDir ?? defaultLoadDir, loadFile: over.loadFile ?? defaultLoadFile }
  render(<FilesPanel {...props} />)
  return props
}
const defaultLoadDir = vi.fn(async (dir: string): Promise<DirListing> => (dir === 'src' ? srcDir : root))
const defaultLoadFile = vi.fn(async (path: string): Promise<FilePreview> => ({ path, content: '# hi', truncated: false, binary: false, size: 4 }))

describe('stripAnsi', () => {
  it('removes ANSI color/CSI escape codes, keeps the text', () => {
    expect(stripAnsi('\x1b[1m\x1b[36m RUN \x1b[39m\x1b[22mv2.1.9')).toBe(' RUN v2.1.9')
    expect(stripAnsi('plain text')).toBe('plain text')
  })
})

describe('FilesPanel', () => {
  it('strips ANSI codes from the preview body', async () => {
    const loadFile = vi.fn(async (path: string) => ({ path, content: '\x1b[32m✓\x1b[39m passed', truncated: false, binary: false, size: 9 }))
    setup({ loadFile })
    fireEvent.click(await screen.findByText('readme.md'))
    expect(await screen.findByText('✓ passed')).toBeInTheDocument()
  })

  it('loads and shows the root tree when active', async () => {
    const loadDir = vi.fn(async () => root)
    setup({ loadDir })
    await waitFor(() => expect(loadDir).toHaveBeenCalledWith(''))
    expect(await screen.findByText('src')).toBeInTheDocument()
    expect(screen.getByText('readme.md')).toBeInTheDocument()
    expect(screen.getByText('/projects/demo')).toBeInTheDocument() // root header
  })

  it('shows the project root path as a header', async () => {
    setup({ loadDir: vi.fn(async () => root) })
    expect(await screen.findByText('/projects/demo')).toBeInTheDocument()
  })

  it('lazily loads a directory the first time it is expanded', async () => {
    const loadDir = vi.fn(async (dir: string) => (dir === 'src' ? srcDir : root))
    setup({ loadDir })
    fireEvent.click(await screen.findByText('src'))
    await waitFor(() => expect(loadDir).toHaveBeenCalledWith('src'))
    expect(await screen.findByText('a.ts')).toBeInTheDocument()
  })

  it('clicking a file fetches and shows its preview', async () => {
    const loadFile = vi.fn(async (path: string) => ({ path, content: 'export const a = 1', truncated: false, binary: false, size: 18 }))
    setup({ loadFile })
    fireEvent.click(await screen.findByText('readme.md'))
    await waitFor(() => expect(loadFile).toHaveBeenCalledWith('readme.md'))
    expect(await screen.findByText('export const a = 1')).toBeInTheDocument()
  })

  it('shows a binary-file notice instead of content', async () => {
    const loadFile = vi.fn(async (path: string) => ({ path, content: '', truncated: false, binary: true, size: 999 }))
    setup({ loadFile })
    fireEvent.click(await screen.findByText('readme.md'))
    expect(await screen.findByText(/二进制文件/)).toBeInTheDocument()
  })
})
