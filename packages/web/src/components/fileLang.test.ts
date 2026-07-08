import { describe, it, expect } from 'vitest'
import { langExtensions } from './fileLang.js'

describe('langExtensions', () => {
  it('returns a non-empty extension array for known languages', () => {
    for (const p of ['a.ts', 'b.tsx', 'c.js', 'd.json', 'e.py', 'f.css', 'g.html', 'h.md',
                     'i.rs', 'j.go', 'k.java', 'l.cpp', 'm.php', 'n.sql', 'o.xml', 'p.yaml',
                     'run.sh', 'go.bat', 'app.properties', 'Dockerfile', 'x.toml']) {
      expect(langExtensions(p).length).toBeGreaterThan(0)
    }
  })
  it('returns [] for unknown / plain text (still editable)', () => {
    expect(langExtensions('notes.txt')).toEqual([])
    expect(langExtensions('data.unknownext')).toEqual([])
  })
})
