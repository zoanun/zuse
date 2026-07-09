import { mkdir, writeFile, rename, readFile, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

/** Hard ceiling on a single upload: 25 MiB. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/** Thrown when the declared mediaType is not a supported image type. */
export class UnsupportedMediaError extends Error {
  constructor(mediaType: string) {
    super(`unsupported media type: ${mediaType}`)
    this.name = 'UnsupportedMediaError'
  }
}

/** Thrown when the uploaded byte length exceeds MAX_UPLOAD_BYTES. */
export class TooLargeError extends Error {
  constructor() {
    super(`upload exceeds ${MAX_UPLOAD_BYTES} bytes`)
    this.name = 'TooLargeError'
  }
}

/**
 * Supported image types. `image/jpg` is a common (technically-wrong) alias for
 * `image/jpeg`; we accept it on input and normalize both to a single canonical
 * (ext, mediaType) pair so stored files and re-derived types never diverge.
 */
const CANONICAL: Record<string, { ext: string; mediaType: string }> = {
  'image/png': { ext: '.png', mediaType: 'image/png' },
  'image/jpeg': { ext: '.jpg', mediaType: 'image/jpeg' },
  'image/jpg': { ext: '.jpg', mediaType: 'image/jpeg' },
  'image/gif': { ext: '.gif', mediaType: 'image/gif' },
  'image/webp': { ext: '.webp', mediaType: 'image/webp' },
}

/** ext (as stored) → canonical mediaType, for reading a file back. */
const MEDIA_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/**
 * randomUUID's exact shape (8-4-4-4-12 lowercase hex). Anchored so nothing before/after slips in
 * — this is the ONLY thing allowed near a filesystem path, so a hyphen-and-hex-only id can carry
 * no separator, no `..`, no drive letter. Ids that don't match are rejected before any join().
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Stores user-uploaded images (I2). Files are written under a single uploads directory
 * ({@link save} lazily mkdir -p's it), named ONLY by a freshly-generated uuid plus an extension
 * derived from the mediaType — the caller's original filename is never used to build a path, so
 * an upload can't smuggle in `..` or a separator. Reads ({@link load}/{@link readBase64}) validate
 * the id against {@link UUID_RE} before touching disk, closing the path-traversal hole from the
 * other side.
 */
export class UploadService {
  constructor(private readonly uploadsDir: string) {}

  /** Absolute path for a validated id + its stored extension. */
  private pathFor(id: string, ext: string): string {
    return join(this.uploadsDir, `${id}${ext}`)
  }

  /**
   * Validate + persist an image. Rejects non-image mediaTypes (UnsupportedMediaError) and oversize
   * payloads (TooLargeError) BEFORE writing. The file is written to a `.tmp` sibling then renamed
   * into place so a crash mid-write can't leave a half-written image under a live id.
   */
  async save(bytes: Buffer, mediaType: string): Promise<{ id: string }> {
    const canon = CANONICAL[mediaType.toLowerCase()]
    if (!canon) throw new UnsupportedMediaError(mediaType)
    if (bytes.length > MAX_UPLOAD_BYTES) throw new TooLargeError()

    await mkdir(this.uploadsDir, { recursive: true })
    const id = randomUUID()
    const finalPath = this.pathFor(id, canon.ext)
    const tmpPath = `${finalPath}.tmp`
    await writeFile(tmpPath, bytes)
    await rename(tmpPath, finalPath)
    return { id }
  }

  /**
   * Resolve a stored image by id: validates the id shape, then finds which supported extension it
   * was stored under. Returns the absolute path, byte size, and canonical mediaType. Throws on a
   * malformed id (no disk access) or if no matching file exists.
   */
  async load(id: string): Promise<{ abs: string; size: number; mediaType: string }> {
    if (!UUID_RE.test(id)) throw new Error(`invalid upload id: ${JSON.stringify(id)}`)
    for (const [ext, mediaType] of Object.entries(MEDIA_BY_EXT)) {
      const abs = this.pathFor(id, ext)
      try {
        const st = await stat(abs)
        if (st.isFile()) return { abs, size: st.size, mediaType }
      } catch {
        // not this extension — try the next
      }
    }
    throw new Error(`upload not found: ${id}`)
  }

  /** Read a stored image back as base64 plus its canonical mediaType. */
  async readBase64(id: string): Promise<{ data: string; mediaType: string }> {
    const { abs, mediaType } = await this.load(id)
    const buf = await readFile(abs)
    return { data: buf.toString('base64'), mediaType }
  }
}
