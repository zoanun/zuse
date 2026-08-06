import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * public/ 里的静态资源必须是**浏览器真能解析**的。
 *
 * 这条测试的由来：favicon.svg 的注释里写了 CSS 变量名（带前缀的两个连字符），
 * 而 XML 规范禁止注释内出现连续两个 ASCII 连字符 —— 浏览器直接报
 * `Comment must not contain '--'` 并拒绝渲染整个图标。
 *
 * 当时它是怎么溜过去的，值得写下来：
 * - typecheck 与单测都碰不到 public/ 里的文件；
 * - 我用 curl 确认了「HTTP 200 + content-type: image/svg+xml」就宣布验证通过，
 *   但那只验证了**传输**，没验证**可解析**。返回得了不等于读得懂。
 *
 * 所以这里断言的是「能被 XML 解析器解析且解析出预期结构」，而不是「文件存在」。
 */
const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

function xmlFiles(): string[] {
  return readdirSync(publicDir).filter((f) => ['.svg', '.xml'].includes(extname(f).toLowerCase()))
}

describe('public/ 静态资源', () => {
  it('目录里确实有资源（防止本测试因为空目录而空跑通过）', () => {
    expect(xmlFiles().length).toBeGreaterThan(0)
  })

  it.each(xmlFiles())('%s 能被 XML 解析器解析', (name) => {
    const text = readFileSync(join(publicDir, name), 'utf8')
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
    const err = doc.querySelector('parsererror')
    expect(err?.textContent ?? null).toBeNull()
    expect(doc.documentElement.tagName.toLowerCase()).toBe('svg')
  })

  // 单独把这条规则钉出来：它是上面那次事故的直接原因，而且极易复发 ——
  // 谁在注释里提一句 CSS 变量名或命令行长选项（--force 之类）就会中招。
  it.each(xmlFiles())('%s 的注释里没有连续两个连字符（XML 非法）', (name) => {
    const text = readFileSync(join(publicDir, name), 'utf8')
    const comments = [...text.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1] ?? '')
    for (const c of comments) expect(c).not.toContain('--')
  })
})
