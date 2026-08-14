// 触屏/桌面上「悬停才显形」的控件 —— 真浏览器验证（回溯审计 E1）。
//
// **判据必须是命中测试，不能只看 opacity。** 第一版设计的失败形态恰好是
// 「opacity=1、boundingBox 非空、但 pointer-events: none」—— 只断言前两项的话，
// 一个在手机上完全点不着的按钮会全绿通过。所以这里用 `document.elementFromPoint`
// 在**静止态**测量：不用 `page.tap()` 当判据，因为 chromium/webkit 在 tap 时会先给
// 祖先合成 `:hover`，反而把 hover 分支激活了 —— 那正好把本设计声明「不能指望」的东西
// 当成了判据。
//
// **失败必须 exit 1。** 本仓已有四个「无论成败都 exit 0」的验证脚本（回溯审计 A 段），
// 别再添一个。
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium, webkit, devices } = require('C:/Users/nhn/.npm-global/node_modules/playwright')

const BASE = process.env.ZUSE_BASE ?? 'http://127.0.0.1:4180'
const PW = process.env.ZUSE_DEV_PASSWORD ?? 'zuonaok'
let failed = 0
const ok = (cond, msg, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}${extra ? '  ' + extra : ''}`)
  if (!cond) failed++
}

async function login(page) {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  const pw = await page.$('input[placeholder="密码"]')
  if (pw) { await pw.fill(PW); await page.click('button:has-text("登录")'); await page.waitForTimeout(2500) }
}

/** 注入一个代码块 + 一条 agent 消息 —— 不依赖模型，验证的是样式不是对话。 */
const seed = (page) => page.evaluate(() => {
  const host = document.querySelector('.stream') ?? document.body
  const d = document.createElement('div')
  d.className = 'msg agent'
  d.innerHTML = '<div class="text"><div class="code-wrap"><div class="code-actions">' +
    '<button class="code-copy">复制</button><button class="code-run">▶ 运行</button></div>' +
    '<pre><code>' + 'x'.repeat(400) + '</code></pre></div></div>' +
    '<div class="msg-actions"><button class="msg-copy">复制</button>' +
    '<button class="msg-copy msg-retry">重试</button></div>'
  host.appendChild(d)
})

const probe = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s)
  if (!el) return null
  const cs = getComputedStyle(el)
  const r = el.getBoundingClientRect()
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
  return { opacity: cs.opacity, pe: cs.pointerEvents, w: Math.round(r.width), h: Math.round(r.height), self: hit === el }
}, sel)

console.log('① 触屏（真 webkit + iPhone 13 描述符）—— 必须看得见**且**点得着')
{
  const b = await webkit.launch()
  const p = await (await b.newContext({ ...devices['iPhone 13'] })).newPage()
  await login(p); await seed(p)
  for (const sel of ['.code-run', '.code-copy', '.msg-copy', '.msg-retry']) {
    const r = await probe(p, sel)
    ok(r !== null, `${sel} 在`)
    ok(r?.opacity === '1', `${sel} 看得见`, JSON.stringify(r))
    ok(r?.pe !== 'none' && r?.self === true, `${sel} 点得着（命中测试落在它自己身上）`)
    ok((r?.w ?? 0) > 20 && (r?.h ?? 0) > 10, `${sel} 有可点面积`)
  }
  await b.close()
}

console.log('\n② 桌面 —— 隐藏时既看不见也点不着，代码块的横滑不被吃掉')
{
  const b = await chromium.launch()
  const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
  await login(p); await seed(p)
  const hidden = await probe(p, '.code-run')
  ok(hidden?.opacity === '0', '静止时不可见', JSON.stringify(hidden))
  ok(hidden?.pe === 'none' && hidden?.self === false, '静止时命中测试**穿透**到代码块（不吃横滑）')

  await p.hover('.code-wrap'); await p.waitForTimeout(400)
  const hov = await probe(p, '.code-run')
  ok(hov?.opacity === '1' && hov?.pe === 'auto' && hov?.self === true, 'hover 后可见且可点', JSON.stringify(hov))

  // **最容易漏的一条**：预览跑起来后按钮常驻，那时它是「停止」键。
  // 只恢复 opacity 不恢复 pointer-events 的话，鼠标一移开就停不掉。
  await p.evaluate(() => document.querySelector('.code-wrap').classList.add('running'))
  await p.mouse.move(5, 5); await p.waitForTimeout(400)
  const run = await probe(p, '.code-run')
  ok(run?.opacity === '1' && run?.pe === 'auto' && run?.self === true, '.running + 鼠标移开仍可点（停止键）', JSON.stringify(run))
  await b.close()
}

console.log(failed === 0 ? '\n全过。' : `\n${failed} 条未通过。`)
process.exit(failed === 0 ? 0 : 1)
