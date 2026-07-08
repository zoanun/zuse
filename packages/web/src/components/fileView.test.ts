import { describe, it, expect } from 'vitest'
import { classify } from './fileView.js'

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
