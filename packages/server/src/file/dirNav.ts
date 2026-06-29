import { readdir, stat } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import type { DirNav } from '@zuse/protocol'

/**
 * Windows drive roots that currently exist (C:\, D:\, …) by probing A–Z. Empty on POSIX (one root).
 * Lets the picker jump between drives — a drive root's parent is itself, so "up" can't reach them.
 */
async function listDrives(): Promise<string[]> {
  if (process.platform !== 'win32') return []
  // Probe A–Z concurrently — unmounted letters are the slow ones (brief stalls); running them in
  // parallel keeps the whole probe ~one stat's latency instead of 26 in series.
  const letters = Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`)
  const checked = await Promise.all(letters.map((root) => stat(root).then(() => root, () => null)))
  return checked.filter((r): r is string => r !== null)
}

/**
 * List a directory for the S3 working-directory picker: its immediate SUBDIRECTORIES (files
 * omitted — you're choosing a folder), its parent, and the machine's drives. Unrestricted by
 * design (the picker must navigate anywhere to pick a new cwd); acceptable under the single-user
 * trust model. Throws (ENOENT etc.) if the path can't be read — the route maps that to 404/400.
 */
export async function listDirsAt(path: string): Promise<DirNav> {
  const abs = resolve(path)
  const names = await readdir(abs)
  // stat concurrently (see FileService.list) — keep only readable subdirectories.
  const settled = await Promise.all(
    names.map(async (name): Promise<{ name: string; path: string } | null> => {
      try {
        return (await stat(join(abs, name))).isDirectory() ? { name, path: join(abs, name) } : null
      } catch {
        return null
      }
    }),
  )
  const dirs = settled.filter((d): d is { name: string; path: string } => d !== null)
  dirs.sort((a, b) => a.name.localeCompare(b.name))
  const parent = dirname(abs)
  return { path: abs, parent: parent === abs ? null : parent, dirs, drives: await listDrives() }
}
