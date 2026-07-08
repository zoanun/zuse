export type FileView = 'text' | 'image' | 'pdf' | 'other'

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'])
// Known-binary extensions we can't preview inline → "cannot display + download".
const OTHER_EXT = new Set([
  'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'zip', 'gz', 'tar', 'rar', '7z',
  'exe', 'dll', 'so', 'dylib', 'bin', 'wasm', 'mp4', 'mov', 'avi', 'mkv', 'mp3', 'wav', 'flac',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
])

function ext(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
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
