import { mkdir, writeFile, rename, readFile, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, basename } from 'node:path'

/** Hard ceiling on a single upload: 25 MiB. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/** Hard ceiling on a single arbitrary-file upload: 50 MiB (wider than images — docs/archives). */
export const FILE_MAX_BYTES = 50 * 1024 * 1024

/** Default byte budget for the base64 read cache (64 MiB). Eviction is by total bytes, not count. */
export const MAX_CACHE_BYTES = 64 * 1024 * 1024

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

/** Thrown when an arbitrary-file upload exceeds FILE_MAX_BYTES. → 413. */
export class FileTooLargeError extends Error {
  constructor() {
    super(`file upload exceeds ${FILE_MAX_BYTES} bytes`)
    this.name = 'FileTooLargeError'
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

/** Reduce an arbitrary client filename to a safe basename (no directory parts, no traversal). Runs on
 *  both save and filePath so the two agree. Backslashes are normalized to '/' first so a Windows path
 *  is stripped by posix basename regardless of host. Empty / '.' / '..' fall back to 'file'. */
function safeFilename(name: string): string {
  const b = basename((name ?? '').replace(/[\\/]+/g, '/')).trim()
  return b === '' || b === '.' || b === '..' ? 'file' : b
}

/**
 * Stores user-uploaded images (I2). Files are written under a single uploads directory
 * ({@link save} lazily mkdir -p's it), named ONLY by a freshly-generated uuid plus an extension
 * derived from the mediaType — the caller's original filename is never used to build a path, so
 * an upload can't smuggle in `..` or a separator. Reads ({@link load}/{@link readBase64}) validate
 * the id against {@link UUID_RE} before touching disk, closing the path-traversal hole from the
 * other side.
 */
export class UploadService {
  constructor(private readonly uploadsDir: string, private readonly maxCacheBytes: number = MAX_CACHE_BYTES) {}

  /**
   * Bounded base64 cache keyed by (immutable) upload id — the direct-attach hot path re-reads the
   * same images every turn, and a UUID's bytes never change, so this is safe. Bounded by TOTAL
   * base64 bytes (maxCacheBytes), not entry count: one huge image is worth many small ones, so a
   * count cap could still let ~1 GB sit resident. Map preserves insertion order → first key is the
   * eldest, evicted first. `cacheBytes` tracks the running sum of cached `data.length`.
   */
  private readonly cache = new Map<string, { data: string; mediaType: string }>()
  private cacheBytes = 0

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
    const newLen = entry.data.length
    // A single entry that alone blows the budget is never cached (it would only be evicted again
    // on the next miss) — return it uncached rather than churn the whole cache out.
    if (newLen > this.maxCacheBytes) return entry
    // Evict oldest entries until the newcomer fits within the byte budget.
    while (this.cacheBytes + newLen > this.maxCacheBytes && this.cache.size > 0) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      const evicted = this.cache.get(oldest)
      this.cache.delete(oldest)
      if (evicted) this.cacheBytes -= evicted.data.length
    }
    this.cache.set(id, entry)
    this.cacheBytes += newLen
    return entry
  }

  /**
   * Persist an arbitrary uploaded file under `<uploadsDir>/<uuid>/<safeName>` — a per-upload uuid dir
   * isolates it (no name collisions, no traversal out of the dir), while the original (sanitized)
   * filename is preserved so its extension survives for the agent/skill that reads it. No MIME check.
   * Written to a `.tmp` sibling then renamed. Returns the id + the actually-stored (safe) name.
   */
  async saveFile(bytes: Buffer, name: string): Promise<{ id: string; name: string }> {
    if (bytes.length > FILE_MAX_BYTES) throw new FileTooLargeError()
    const id = randomUUID()
    const safe = safeFilename(name)
    const dir = join(this.uploadsDir, id)
    await mkdir(dir, { recursive: true })
    const finalPath = join(dir, safe)
    const tmpPath = `${finalPath}.tmp`
    await writeFile(tmpPath, bytes)
    await rename(tmpPath, finalPath)
    return { id, name: safe }
  }

  /** Absolute path of a stored arbitrary file. Validates the id shape (no disk access, no traversal),
   *  re-applies safeFilename so a caller-passed name can't smuggle a separator. Used by
   *  expandAttachments to put the path in the model-facing note. */
  filePath(id: string, name: string): string {
    if (!UUID_RE.test(id)) throw new InvalidUploadIdError(id)
    return join(this.uploadsDir, id, safeFilename(name))
  }
}
