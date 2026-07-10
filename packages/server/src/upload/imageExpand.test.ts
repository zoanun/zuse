import { describe, it, expect } from 'vitest'
import type { Message } from '@zuse/core'
import type { UploadService } from './UploadService.js'
import { makeExpandAttachments } from './imageExpand.js'

/** Minimal fake UploadService — only readBase64 is exercised by makeExpandAttachments. */
function fakeUpload(map: Record<string, { data: string; mediaType: string }>): UploadService {
  return {
    readBase64: async (id: string) => {
      const hit = map[id]
      if (!hit) throw new Error(`no such upload: ${id}`)
      return hit
    },
  } as unknown as UploadService
}

const textMsg = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] })

describe('makeExpandAttachments (I2)', () => {
  it("expands a route:'direct' attachment into an image block prepended to content", async () => {
    const upload = fakeUpload({ a1: { data: 'BASE64DATA', mediaType: 'image/png' } })
    const expand = makeExpandAttachments(upload)
    const msg: Message = {
      ...textMsg('hello'),
      attachments: [{ id: 'a1', name: 'pic.png', mediaType: 'image/png', route: 'direct' }],
    }

    const out = await expand([msg])

    expect(out).toHaveLength(1)
    expect(out[0]!.content).toEqual([
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'BASE64DATA' } },
      { type: 'text', text: 'hello' },
    ])
  })

  it('does not mutate the original message', async () => {
    const upload = fakeUpload({ a1: { data: 'D', mediaType: 'image/png' } })
    const expand = makeExpandAttachments(upload)
    const msg: Message = {
      ...textMsg('hi'),
      attachments: [{ id: 'a1', name: 'p.png', mediaType: 'image/png', route: 'direct' }],
    }
    const beforeContent = msg.content

    await expand([msg])

    expect(msg.content).toBe(beforeContent) // same reference
    expect(msg.content).toEqual([{ type: 'text', text: 'hi' }]) // still just text
  })

  it("expands a single route:'parsed' attachment into a labeled text block prepended to content", async () => {
    const upload = fakeUpload({})
    const expand = makeExpandAttachments(upload)
    const msg: Message = {
      ...textMsg('parsed one'),
      attachments: [{ id: 'a1', name: 'p.png', mediaType: 'image/png', route: 'parsed', description: 'a red cat' }],
    }

    const out = await expand([msg])

    const content = out[0]!.content
    expect(content).toHaveLength(2)
    // Single image: a provenance header (no per-image numbering) + the description, as one text block.
    expect(content[0]!.type).toBe('text')
    const desc = (content[0] as { type: 'text'; text: string }).text
    expect(desc).toContain('本条消息附带 1 张图片')
    expect(desc).toContain('由图像解析模型转述')
    expect(desc).toContain('a red cat')
    expect(desc).not.toContain('图片 1') // single → not numbered
    expect(content[1]).toEqual({ type: 'text', text: 'parsed one' })
  })

  it('merges MULTIPLE parsed descriptions into ONE numbered text block (so the model can tell images apart)', async () => {
    const expand = makeExpandAttachments(fakeUpload({}))
    const msg: Message = {
      ...textMsg('这人穿什么颜色，第二张讲啥'),
      attachments: [
        { id: 'a1', name: 'person.jpg', mediaType: 'image/jpeg', route: 'parsed', description: '一位穿白色衬衫的男士' },
        { id: 'a2', name: 'text.png', mediaType: 'image/png', route: 'parsed', description: '一个粉色文本框' },
      ],
    }

    const out = await expand([msg])

    const content = out[0]!.content
    expect(content).toHaveLength(2) // ONE combined description block + the user text
    const desc = (content[0] as { type: 'text'; text: string }).text
    expect(desc).toContain('本条消息附带 2 张图片')
    expect(desc).toContain('▍图片 1（person.jpg）')
    expect(desc).toContain('一位穿白色衬衫的男士')
    expect(desc).toContain('▍图片 2（text.png）')
    expect(desc).toContain('一个粉色文本框')
    // ordering: image 1's label precedes image 2's
    expect(desc.indexOf('图片 1')).toBeLessThan(desc.indexOf('图片 2'))
    expect(content[1]).toEqual({ type: 'text', text: '这人穿什么颜色，第二张讲啥' })
  })

  it("skips a route:'parsed' attachment with an empty/whitespace description", async () => {
    const expand = makeExpandAttachments(fakeUpload({}))
    const empty: Message = {
      ...textMsg('q1'),
      attachments: [{ id: 'a1', name: 'p.png', mediaType: 'image/png', route: 'parsed', description: '' }],
    }
    const ws: Message = {
      ...textMsg('q2'),
      attachments: [{ id: 'a2', name: 'q.png', mediaType: 'image/png', route: 'parsed', description: '   ' }],
    }

    const out = await expand([empty, ws])

    expect(out[0]).toBe(empty) // nothing to prepend → untouched original returned
    expect(out[0]!.content).toEqual([{ type: 'text', text: 'q1' }])
    expect(out[1]).toBe(ws)
    expect(out[1]!.content).toEqual([{ type: 'text', text: 'q2' }])
  })

  it('mixed direct + parsed attachments on one message expand in order (image then description)', async () => {
    const upload = fakeUpload({ d1: { data: 'IMGDATA', mediaType: 'image/png' } })
    const expand = makeExpandAttachments(upload)
    const msg: Message = {
      ...textMsg('both'),
      attachments: [
        { id: 'd1', name: 'pic.png', mediaType: 'image/png', route: 'direct' },
        { id: 'p1', name: 'doc.png', mediaType: 'image/png', route: 'parsed', description: 'a chart' },
      ],
    }

    const out = await expand([msg])

    const content = out[0]!.content
    expect(content).toHaveLength(3) // image block, then the (single) parsed description block, then text
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'IMGDATA' } })
    expect((content[1] as { type: 'text'; text: string }).text).toContain('a chart')
    expect(content[2]).toEqual({ type: 'text', text: 'both' })
  })

  it('returns the message as-is when there are no attachments', async () => {
    const expand = makeExpandAttachments(fakeUpload({}))
    const msg = textMsg('plain')

    const out = await expand([msg])

    expect(out[0]).toBe(msg)
  })

  it('skips images that fail to read, keeping the rest and never throwing', async () => {
    const upload = fakeUpload({ good: { data: 'GOOD', mediaType: 'image/jpeg' } })
    const expand = makeExpandAttachments(upload)
    const msg: Message = {
      ...textMsg('mixed'),
      attachments: [
        { id: 'missing', name: 'x.png', mediaType: 'image/png', route: 'direct' },
        { id: 'good', name: 'y.jpg', mediaType: 'image/jpeg', route: 'direct' },
      ],
    }

    const out = await expand([msg])

    // Only the readable image expands; text still follows.
    expect(out[0]!.content).toEqual([
      { type: 'image', source: { type: 'base64', mediaType: 'image/jpeg', data: 'GOOD' } },
      { type: 'text', text: 'mixed' },
    ])
  })

  it("expands a single route:'pasted' attachment into a labeled text block (no numbering)", async () => {
    const expand = makeExpandAttachments(fakeUpload({}))
    const msg: Message = {
      ...textMsg('分析这段日志'),
      attachments: [{ id: 'p1', name: '粘贴文本 #1', mediaType: 'text/plain', route: 'pasted', text: 'ERROR foo\nERROR bar' }],
    }

    const out = await expand([msg])

    const content = out[0]!.content
    expect(content).toHaveLength(2) // one pasted-text block + the user text
    const block = (content[0] as { type: 'text'; text: string }).text
    expect(block).toContain('以下是我粘贴的 1 段文本')
    expect(block).toContain('ERROR foo\nERROR bar')
    expect(block).not.toContain('▍粘贴文本 1') // single → not numbered
    expect(block.endsWith('[粘贴内容结束]')).toBe(true) // closing fence before the user question
    expect(content[1]).toEqual({ type: 'text', text: '分析这段日志' })
  })

  it('merges MULTIPLE pasted texts into ONE numbered block, material before the question', async () => {
    const expand = makeExpandAttachments(fakeUpload({}))
    const msg: Message = {
      ...textMsg('对比这两段'),
      attachments: [
        { id: 'p1', name: '粘贴文本 #1', mediaType: 'text/plain', route: 'pasted', text: '第一段内容' },
        { id: 'p2', name: '粘贴文本 #2', mediaType: 'text/plain', route: 'pasted', text: '第二段内容' },
      ],
    }

    const out = await expand([msg])

    const content = out[0]!.content
    expect(content).toHaveLength(2) // ONE combined block + user text
    const block = (content[0] as { type: 'text'; text: string }).text
    expect(block).toContain('以下是我粘贴的 2 段文本')
    expect(block).toContain('▍粘贴文本 1')
    expect(block).toContain('第一段内容')
    expect(block).toContain('▍粘贴文本 2')
    expect(block).toContain('第二段内容')
    expect(block.indexOf('粘贴文本 1')).toBeLessThan(block.indexOf('粘贴文本 2'))
    expect(content[1]).toEqual({ type: 'text', text: '对比这两段' })
  })

  it('orders blocks image → parsed-image-desc → pasted-text → original content', async () => {
    const upload = fakeUpload({ d1: { data: 'IMG', mediaType: 'image/png' } })
    const expand = makeExpandAttachments(upload)
    const msg: Message = {
      ...textMsg('看图和文本'),
      attachments: [
        { id: 'd1', name: 'pic.png', mediaType: 'image/png', route: 'direct' },
        { id: 'p1', name: '粘贴文本 #1', mediaType: 'text/plain', route: 'pasted', text: '一段文字' },
      ],
    }

    const out = await expand([msg])

    const content = out[0]!.content
    expect(content).toHaveLength(3)
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'IMG' } })
    expect((content[1] as { type: 'text'; text: string }).text).toContain('一段文字')
    expect(content[2]).toEqual({ type: 'text', text: '看图和文本' })
  })

  it("skips a route:'pasted' attachment whose text is empty/whitespace", async () => {
    const expand = makeExpandAttachments(fakeUpload({}))
    const msg: Message = {
      ...textMsg('q'),
      attachments: [{ id: 'p1', name: '粘贴文本 #1', mediaType: 'text/plain', route: 'pasted', text: '   ' }],
    }

    const out = await expand([msg])

    expect(out[0]).toBe(msg) // nothing to prepend → untouched original
    expect(out[0]!.content).toEqual([{ type: 'text', text: 'q' }])
  })
})
