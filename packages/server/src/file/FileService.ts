import { readdir, stat, open, writeFile, unlink } from 'node:fs/promises'
import { resolve, relative, join, sep, isAbsolute, extname } from 'node:path'
import type { DirListing, FileEntry, FilePreview, WriteFileResult } from '@zuse/protocol'

/** Files larger than this are truncated for preview (256 KiB). */
const PREVIEW_CAP = 256 * 1024
/** Bytes sniffed for a NUL to call a file binary. */
const SNIFF = 4096

/** Extension → MIME for the raw byte endpoint (image/pdf inline preview + download). */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
}
export function mimeForExt(name: string): string {
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

export class PathOutsideRootError extends Error {
  constructor() {
    super('path is outside the project root')
    this.name = 'PathOutsideRootError'
  }
}

export class FileChangedError extends Error {
  constructor() {
    super('file changed on disk since it was loaded')
    this.name = 'FileChangedError'
  }
}

/**
 * Read-only project file browser (M7). Rooted at the daemon's cwd; every request is resolved
 * against the root and rejected if it escapes (no `..` traversal, no absolute paths out). Listing
 * is lazy — one directory level per call. Previews are size-capped and skip binary files.
 */
export class FileService {
  private readonly root: string

  constructor(cwd: string) {
    this.root = resolve(cwd)
  }

  /**
   * Resolve a project-relative path against the root, rejecting anything that escapes it.
   * Returns the absolute path. '' / '.' map to the root itself.
   */
  private resolveInRoot(rel: string): string {
    // An absolute input is only allowed if it already sits inside the root.
    const abs = isAbsolute(rel) ? resolve(rel) : resolve(this.root, rel)
    // Windows paths are case-insensitive, and path.resolve() preserves the input case of the
    // drive letter / segments rather than canonicalizing it (e.g. 'c:\proj' vs 'C:\proj'). A
    // case-sensitive compare would reject a valid in-root path whose drive case differs from
    // the cwd's. Compare case-folded on win32; still return the original-cased abs for fs ops.
    const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
    const a = fold(abs)
    const r = fold(this.root)
    if (a !== r && !a.startsWith(r + sep)) throw new PathOutsideRootError()
    return abs
  }

  /** Posix-style path relative to the root (''= root). */
  private toRel(abs: string): string {
    return relative(this.root, abs).split(sep).join('/')
  }

  /** Immediate children of a directory, dirs first then files, each alphabetical. */
  async list(relDir = ''): Promise<DirListing> {
    const absDir = this.resolveInRoot(relDir)
    const names = await readdir(absDir)
    // stat concurrently — a directory can hold thousands of entries; serial awaits would be N
    // round-trips. Unreadable/vanished entries resolve to null and are dropped.
    const settled = await Promise.all(
      names.map(async (name): Promise<FileEntry | null> => {
        const abs = join(absDir, name)
        try {
          return { name, path: this.toRel(abs), type: (await stat(abs)).isDirectory() ? 'dir' : 'file' }
        } catch {
          return null
        }
      }),
    )
    const entries = settled.filter((e): e is FileEntry => e !== null)
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return { path: this.toRel(absDir), root: this.root, entries }
  }

  /** Read a file for preview: size-capped, binary-sniffed. Throws if it's a directory. */
  async read(relPath: string): Promise<FilePreview> {
    const abs = this.resolveInRoot(relPath)
    const st = await stat(abs)
    if (st.isDirectory()) throw new Error('path is a directory')
    const path = this.toRel(abs)

    const fh = await open(abs, 'r')
    try {
      // Sniff the head for a NUL byte → treat as binary, don't ship the bytes.
      const head = Buffer.alloc(Math.min(SNIFF, st.size))
      if (head.length > 0) await fh.read(head, 0, head.length, 0)
      if (head.includes(0)) return { path, content: '', truncated: false, binary: true, size: st.size, mtimeMs: st.mtimeMs }

      const toRead = Math.min(st.size, PREVIEW_CAP)
      const buf = Buffer.alloc(toRead)
      if (toRead > 0) await fh.read(buf, 0, toRead, 0)
      return { path, content: buf.toString('utf8'), truncated: st.size > PREVIEW_CAP, binary: false, size: st.size, mtimeMs: st.mtimeMs }
    } finally {
      await fh.close()
    }
  }

  /** Write a file (edit or create). Optional mtime guard rejects a stale overwrite unless forced. */
  async write(relPath: string, content: string, opts: { expectMtimeMs?: number; force?: boolean } = {}): Promise<WriteFileResult> {
    const abs = this.resolveInRoot(relPath)
    // Refuse to clobber a directory. stat may throw ENOENT for a new file — that's fine (create).
    let existing: Awaited<ReturnType<typeof stat>> | null = null
    try { existing = await stat(abs) } catch { existing = null }
    if (existing?.isDirectory()) throw new Error('path is a directory')
    if (opts.expectMtimeMs != null && !opts.force && existing && existing.mtimeMs !== opts.expectMtimeMs) {
      throw new FileChangedError()
    }
    await writeFile(abs, content, 'utf8')
    const st = await stat(abs)
    return { path: this.toRel(abs), size: st.size, mtimeMs: st.mtimeMs }
  }

  /** Delete a file (not a directory). */
  async remove(relPath: string): Promise<void> {
    const abs = this.resolveInRoot(relPath)
    const st = await stat(abs)
    if (st.isDirectory()) throw new Error('path is a directory')
    await unlink(abs)
  }

  /** Absolute path + size + MIME for the raw byte endpoint. Rejects directories / escaping paths. */
  async statFile(relPath: string): Promise<{ abs: string; size: number; mime: string }> {
    const abs = this.resolveInRoot(relPath)
    const st = await stat(abs)
    if (st.isDirectory()) throw new Error('path is a directory')
    return { abs, size: st.size, mime: mimeForExt(abs) }
  }

  /**
   * Fuzzy filename search over the whole tree (quick-open style). Case-insensitive; ranks
   * prefix > substring > subsequence, then shorter paths first. Skips node_modules/.git at any
   * depth (noise, and node_modules alone would dwarf the project). Results capped at `limit`.
   */
  async search(query: string, limit = 50): Promise<FileEntry[]> {
    const q = query.trim().toLowerCase()
    if (q === '') return []
    const scored: { entry: FileEntry; score: number }[] = []
    const walk = async (absDir: string): Promise<void> => {
      let dirents
      try { dirents = await readdir(absDir, { withFileTypes: true }) } catch { return } // unreadable → skip
      for (const d of dirents) {
        if (d.isDirectory()) {
          if (d.name === 'node_modules' || d.name === '.git') continue
          await walk(join(absDir, d.name))
        } else if (d.isFile()) {
          const score = fuzzyScore(d.name.toLowerCase(), q)
          if (score >= 0) {
            const abs = join(absDir, d.name)
            scored.push({ entry: { name: d.name, path: this.toRel(abs), type: 'file' }, score })
          }
        }
      }
    }
    await walk(this.root)
    scored.sort((a, b) => a.score - b.score || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path))
    return scored.slice(0, limit).map((s) => s.entry)
  }
}

/** Match rank: 0 = name starts with q, 1 = contains q, 2 = subsequence (chars in order); -1 = no match. */
function fuzzyScore(name: string, q: string): number {
  if (name.startsWith(q)) return 0
  if (name.includes(q)) return 1
  let i = 0
  for (const ch of name) { if (ch === q[i]) i++; if (i === q.length) return 2 }
  return -1
}
