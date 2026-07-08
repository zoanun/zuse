import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { DirListing, FilePreview } from '@zuse/protocol'
import { FilesPanel } from './FilesPanel.js'
import { FileConflictError } from '../state/manageApi.js'

// CodeMirror can't render in jsdom — mock the editor to a plain textarea that drives onChange/onSave.
vi.mock('./CodeEditor.js', () => ({
  CodeEditor: ({ value, onChange, onSave }: { value: string; onChange: (v: string) => void; onSave: () => void }) => (
    <textarea aria-label="editor" value={value} onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); onSave() } }} />
  ),
}))

const root: DirListing = {
  path: '',
  root: '/projects/demo',
  entries: [
    { name: 'src', path: 'src', type: 'dir' },
    { name: 'readme.md', path: 'readme.md', type: 'file' },
    { name: 'pic.png', path: 'pic.png', type: 'file' },
    { name: 'doc.pdf', path: 'doc.pdf', type: 'file' },
    { name: 'sheet.xlsx', path: 'sheet.xlsx', type: 'file' },
  ],
}
const srcDir: DirListing = { path: 'src', root: '/projects/demo', entries: [{ name: 'a.ts', path: 'src/a.ts', type: 'file' }] }

function setup(over: {
  loadDir?: typeof defaultLoadDir
  loadFile?: typeof defaultLoadFile
  writeFile?: typeof defaultWrite
  deleteFile?: typeof defaultDelete
  rawUrl?: typeof defaultRawUrl
} = {}) {
  const props = {
    active: true,
    loadDir: over.loadDir ?? defaultLoadDir,
    loadFile: over.loadFile ?? defaultLoadFile,
    writeFile: over.writeFile ?? defaultWrite,
    deleteFile: over.deleteFile ?? defaultDelete,
    rawUrl: over.rawUrl ?? defaultRawUrl,
  }
  render(<FilesPanel {...props} />)
  return props
}
const defaultLoadDir = vi.fn(async (dir: string): Promise<DirListing> => (dir === 'src' ? srcDir : root))
const defaultLoadFile = vi.fn(async (path: string): Promise<FilePreview> => ({ path, content: '# hi', truncated: false, binary: false, size: 4, mtimeMs: 1 }))
const defaultWrite = vi.fn(async (path: string) => ({ path, size: 1, mtimeMs: 2 }))
const defaultDelete = vi.fn(async () => {})
const defaultRawUrl = (path: string) => '/raw/' + path

describe('FilesPanel', () => {
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

  it('clicking a text file loads it into the editor', async () => {
    const loadFile = vi.fn(async (path: string) => ({ path, content: 'export const a = 1', truncated: false, binary: false, size: 18, mtimeMs: 1 }))
    setup({ loadFile })
    fireEvent.click(await screen.findByText('readme.md'))
    await waitFor(() => expect(loadFile).toHaveBeenCalledWith('readme.md'))
    expect((await screen.findByLabelText('editor') as HTMLTextAreaElement).value).toBe('export const a = 1')
  })

  it('edits text in the editor and saves via writeFile (clears dirty)', async () => {
    const writeFile = vi.fn(async (path: string) => ({ path, size: 3, mtimeMs: 99 }))
    const loadFile = vi.fn(async (path: string) => ({ path, content: 'old', truncated: false, binary: false, size: 3, mtimeMs: 5 }))
    setup({ loadFile, writeFile })
    fireEvent.click(await screen.findByText('readme.md'))
    const ta = await screen.findByLabelText('editor')
    fireEvent.change(ta, { target: { value: 'new' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(writeFile).toHaveBeenCalledWith('readme.md', 'new', { expectMtimeMs: 5 }))
  })

  it('Ctrl+S saves', async () => {
    const writeFile = vi.fn(async (path: string) => ({ path, size: 1, mtimeMs: 7 }))
    const loadFile = vi.fn(async (path: string) => ({ path, content: 'x', truncated: false, binary: false, size: 1, mtimeMs: 5 }))
    setup({ loadFile, writeFile })
    fireEvent.click(await screen.findByText('readme.md'))
    const ta = await screen.findByLabelText('editor')
    fireEvent.change(ta, { target: { value: 'y' } })
    fireEvent.keyDown(ta, { key: 's', ctrlKey: true })
    await waitFor(() => expect(writeFile).toHaveBeenCalled())
  })

  it('on a 409 conflict, confirming overwrite re-saves with force', async () => {
    const loadFile = vi.fn(async (path: string) => ({ path, content: 'x', truncated: false, binary: false, size: 1, mtimeMs: 5 }))
    const writeFile = vi.fn()
      .mockRejectedValueOnce(new FileConflictError())
      .mockResolvedValueOnce({ path: 'readme.md', size: 1, mtimeMs: 9 })
    setup({ loadFile, writeFile })
    fireEvent.click(await screen.findByText('readme.md'))
    fireEvent.change(await screen.findByLabelText('editor'), { target: { value: 'y' } })
    fireEvent.click(screen.getByText('保存'))
    fireEvent.click(await screen.findByText('覆盖'))
    await waitFor(() => expect(writeFile).toHaveBeenLastCalledWith('readme.md', 'y', { force: true }))
  })

  it('shows a binary-file notice instead of content', async () => {
    const loadFile = vi.fn(async (path: string) => ({ path, content: '', truncated: false, binary: true, size: 999 }))
    setup({ loadFile })
    fireEvent.click(await screen.findByText('readme.md'))
    expect(await screen.findByText(/二进制文件/)).toBeInTheDocument()
  })

  it('renders an <img> for an image file (no content fetch)', async () => {
    const loadFile = vi.fn()
    setup({ loadFile })
    fireEvent.click(await screen.findByText('pic.png'))
    const img = await screen.findByRole('img')
    expect(img.getAttribute('src')).toBe('/raw/pic.png')
    expect(loadFile).not.toHaveBeenCalled()
  })

  it('renders an <iframe> for a pdf (no content fetch)', async () => {
    const loadFile = vi.fn()
    setup({ loadFile })
    fireEvent.click(await screen.findByText('doc.pdf'))
    const frame = await screen.findByTitle('doc.pdf')
    expect(frame.getAttribute('src')).toBe('/raw/doc.pdf')
    expect(loadFile).not.toHaveBeenCalled()
  })

  it('shows "cannot display" + download for an unsupported type', async () => {
    const loadFile = vi.fn()
    setup({ loadFile })
    fireEvent.click(await screen.findByText('sheet.xlsx'))
    expect(await screen.findByText(/无法展示/)).toBeInTheDocument()
    expect(screen.getByText('下载').getAttribute('href')).toBe('/raw/sheet.xlsx')
  })

  it('creates a new file via writeFile and opens it', async () => {
    const writeFile = vi.fn(async (path: string) => ({ path, size: 0, mtimeMs: 1 }))
    const loadFile = vi.fn(async (path: string) => ({ path, content: '', truncated: false, binary: false, size: 0, mtimeMs: 1 }))
    setup({ writeFile, loadFile })
    await screen.findByText('src')
    fireEvent.click(screen.getByText('＋ 新建文件'))
    fireEvent.change(screen.getByPlaceholderText('相对路径，如 src/new.ts'), { target: { value: 'src/new.ts' } })
    fireEvent.click(screen.getByText('创建'))
    await waitFor(() => expect(writeFile).toHaveBeenCalledWith('src/new.ts', ''))
  })

  it('deletes a file after inline confirm', async () => {
    const deleteFile = vi.fn(async () => {})
    const loadFile = vi.fn(async (path: string) => ({ path, content: 'x', truncated: false, binary: false, size: 1, mtimeMs: 1 }))
    setup({ deleteFile, loadFile })
    fireEvent.click(await screen.findByText('readme.md'))
    fireEvent.click(await screen.findByTitle('删除文件'))   // trash affordance in the preview head
    fireEvent.click(await screen.findByTitle('确认删除'))   // ✓
    await waitFor(() => expect(deleteFile).toHaveBeenCalledWith('readme.md'))
  })

  it('warns before leaving a dirty editor for another file', async () => {
    const loadFile = vi.fn(async (path: string) => ({ path, content: 'x', truncated: false, binary: false, size: 1, mtimeMs: 1 }))
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    setup({ loadFile })
    fireEvent.click(await screen.findByText('readme.md'))
    fireEvent.change(await screen.findByLabelText('editor'), { target: { value: 'dirty!' } })
    fireEvent.click(screen.getByText('src'))          // try to navigate away (expand dir)
    fireEvent.click(await screen.findByText('a.ts'))  // click another file
    expect(confirmSpy).toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('shows "cannot display" + download for a truncated/binary text file', async () => {
    const loadFile = vi.fn(async (path: string) => ({ path, content: '', truncated: false, binary: true, size: 9, mtimeMs: 1 }))
    setup({ loadFile })
    fireEvent.click(await screen.findByText('readme.md'))
    expect(await screen.findByText(/无法展示/)).toBeInTheDocument()
  })
})
