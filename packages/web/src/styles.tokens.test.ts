import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * 设计令牌的两条护栏。**都从 styles.css 现读现算**，不写死期望值 ——
 * 写死的话改了 css 忘了改测试，测试就成了摆设。
 *
 * 回溯审计发现的实际问题：
 *  1. `--fg` / `--fg-2` / `--hover` / `--danger` 四个变量**从来没被定义过**。
 *     `color: var(--fg)` 这种没兜底的写法在 CSS 里不是「用默认色」，是
 *     **整条声明在计算值阶段作废** → 继承父元素颜色，看起来像随机生效。
 *     `--hover` 那个更具体：兜底写的是 `rgb(0 0 0 / 6%)`，深色主题下在深底上
 *     叠黑 —— 实测对比度 1.013:1，run 菜单的 hover 肉眼根本看不出来。
 *  2. `--faint` 在浅色主题下对三种底色是 2.26 / 2.38 / 2.57:1，**连大字的 3:1 都不到**，
 *     而它的 55 个引用点字号全在 9–14.5px（都是「正文」档，要求 4.5:1）。
 */

// 与 styles.hoverControls.test.ts 用同一个写法：jsdom 环境下
// `new URL('.', import.meta.url)` 会解析成非 file 协议而抛错。
const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8')

/** 抽出某个主题块里定义的所有 `--x: value`。 */
function themeTokens(selector: string): Map<string, string> {
  const start = CSS.indexOf(selector)
  expect(start, `找不到主题块 ${selector}`).toBeGreaterThan(-1)
  const open = CSS.indexOf('{', start)
  const close = CSS.indexOf('}', open)
  const body = CSS.slice(open + 1, close)
  const out = new Map<string, string>()
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim())
  return out
}

const light = themeTokens(':root[data-theme="light"]')
const dark = themeTokens(':root[data-theme="dark"]')

describe('CSS 变量：引用的都得定义过', () => {
  it('没有任何 var(--x) 引用一个从未定义的变量', () => {
    const used = new Set<string>()
    for (const m of CSS.matchAll(/var\((--[a-z0-9-]+)/g)) used.add(m[1]!)

    const defined = new Set<string>()
    for (const m of CSS.matchAll(/(?:^|[;{\s])(--[a-z0-9-]+)\s*:/gm)) defined.add(m[1]!)

    const missing = [...used].filter((v) => !defined.has(v)).sort()
    expect(missing, `这些变量被 var() 引用但从未定义：${missing.join(', ')}`).toEqual([])
  })

  it('两套主题定义的变量名完全一致（漏一个就是那一档主题下悄悄失效）', () => {
    const l = [...light.keys()].sort()
    const d = [...dark.keys()].sort()
    expect(d).toEqual(l)
  })
})

// --- WCAG 对比度 -------------------------------------------------------------

function relLuminance(hex: string): number {
  const s = hex.replace('#', '')
  const ch = [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255)
  const lin = ch.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!
}

function contrast(a: string, b: string): number {
  const la = relLuminance(a)
  const lb = relLuminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** 前景令牌 × 背景令牌，全都要过 AA 正文档 4.5:1。 */
const FG = ['--text', '--muted', '--faint']
const BG = ['--ground', '--surface', '--surface-2']

describe('WCAG AA 对比度（正文 4.5:1）', () => {
  for (const [name, tokens] of [['浅色', light], ['深色', dark]] as const) {
    for (const fg of FG) {
      for (const bg of BG) {
        it(`${name}：${fg} on ${bg} ≥ 4.5:1`, () => {
          const f = tokens.get(fg)
          const b = tokens.get(bg)
          expect(f, `${name}主题缺 ${fg}`).toBeDefined()
          expect(b, `${name}主题缺 ${bg}`).toBeDefined()
          // 只处理 #RRGGBB；将来若改成 rgba/color-mix，这条要连算法一起改，别直接跳过。
          expect(f, `${fg} 不是 #RRGGBB，本测试算不了`).toMatch(/^#[0-9A-Fa-f]{6}$/)
          expect(b, `${bg} 不是 #RRGGBB，本测试算不了`).toMatch(/^#[0-9A-Fa-f]{6}$/)
          const r = contrast(f!, b!)
          expect(r, `实际 ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
        })
      }
    }
  }

  it('三档前景仍然拉得开（faint 与 muted 不能挤成一个颜色）', () => {
    for (const [name, t] of [['浅色', light], ['深色', dark]] as const) {
      const r = contrast(t.get('--faint')!, t.get('--muted')!)
      // 提高 faint 去够 4.5 会把它顶到原来 muted 的位置；muted 必须跟着让开，
      // 否则「第三档」名存实亡。1.3 是肉眼还分得出的下限。
      expect(r, `${name}：faint 与 muted 只差 ${r.toFixed(2)}`).toBeGreaterThan(1.3)
    }
  })
})

describe('--hover 在深色下必须是白色叠加', () => {
  it('深色主题的 --hover 不是黑色叠加（深底叠黑 = 什么都没发生）', () => {
    const h = dark.get('--hover')
    expect(h).toBeDefined()
    expect(h, `深色 --hover = ${h}`).toMatch(/rgba\(\s*255\s*,\s*255\s*,\s*255/)
  })
})
