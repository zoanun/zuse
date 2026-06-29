import { readdir, stat } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import type { DirNav } from '@zuse/protocol'

/**
 * Windows drive roots that currently exist (C:\, D:\, …) by probing A–Z. Empty on POSIX (one root).
 * Lets the picker jump between drives — a drive root's parent is itself, so "up" can't reach them.
 */
async function listDrives(): Promise<string[]> {
  if (process.platform !== 'win32') return []
  const out: string[] = []
  for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    const root = `${String.fromCharCode(c)}:\\`
    try {
      await stat(root)
      out.push(root)
    } catch {
      // drive letter not mounted — skip
    }
  }
  return out
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
  const dirs: { name: string; path: string }[] = []
  for (const name of names) {
    try {
      if ((await stat(join(abs, name))).isDirectory()) dirs.push({ name, path: join(abs, name) })
    } catch {
      // unreadable / vanished entry — skip
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name))
  const parent = dirname(abs)
  return { path: abs, parent: parent === abs ? null : parent, dirs, drives: await listDrives() }
}
