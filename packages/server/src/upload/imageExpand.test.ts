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

  it("skips route:'parsed' attachments (no expansion)", async () => {
    const upload = fakeUpload({ a1: { data: 'D', mediaType: 'image/png' } })
    const expand = makeExpandAttachments(upload)
    const msg: Message = {
      ...textMsg('parsed one'),
      attachments: [{ id: 'a1', name: 'p.png', mediaType: 'image/png', route: 'parsed' }],
    }

    const out = await expand([msg])

    expect(out[0]).toBe(msg) // untouched original returned
    expect(out[0]!.content).toEqual([{ type: 'text', text: 'parsed one' }])
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
