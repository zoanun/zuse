import { describe, it, expect } from 'vitest'
import { detectKind, kindFromLang, langFromNode, sniffHtml } from './detect.js'

/** 造一个 react-markdown v9 传给 `pre` 的 node 形状。 */
const nodeWithLang = (lang: string) => ({
  children: [{ properties: { className: ['hljs', `language-${lang}`] } }],
})

describe('langFromNode —— 语言只藏在 node 里，不在 props', () => {
  it('从 node.children[0].properties.className 取出语言', () => {
    expect(langFromNode(nodeWithLang('jsx'))).toBe('jsx')
  })

  it('大小写归一', () => {
    expect(langFromNode({ children: [{ properties: { className: ['language-TSX'] } }] })).toBe('tsx')
  })

  // 无语言标注的围栏：className 里只有 hljs，没有 language-*。
  it('没有 language-* 类名时返回 null', () => {
    expect(langFromNode({ children: [{ properties: { className: ['hljs'] } }] })).toBeNull()
  })

  // 形状不对时必须安静地返回 null，不能抛 —— 它跑在渲染路径上，抛了整条消息就白屏。
  it('形状异常一律返回 null 而不抛', () => {
    expect(langFromNode(undefined)).toBeNull()
    expect(langFromNode({})).toBeNull()
    expect(langFromNode({ children: [] })).toBeNull()
    expect(langFromNode({ children: [{ properties: { className: 'language-js' } }] })).toBeNull()
  })
})

describe('kindFromLang', () => {
  it('认常见别名', () => {
    expect(kindFromLang('javascript')).toBe('js')
    expect(kindFromLang('typescript')).toBe('ts')
    expect(kindFromLang('htm')).toBe('html')
  })

  // Python/Java 归 A2（server 子进程），不是浏览器预览。误判成可预览会给用户一个点了没反应的按钮。
  it('后端语言与不可预览语言返回 null', () => {
    for (const lang of ['python', 'java', 'bash', 'sh', 'json', 'yaml', 'sql', 'diff', 'markdown']) {
      expect(kindFromLang(lang), lang).toBeNull()
    }
  })
})

describe('sniffHtml —— 只在完全没有语言标注时兜底', () => {
  it('认 doctype / html / body', () => {
    expect(sniffHtml('<!DOCTYPE html><html><body>x</body></html>')).toBe(true)
    expect(sniffHtml('<html lang="zh">')).toBe(true)
  })

  // 关键的负例：含尖括号 ≠ 可运行页面。误判会让一段泛型代码或纯文本冒出运行按钮。
  it('不把含尖括号的普通文本当成页面', () => {
    expect(sniffHtml('a < b && c > d')).toBe(false)
    expect(sniffHtml('const x: Array<string> = []')).toBe(false)
    expect(sniffHtml('<div>只是个片段</div>')).toBe(false)
  })
})

describe('detectKind', () => {
  it('语言标注优先', () => {
    expect(detectKind(nodeWithLang('vue'), 'anything')).toBe('vue')
  })

  it('无语言标注时才嗅探 HTML', () => {
    const noLang = { children: [{ properties: { className: ['hljs'] } }] }
    expect(detectKind(noLang, '<!doctype html><html></html>')).toBe('html')
    expect(detectKind(noLang, 'print("hi")')).toBeNull()
  })

  // 标了非预览语言就不该再嗅探 —— 一段 ```bash 里恰好含 <html> 不该冒出运行按钮。
  it('标了不可预览的语言时，不做 HTML 嗅探兜底', () => {
    expect(detectKind(nodeWithLang('bash'), 'curl -d "<html>"')).toBeNull()
  })
})
