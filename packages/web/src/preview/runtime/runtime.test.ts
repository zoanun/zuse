import { describe, it, expect } from 'vitest'
import { PREVIEW_IMPORT_MAP, importMapJson, unknownPackages } from './importmap.js'
import { preambleSource } from './preamble.js'
import { buildHtmlSrcdoc, buildShellSrcdoc } from './shell.js'

describe('import map', () => {
  // 编译走 production:true → 产出 jsx-runtime。留着 jsx-dev-runtime 等于给 vendor
  // 构建白养一个入口，且会掩盖「runtime 选错了」这个真问题。
  it('不含 jsx-dev-runtime —— 编译产出的是 jsx-runtime', () => {
    expect(Object.keys(PREVIEW_IMPORT_MAP)).not.toContain('react/jsx-dev-runtime')
    expect(PREVIEW_IMPORT_MAP['react/jsx-runtime']).toBeTruthy()
  })

  it('是封闭表：未知包能被认出来', () => {
    expect(unknownPackages(['react', 'vue', 'lodash', 'axios'])).toEqual(['lodash', 'axios'])
  })

  // vue 在 PR2 才进表。写一条独立断言，免得将来有人为了「精简」把它删了。
  it('vue 在表内（PR2 起 Vue SFC 预览依赖它）', () => {
    expect(PREVIEW_IMPORT_MAP['vue']).toBeTruthy()
  })

  it('产出合法 JSON', () => {
    expect(JSON.parse(importMapJson())).toHaveProperty('imports.react')
  })
})

describe('preamble —— 三条设计约束必须在源码里落地', () => {
  const src = preambleSource('tok-1')

  it('token 被写进去', () => {
    expect(src).toContain('"tok-1"')
  })

  // 约束 1：高度由 guest 自己上报。父页读 contentDocument 会把「换成真沙箱」这个决策锁死。
  it('用 ResizeObserver 在 guest 内部上报高度', () => {
    expect(src).toContain('ResizeObserver')
    expect(src).toContain("type: 'resize'")
  })

  // 约束 2：postMessage 必须能降级，否则一条无法克隆的日志会让日志桥永久哑掉。
  it('postMessage 包了 try/catch 且有 toText 降级', () => {
    expect(src).toContain('function toText')
    expect(src).toMatch(/try \{ parent\.postMessage/)
  })

  // 约束 3：srcdoc 里 location.origin 恒为 "null"，拿它做校验必然写出假安全。
  it('不使用 location.origin 做校验', () => {
    expect(src).not.toContain('location.origin')
  })

  /**
   * 模块级 import 失败是**完全静默**的：实测 `window.onerror` 不触发、
   * `unhandledrejection` 不触发、`script.onerror` 也不可靠。最典型的场景是
   * `/preview-vendor/*` 取不到（vendor 产物没构建、或路径变了），现象是
   * 「预览一片空白 + 控制台零输出」—— 没有这条归因，用户和维护者都无从下手。
   */
  it('模块体没跑起来时能归因，而不是静默空白', () => {
    // 报到标记必须**拼进注入的模块体**（只留下面那句检查是不够的 —— 摘掉这一句，
    // 检查永远不成立，反而变成每次都误报）。
    expect(src).toMatch(/script\.textContent\s*=\s*'window\.__zuseRan = ' \+ runId/)
    // 超时后检查是否报到，报到了就闭嘴。
    expect(src).toMatch(/window\.__zuseRan === runId/)
    expect(src).toContain('MODULE_START_TIMEOUT_MS')
    // 错误文本要指名道姓地把人引到 vendor 产物上，否则「归因」等于没归。
    expect(src).toContain('/preview-vendor/')
    // 只对最新一轮负责：连改两次代码时，上一轮的超时不能误报。
    expect(src).toMatch(/runId !== EVAL_SEQ/)
  })

  it('patch 了全部日志级别，并接了两类未捕获错误', () => {
    for (const lvl of ['log', 'info', 'warn', 'error', 'debug']) expect(src).toContain(`'${lvl}'`)
    expect(src).toContain('window.onerror')
    expect(src).toContain('unhandledrejection')
  })
})

describe('srcdoc 构造', () => {
  it('shell 带 import map、preamble 与主题', () => {
    const html = buildShellSrcdoc('t', 'dark')
    expect(html).toContain('type="importmap"')
    expect(html).toContain('data-theme="dark"')
    expect(html).toContain('ResizeObserver')
    expect(html).toContain('id="app"')
  })

  it('HTML 类产物：preamble 插进用户自己的 <head>，用户内容原样保留', () => {
    const out = buildHtmlSrcdoc('<html><head><title>T</title></head><body><b>hi</b></body></html>', 't', 'light')
    expect(out).toContain('<title>T</title>')
    expect(out).toContain('<b>hi</b>')
    expect(out).toContain('data-theme="light"')
    expect(out.indexOf('ResizeObserver')).toBeLessThan(out.indexOf('<title>'))
  })

  it('HTML 没有 <head> 时也能注入', () => {
    const out = buildHtmlSrcdoc('<p>片段</p>', 't', 'light')
    expect(out).toContain('<p>片段</p>')
    expect(out).toContain('ResizeObserver')
  })

  /**
   * 模型吐出来的「HTML」经常是**片段**（`<div>…</div>`，根本没有 `<html>` 标签）。
   * 初版用 `userHtml.replace(/<html/i, …)` 注入 data-theme —— 片段上正则不命中，
   * 就**静默不加**，深色模式下用户看到的是一整块刺眼的白（BASE_CSS 的深色规则挂在
   * `:root[data-theme="dark"]` 上，选择器匹配不上）。
   */
  it('HTML 片段（没有 <html> 标签）在深色模式下也必须带上 data-theme', () => {
    const out = buildHtmlSrcdoc('<p>片段</p>', 't', 'dark')
    expect(out).toMatch(/<html[^>]*data-theme="dark"/)
    expect(out).toContain('<p>片段</p>')
  })

  it('片段补的 <html> 不能重复：用户已有 <html> 时仍然只有一个', () => {
    const out = buildHtmlSrcdoc('<html><body><b>hi</b></body></html>', 't', 'dark')
    expect(out.match(/<html/gi)).toHaveLength(1)
    expect(out).toMatch(/<html[^>]*data-theme="dark"/)
  })
})
