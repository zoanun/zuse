import { describe, it, expect } from 'vitest'
import { classify, buildFilterTree } from './fileView.js'

describe('classify', () => {
  it('images by extension', () => {
    for (const p of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.bmp', 'g.svg', 'h.ico', 'i.avif']) {
      expect(classify(p)).toBe('image')
    }
  })
  it('pdf', () => { expect(classify('doc.PDF')).toBe('pdf') })
  it('text for code/text extensions', () => {
    for (const p of ['a.ts', 'b.js', 'c.md', 'd.json', 'e.txt', 'f.css', 'Dockerfile', 'g.py']) {
      expect(classify(p)).toBe('text')
    }
  })
  it('other for unknown binary-ish', () => {
    for (const p of ['a.xlsx', 'b.docx', 'c.zip', 'd.exe', 'e.mp4']) expect(classify(p)).toBe('other')
  })
})

describe('buildFilterTree', () => {
  it('arranges hits under their ancestor directories', () => {
    const tree = buildFilterTree([{ name: 'FilesPanel.tsx', path: 'src/components/FilesPanel.tsx', type: 'file' }])
    expect(tree).toHaveLength(1)
    const src = tree[0]!
    expect(src).toMatchObject({ name: 'src', path: 'src', type: 'dir', hit: false })
    const comp = src.children[0]!
    expect(comp).toMatchObject({ name: 'components', path: 'src/components', type: 'dir', hit: false })
    expect(comp.children[0]).toMatchObject({ name: 'FilesPanel.tsx', type: 'file', hit: true })
  })

  it('marks a matched directory as a hit and merges shared ancestors', () => {
    const tree = buildFilterTree([
      { name: 'components', path: 'src/components', type: 'dir' },
      { name: 'a.ts', path: 'src/components/a.ts', type: 'file' },
      { name: 'b.ts', path: 'src/b.ts', type: 'file' },
    ])
    expect(tree).toHaveLength(1) // one shared root: src
    const src = tree[0]!
    const comp = src.children.find((c) => c.name === 'components')!
    expect(comp.hit).toBe(true)
    expect(comp.children.map((c) => c.name)).toEqual(['a.ts'])
    expect(src.children.map((c) => c.name)).toEqual(['components', 'b.ts']) // dirs first
  })

  it('root-level file hit has no ancestors', () => {
    const tree = buildFilterTree([{ name: 'readme.md', path: 'readme.md', type: 'file' }])
    expect(tree).toEqual([{ name: 'readme.md', path: 'readme.md', type: 'file', hit: true, children: [] }])
  })
})
