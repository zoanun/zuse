// 步骤 4 的真浏览器验证。
//
// **含一条「看得见吗」的断言，不只是「DOM 里有吗」。**
// 第一版就栽在这上面：脚本名是白字白底、对比度 1.00:1，肉眼一个字都看不到，
// 而测试全绿 —— 因为 `allTextContents()` 查的是 DOM 文本，不查可见性。
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/nhn/.npm-global/node_modules/playwright')

const BASE = 'http://127.0.0.1:4180'
const PW = process.env.ZUSE_DEV_PASSWORD ?? 'zuonaok'   // 开发期密码，用户授权；只在本机用
const log = (...a) => console.log(...a)
const ok = (c, msg) => { console.log(`${c ? '  ✓' : '  ✗ 失败:'} ${msg}`); if (!c) process.exitCode = 1 }

/** 相对亮度对比度（WCAG 那套的简化版）。正文低于 4.5 就是读不了。 */
function contrast(fg, bg) {
  const parse = (c) => (c.match(/[\d.]+/g) || []).map(Number)
  const chan = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  const lum = ([r, g, b]) => 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)
  const a = lum(parse(fg)), b = lum(parse(bg))
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1460, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
// 409 是**确认流程本身**（第一次 POST 不带 confirmed → 服务端 409 → 弹确认框），
// 浏览器把所有 4xx 都记成 console error。不是缺陷，排除掉。
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('409')) errors.push('[console] ' + m.text()) })

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
if (!(await page.locator('textarea').first().isVisible().catch(() => false))) {
  await page.locator('input').first().fill(PW)
  await page.locator('button', { hasText: '登录' }).first().click()
}
await page.locator('textarea').first().waitFor({ timeout: 30_000 })
log('① 登录')

log('\n② 顶部的「▶ 运行 ▾」')
const runChip = page.locator('button.chip-btn', { hasText: '运行' }).first()
await runChip.waitFor({ timeout: 15_000 })
ok(true, '按钮在')

log('\n③ 菜单内容')
await runChip.click()
await page.locator('.run-menu').waitFor({ timeout: 10_000 })
const names = await page.locator('.run-menu-item .rm-name').allTextContents()
ok(names.length > 0, `列出 ${names.length} 条脚本: ${names.join(', ')}`)
ok(names.includes('typecheck'), '包含本仓真实脚本 typecheck')

log('\n④ **看得见吗** —— 不只是 DOM 里有')
const vis = await page.evaluate(() => {
  const menu = document.querySelector('.run-menu')
  const name = document.querySelector('.run-menu-item .rm-name')
  const cmd = document.querySelector('.run-menu-item .rm-cmd')
  const bg = (el) => {
    // 往上找第一个非透明背景 —— 元素自己多半是 transparent
    for (let e = el; e; e = e.parentElement) {
      const c = getComputedStyle(e).backgroundColor
      if (c && !/rgba?\(0, 0, 0, 0\)|transparent/.test(c)) return c
    }
    return 'rgb(255,255,255)'
  }
  return {
    nameColor: name ? getComputedStyle(name).color : null,
    cmdColor: cmd ? getComputedStyle(cmd).color : null,
    bg: menu ? bg(menu) : null,
  }
})
const cName = contrast(vis.nameColor, vis.bg)
const cCmd = contrast(vis.cmdColor, vis.bg)
log(`   脚本名 ${vis.nameColor} / 背景 ${vis.bg} → 对比度 ${cName.toFixed(2)}:1`)
log(`   命令   ${vis.cmdColor} → 对比度 ${cCmd.toFixed(2)}:1`)
ok(cName >= 4.5, `脚本名对比度 ${cName.toFixed(2)}:1（<4.5 就是读不了；曾经是 1.00 —— 白字白底）`)
ok(cCmd >= 3, `命令正文对比度 ${cCmd.toFixed(2)}:1（次要文字，放宽到 3）`)

log('\n⑤ 跑一条真实脚本（typecheck，会结束，便于断言）')
await page.locator('.run-menu-item', { hasText: 'typecheck' }).first().click()
await page.locator('.rail-exec').waitFor({ timeout: 20_000 })
const hint = await page.locator('.rx-hint-bar').textContent().catch(() => null)
ok(!!hint && hint.includes('没有键盘输入'), `常驻提示在: ${JSON.stringify(hint)}`)
ok((await page.locator('.rail-exec .rx-title').textContent()) === 'typecheck', '标题是脚本名')

await page.locator('.rail-exec .rx-note').filter({ hasText: /运行结束|没能启动|已停止/ }).first()
  .waitFor({ timeout: 240_000 })
const out = (await page.locator('.rail-exec .rx-out').textContent().catch(() => '')) || ''
const note = await page.locator('.rail-exec .rx-note').first().textContent()
ok(out.length > 0, `有输出（${out.length} 字符）`)
ok(/运行结束/.test(note || ''), `结束文案: ${JSON.stringify(note)}`)

log('\n⑥ 布局与错误')
const chat = await page.locator('main.chat').boundingBox().catch(() => null)
ok(!!chat && chat.width > 400, `聊天区 ${Math.round(chat?.width ?? 0)}px，没被挤没`)
ok(errors.length === 0, `JS 错误 ${errors.length} 条${errors.length ? ': ' + errors.slice(0, 2).join(' | ') : ''}`)

await browser.close()
log(process.exitCode ? '\n有失败项。' : '\n全过。')
