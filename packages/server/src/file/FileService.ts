import { readdir, stat, open } from 'node:fs/promises'
import { resolve, relative, join, sep, isAbsolute } from 'node:path'
import type { DirListing, FileEntry, FilePreview } from '@zuse/protocol'

/** Files larger than this are truncated for preview (256 KiB). */
const PREVIEW_CAP = 256 * 1024
/** Bytes sniffed for a NUL to call a file binary. */
const SNIFF = 4096

export class PathOutsideRootError extends Error {
  constructor() {
    super('path is outside the project root')
    this.name = 'PathOutsideRootError'
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
    if (abs !== this.root && !abs.startsWith(this.root + sep)) throw new PathOutsideRootError()
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
    const entries: FileEntry[] = []
    for (const name of names) {
      const abs = join(absDir, name)
      let isDir: boolean
      try {
        isDir = (await stat(abs)).isDirectory()
      } catch {
        continue // unreadable / vanished entry — skip it
      }
      entries.push({ name, path: this.toRel(abs), type: isDir ? 'dir' : 'file' })
    }
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return { path: this.toRel(absDir), entries }
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
      if (head.includes(0)) return { path, content: '', truncated: false, binary: true, size: st.size }

      const toRead = Math.min(st.size, PREVIEW_CAP)
      const buf = Buffer.alloc(toRead)
      if (toRead > 0) await fh.read(buf, 0, toRead, 0)
      return { path, content: buf.toString('utf8'), truncated: st.size > PREVIEW_CAP, binary: false, size: st.size }
    } finally {
      await fh.close()
    }
  }
}
