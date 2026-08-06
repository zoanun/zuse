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
    expect(unknownPackages(['react', 'lodash', 'vue'])).toEqual(['lodash', 'vue'])
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
})
