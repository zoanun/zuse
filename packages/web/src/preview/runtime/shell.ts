import { importMapJson } from './importmap.js'
import { preambleSource } from './preamble.js'

/** guest 的基础样式：跟随 data-theme，避免浅色主题下弹出一块刺眼的白（设计 §6.5）。 */
const BASE_CSS = `
  :root { color-scheme: light; background: #fff; color: #1e1d1a; }
  :root[data-theme="dark"] { color-scheme: dark; background: #212120; color: #e8e6e1; }
  html, body { margin: 0; padding: 0; }
  body { font: 14px/1.6 -apple-system, "Microsoft YaHei", system-ui, sans-serif; padding: 12px; }
`

/**
 * 造 iframe 的 srcdoc。
 *
 * **它只随 import map 变化**（几乎不变）—— 代码更新一律走 postMessage eval。
 * 原因：srcdoc 一改就必然销毁整个 document（没有 HMR），而模型是逐 token 吐代码的，
 * 绑在 code 上会造成几百次 iframe 重建：闪屏、丢状态、CPU 拉满（设计 §4）。
 */
export function buildShellSrcdoc(token: string, theme: 'light' | 'dark'): string {
  return `<!doctype html>
<html data-theme="${theme}">
<head>
<meta charset="utf-8">
<script type="importmap">${importMapJson()}</script>
<style>${BASE_CSS}</style>
<script>${preambleSource(token)}</script>
</head>
<body><div id="app"></div></body>
</html>`
}

/**
 * HTML 类产物直接就是一整个 document，不走 eval 通道 —— 用户写的 `<head>`/`<script>`
 * 要原样生效。把 preamble 注入到最前面，日志与高度上报照常可用。
 */
export function buildHtmlSrcdoc(userHtml: string, token: string, theme: 'light' | 'dark'): string {
  const inject = `<style>${BASE_CSS}</style><script>${preambleSource(token)}</script>`
  // 有 <head> 就插进去；没有就整段前置（浏览器会自行补全 document 结构）。
  const headOpen = userHtml.match(/<head[^>]*>/i)
  // 模型吐出来的「HTML」经常是**片段**（`<div>…</div>`，压根没有 <html> 标签）。
  // 只做 replace 的话正则不命中就**静默不加** data-theme —— BASE_CSS 的深色规则挂在
  // `:root[data-theme="dark"]` 上，选择器匹配不上，深色模式下就是一整块刺眼的白。
  // 所以未命中时把 <html> 显式补在最前面（浏览器会把它当作文档根，不会重复）。
  const htmlOpen = `<html data-theme="${theme}">`
  const hasHtmlTag = /<html/i.test(userHtml)
  const withTheme = hasHtmlTag
    ? userHtml.replace(/<html/i, `<html data-theme="${theme}"`)
    : htmlOpen + userHtml
  if (headOpen) {
    const at = withTheme.indexOf(headOpen[0]) + headOpen[0].length
    return withTheme.slice(0, at) + inject + withTheme.slice(at)
  }
  // 补出来的 <html> 要留在最前面，inject 插在它**之后**。
  return hasHtmlTag ? inject + withTheme : htmlOpen + inject + userHtml
}
