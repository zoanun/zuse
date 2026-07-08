import type { FileEntry } from '@zuse/protocol'

export type FileView = 'text' | 'image' | 'pdf' | 'other'

/** A node in the filtered search tree: a hit, or an ancestor directory shown as structure. */
export interface FilterNode {
  name: string
  path: string
  type: 'file' | 'dir'
  /** True when this node itself matched the query (ancestors shown for structure are false). */
  hit: boolean
  children: FilterNode[]
}

/**
 * Arrange flat filename-search hits into a tree: every hit plus the ancestor directories it
 * sits under, so results render in the same shape as the real file tree (non-matching siblings
 * pruned). Children sort dirs-first then alphabetical, matching DirListing order.
 */
export function buildFilterTree(hits: FileEntry[]): FilterNode[] {
  const byPath = new Map<string, FilterNode>()
  const roots: FilterNode[] = []
  const ensure = (path: string, type: 'file' | 'dir'): FilterNode => {
    const existing = byPath.get(path)
    if (existing) return existing
    const slash = path.lastIndexOf('/')
    const node: FilterNode = { name: slash === -1 ? path : path.slice(slash + 1), path, type, hit: false, children: [] }
    byPath.set(path, node)
    if (slash === -1) roots.push(node)
    else ensure(path.slice(0, slash), 'dir').children.push(node)
    return node
  }
  for (const h of hits) ensure(h.path, h.type).hit = true
  const sortRec = (nodes: FilterNode[]): void => {
    nodes.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)))
    for (const n of nodes) sortRec(n.children)
  }
  sortRec(roots)
  return roots
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'])
// Known-binary extensions we can't preview inline → "cannot display + download".
const OTHER_EXT = new Set([
  'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'zip', 'gz', 'tar', 'rar', '7z',
  'exe', 'dll', 'so', 'dylib', 'bin', 'wasm', 'mp4', 'mov', 'avi', 'mkv', 'mp3', 'wav', 'flac',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
])

/** Lowercased basename + extension ('' when none; a leading dot is not an extension). */
export function fileNameParts(path: string): { name: string; ext: string } {
  const base = path.split(/[\\/]/).pop() ?? path
  const dot = base.lastIndexOf('.')
  return { name: base.toLowerCase(), ext: dot > 0 ? base.slice(dot + 1).toLowerCase() : '' }
}

function ext(path: string): string {
  return fileNameParts(path).ext
}

/** Decide how to show a file, by extension. Unknown/no-extension → 'text' (let the content
 * endpoint's binary sniff downgrade it to a "cannot display" state if it turns out binary). */
export function classify(path: string): FileView {
  const e = ext(path)
  if (e === 'pdf') return 'pdf'
  if (IMAGE_EXT.has(e)) return 'image'
  if (OTHER_EXT.has(e)) return 'other'
  return 'text'
}
