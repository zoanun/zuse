import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * 「隐藏但点得着」的静态守卫。
 *
 * ## 它防的是什么
 *
 * `opacity: 0` + `:hover` 显形的控件，在触屏上**看不见却点得着** —— 而这几个控件里
 * 挂着「运行一条命令」和「重试（回滚工作区并重跑，无确认框）」。修法是把隐藏态关进
 * `@media (any-hover: hover)`，并且隐藏时连 `pointer-events` 一起关掉。
 *
 * ## 守卫的输入必须是 **CSS 本身**，不能是一份手写名单
 *
 * 第一版设计里这条守卫是「名单里的选择器必须出现在媒体查询块中」—— 而它自称要防的是
 * 「以后新增第五个悬浮控件、又忘了加进媒体查询」。**新增的那个不在名单里，守卫沉默。**
 * 那不是弱测试，是结构上不可能命中它声称的威胁。所以这里扫的是文件里所有
 * `opacity: 0` 的声明块，白名单反过来写、且每一项都要能自证。
 */
const cssPath = join(dirname(fileURLToPath(import.meta.url)), 'styles.css')
const css = readFileSync(cssPath, 'utf8')

/** `opacity: 0`（不含 `0.x`）的声明块 → 选择器。 */
function selectorsWithOpacityZero(text: string): string[] {
  const out: string[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (/\bopacity:\s*0\s*(?:;|$)/.test(m[2]!)) out.push(m[1]!.trim().replace(/\s+/g, ' '))
  }
  return out
}

/**
 * 允许在媒体查询**之外**保持 `opacity: 0` 的选择器 —— 每一项都必须自己成对处理了
 * `pointer-events`，所以它们本来就不会「隐藏但点得着」。这两条是仓内的正确写法先例。
 */
const OK_OUTSIDE = [
  '.manage-backdrop',   // 靠 .manage-root{pointer-events:none} + .manage-root.open{auto}
  '.backdrop',          // 自带 pointer-events: none / auto 成对
]

describe('悬停才显形的控件 —— 静态守卫', () => {
  // `lastIndexOf` 而不是 `indexOf`：同样的字符串在上面的注释里也出现过（指路用），
  // 用 indexOf 会指到那条注释上，于是「块在不在末尾」这条断言测的是注释的位置。
  const mediaStart = css.lastIndexOf('@media (any-hover: hover)')
  /** 这个 `@media` 块的收尾大括号位置（块内有嵌套规则，要配对数）。 */
  const mediaEnd = (() => {
    let depth = 0
    for (let i = css.indexOf('{', mediaStart); i < css.length; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}' && --depth === 0) return i
    }
    return css.length
  })()

  it('隐藏态的媒体查询块存在，且是文件里最后一条规则（@media 不贡献特异性，只能靠源序取胜）', () => {
    expect(mediaStart).toBeGreaterThan(0)
    // 块之后不许再有任何规则 —— 有的话它可能以同特异性覆盖掉这里的隐藏态。
    expect(css.slice(mediaEnd + 1)).not.toContain('{')
  })

  /**
   * **核心断言。** 任何在媒体查询之外写 `opacity: 0` 的控件，都会在触屏上隐形且可点。
   * 新增第五个悬浮控件而忘了改，这条会红。
   */
  it('媒体查询之外不得再有 opacity:0 的可点控件', () => {
    // **必须扫「整份文件减去这个块」，不能扫「块之前」。** 第一版写的是 `slice(0, mediaStart)`
    // —— 变异验证时把探针 `.zz-mutant-probe { opacity: 0 }` 追加到文件末尾，守卫**没有红**：
    // 块之后新增的控件整个逃掉了。而「在末尾追加一条规则」恰恰是最常见的写法。
    const outside = selectorsWithOpacityZero(css.slice(0, mediaStart) + css.slice(mediaEnd + 1))
      .filter((s) => !OK_OUTSIDE.some((ok) => s.startsWith(ok)))
    expect(outside).toEqual([])
  })

  /**
   * 隐藏时必须连 `pointer-events` 一起关 —— 只关 opacity 就是原来那个 bug；
   * 而只在按钮上关、不在容器上关，触点会落到 `.code-actions`，代码块的横滑照样被吃掉
   *（实测只有「容器与按钮都 none」时 scrollLeft 才动得了）。
   */
  it('隐藏态同时关掉 pointer-events，且连 .code-actions 容器一起关', () => {
    const block = css.slice(mediaStart)
    expect(block).toMatch(/\.code-run\s*\{[^}]*pointer-events:\s*none/)
    expect(block).toMatch(/\.code-actions\s*\{[^}]*pointer-events:\s*none/)
  })

  /**
   * **最容易漏的两条**：它们不含 `:hover`，是「跑起来之后按钮常驻」的那两个**停止键**。
   * 漏了的话，预览跑起来后鼠标一移开就停不掉 —— 正是 styles.css 里那段注释花四行防的回归。
   */
  it('不含 :hover 的两条常驻显形分支也恢复了 pointer-events', () => {
    const block = css.slice(mediaStart)
    expect(block).toContain('.code-wrap.running .code-run')
    expect(block).toContain('.msg-speak.speaking')
  })

  /**
   * 判据必须是 `any-hover` —— `hover: none` 说的是「**主**输入不能悬停」，
   * iPad/Android 接了鼠标时主输入仍是触屏，那种情况下该保留隐藏。
   * `pointer: coarse` 说的是精度（电视遥控 coarse 但有 hover），文不对题。
   */
  it('判据是 any-hover，不是 hover / pointer', () => {
    expect(css).toContain('@media (any-hover: hover)')
    expect(css).not.toContain('@media (hover: none)')
    expect(css).not.toContain('@media (pointer: coarse)')
  })
})
