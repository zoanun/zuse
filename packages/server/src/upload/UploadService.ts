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

/** Thrown when an id doesn't match the uuid shape (never touches disk). → 400. */
export class InvalidUploadIdError extends Error {
  constructor(id: string) {
    super(`invalid upload id: ${JSON.stringify(id)}`)
    this.name = 'InvalidUploadIdError'
  }
}

/** Thrown when a well-formed id has no stored file. → 404. */
export class UploadNotFoundError extends Error {
  constructor(id: string) {
    super(`upload not found: ${id}`)
    this.name = 'UploadNotFoundError'
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

/** ext (as stored) → canonical mediaType, for reading a file back. Derived from CANONICAL so the
 *  two never drift (dedupe collapses image/jpg + image/jpeg onto the single .jpg → image/jpeg). */
const MEDIA_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.values(CANONICAL).map((c) => [c.ext, c.mediaType]),
)

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

  /**
   * Bounded base64 cache keyed by (immutable) upload id — the direct-attach hot path re-reads the
   * same images every turn, and a UUID's bytes never change, so this is safe. Capped at 32 entries;
   * when full we evict the oldest (Map preserves insertion order → first key is the eldest).
   */
  private readonly cache = new Map<string, { data: string; mediaType: string }>()
  private static readonly CACHE_MAX = 32

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
    if (!UUID_RE.test(id)) throw new InvalidUploadIdError(id)
    for (const [ext, mediaType] of Object.entries(MEDIA_BY_EXT)) {
      const abs = this.pathFor(id, ext)
      try {
        const st = await stat(abs)
        if (st.isFile()) return { abs, size: st.size, mediaType }
      } catch {
        // not this extension — try the next
      }
    }
    throw new UploadNotFoundError(id)
  }

  /** Read a stored image back as base64 plus its canonical mediaType. Cached by id (see {@link cache});
   *  the id is still validated via load() before any disk touch on a miss. */
  async readBase64(id: string): Promise<{ data: string; mediaType: string }> {
    const hit = this.cache.get(id)
    if (hit) return hit
    const { abs, mediaType } = await this.load(id)
    const buf = await readFile(abs)
    const entry = { data: buf.toString('base64'), mediaType }
    if (this.cache.size >= UploadService.CACHE_MAX) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(id, entry)
    return entry
  }
}
