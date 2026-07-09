import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UploadService, UnsupportedMediaError, TooLargeError, MAX_UPLOAD_BYTES } from './UploadService.js'

// A 1x1 transparent PNG (real header) — used to check bytes round-trip exactly.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
const GIF = Buffer.from('GIF89a', 'ascii')
const WEBP = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii')])

describe('UploadService (I2)', () => {
  let dir: string
  let svc: UploadService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zuse-uploads-'))
    svc = new UploadService(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('save() stores a png under <dir>/<id>.png with byte-identical content', async () => {
    const { id } = await svc.save(PNG, 'image/png')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    const onDisk = await readFile(join(dir, `${id}.png`))
    expect(onDisk.equals(PNG)).toBe(true)
  })

  it('load() returns abs, size, and mediaType for a stored file', async () => {
    const { id } = await svc.save(PNG, 'image/png')
    const info = await svc.load(id)
    expect(info.abs).toBe(join(dir, `${id}.png`))
    expect(info.size).toBe(PNG.length)
    expect(info.mediaType).toBe('image/png')
  })

  it('readBase64() returns the base64 of the stored bytes + mediaType', async () => {
    const { id } = await svc.save(PNG, 'image/png')
    const { data, mediaType } = await svc.readBase64(id)
    expect(data).toBe(PNG.toString('base64'))
    expect(mediaType).toBe('image/png')
  })

  it('accepts jpeg, gif, and webp and loads them back', async () => {
    const j = await svc.save(JPEG, 'image/jpeg')
    expect((await svc.load(j.id)).mediaType).toBe('image/jpeg')
    expect((await svc.readBase64(j.id)).data).toBe(JPEG.toString('base64'))

    const g = await svc.save(GIF, 'image/gif')
    expect((await svc.load(g.id)).mediaType).toBe('image/gif')
    expect((await svc.readBase64(g.id)).data).toBe(GIF.toString('base64'))

    const w = await svc.save(WEBP, 'image/webp')
    expect((await svc.load(w.id)).mediaType).toBe('image/webp')
    expect((await svc.readBase64(w.id)).data).toBe(WEBP.toString('base64'))
  })

  it('normalizes image/jpg to .jpg + image/jpeg', async () => {
    const { id } = await svc.save(JPEG, 'image/jpg')
    await stat(join(dir, `${id}.jpg`)) // exists with .jpg ext
    expect((await svc.load(id)).mediaType).toBe('image/jpeg')
  })

  it('rejects a non-image mediaType with UnsupportedMediaError', async () => {
    await expect(svc.save(Buffer.from('hi'), 'text/plain')).rejects.toBeInstanceOf(UnsupportedMediaError)
  })

  it('rejects bytes larger than MAX_UPLOAD_BYTES with TooLargeError', async () => {
    const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1)
    await expect(svc.save(big, 'image/png')).rejects.toBeInstanceOf(TooLargeError)
  })

  it('accepts bytes exactly at the size limit', async () => {
    const atLimit = Buffer.alloc(MAX_UPLOAD_BYTES)
    const { id } = await svc.save(atLimit, 'image/png')
    expect((await svc.load(id)).size).toBe(MAX_UPLOAD_BYTES)
  })

  it('load() rejects a traversal id without touching files outside the dir', async () => {
    // Plant a secret file next to (outside) the uploads dir.
    const secret = join(dir, '..', `zuse-secret-${process.pid}.txt`)
    await writeFile(secret, 'top secret', 'utf8')
    try {
      await expect(svc.load('../' + `zuse-secret-${process.pid}.txt`)).rejects.toThrow()
      await expect(svc.load('a/b')).rejects.toThrow()
      await expect(svc.load('a\\b')).rejects.toThrow()
      await expect(svc.readBase64('../../etc/passwd')).rejects.toThrow()
    } finally {
      rmSync(secret, { force: true })
    }
  })

  it('load()/readBase64() reject a malformed (non-uuid) id', async () => {
    await expect(svc.load('nope')).rejects.toThrow()
    await expect(svc.load('')).rejects.toThrow()
    await expect(svc.readBase64('12345')).rejects.toThrow()
  })

  it('load() of a well-formed but absent id rejects (file not found)', async () => {
    await expect(svc.load('00000000-0000-0000-0000-000000000000')).rejects.toThrow()
  })

  it('readBase64() caches by id — a second read does not touch disk again', async () => {
    const { id } = await svc.save(PNG, 'image/png')
    const first = await svc.readBase64(id)
    // Delete the underlying file: a cached hit must still return the same bytes.
    rmSync(join(dir, `${id}.png`), { force: true })
    const second = await svc.readBase64(id)
    expect(second).toEqual(first)
    expect(second.data).toBe(PNG.toString('base64'))
  })
})
