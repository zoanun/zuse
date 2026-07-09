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

  it("expands a route:'parsed' attachment into a text block (the description) prepended to content", async () => {
    const upload = fakeUpload({})
    const expand = makeExpandAttachments(upload)
    const msg: Message = {
      ...textMsg('parsed one'),
      attachments: [{ id: 'a1', name: 'p.png', mediaType: 'image/png', route: 'parsed', description: 'a red cat' }],
    }

    const out = await expand([msg])

    expect(out[0]!.content).toEqual([
      { type: 'text', text: 'a red cat' },
      { type: 'text', text: 'parsed one' },
    ])
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

    expect(out[0]!.content).toEqual([
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'IMGDATA' } },
      { type: 'text', text: 'a chart' },
      { type: 'text', text: 'both' },
    ])
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
})
