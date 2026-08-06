import type { PreviewKind } from './types.js'

/**
 * fenced code block 的语言 → 可预览的 kind；不可预览返回 null。
 *
 * 别名按 highlight.js / 常见写法收：模型写 ```javascript 和 ```js 一样常见。
 */
const LANG_TO_KIND: Record<string, PreviewKind> = {
  html: 'html', htm: 'html', xhtml: 'html',
  js: 'js', javascript: 'js', mjs: 'js',
  ts: 'ts', typescript: 'ts',
  jsx: 'jsx',
  tsx: 'tsx',
  vue: 'vue',
}

/**
 * 从 react-markdown 传给 `pre` 组件的 `node` 里取语言。
 *
 * 这条路径是被实测过的，别想当然：react-markdown v9 传给 `pre` 的 props 里
 * **`className` 为 null**，除 children/node 外没有任何自有 prop。语言只存在于
 * `node.children[0].properties.className`，形如 `["hljs", "language-jsx"]`。
 * 所以 `CodeBlock` 的签名必须保留 `node` 而不是解构后丢掉。
 */
export function langFromNode(node: unknown): string | null {
  const el = node as { children?: Array<{ properties?: { className?: unknown } }> } | undefined
  const classes = el?.children?.[0]?.properties?.className
  if (!Array.isArray(classes)) return null
  for (const c of classes) {
    if (typeof c === 'string' && c.startsWith('language-')) return c.slice('language-'.length).toLowerCase()
  }
  return null
}

/** 语言字符串 → kind。未知语言（python/java/bash/...）返回 null —— 那些归 A2 或不可预览。 */
export function kindFromLang(lang: string | null): PreviewKind | null {
  if (!lang) return null
  return LANG_TO_KIND[lang.toLowerCase()] ?? null
}

/**
 * HTML 判定的一个补充：模型有时把整页 HTML 标成 ```html，也有时不标语言。
 * 只在**完全没有语言标注**时才做内容嗅探，且要求明确的 HTML 特征 —— 避免把一段
 * 恰好含尖括号的文本误判成可运行页面。
 */
export function sniffHtml(code: string): boolean {
  const head = code.slice(0, 500).toLowerCase()
  return /<!doctype\s+html|<html[\s>]|<body[\s>]/.test(head)
}

/** 综合判定：给定 node 与代码正文，返回可预览的 kind 或 null。 */
export function detectKind(node: unknown, code: string): PreviewKind | null {
  const lang = langFromNode(node)
  const byLang = kindFromLang(lang)
  if (byLang) return byLang
  if (lang === null && sniffHtml(code)) return 'html'
  return null
}
