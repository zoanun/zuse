// 真浏览器验收「受信目录」面板：列得出、标得出陈旧条目、撤销真的生效。
// 两个方向都验 —— 只验「点了之后消失」的话，一个「永远不显示」的实现也能过。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { chromium } = await import('file:///C:/Users/nhn/.npm-global/node_modules/playwright/index.mjs')
const base = 'http://127.0.0.1:4180'
let bad = 0
const ok = (n, c, d) => { console.log(`${c ? '✓' : '✗'} ${n} —— ${d}`); if (!c) bad++ }

const login = await fetch(base + '/api/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'zuonaok' }),
})
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
const post = (b) => fetch(base + '/api/trusted-roots', {
  method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(b),
})
// 造两条：一条目录还在，一条目录已删（陈旧条目）
const live = mkdtempSync(join(tmpdir(), 'zuse-live-'))
const dead = mkdtempSync(join(tmpdir(), 'zuse-dead-'))
const r1 = await post({ root: live }), r2 = await post({ root: dead })
if (!r1.ok || !r2.ok) { console.error('前置信任失败', r1.status, r2.status); process.exit(2) }
rmSync(dead, { recursive: true, force: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const errs = []
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
await page.goto(base + '/', { waitUntil: 'domcontentloaded' })
const pw = await page.$('input[type=password]')
if (pw) { await pw.fill('zuonaok'); await page.keyboard.press('Enter'); await page.waitForTimeout(2500) }

// 打开设置抽屉 → 受信目录
await page.click('button:has-text("管理"), .chip-btn:has-text("管理"), [title*="管理"]').catch(() => {})
await page.waitForTimeout(600)
if (!(await page.$('.manage-nav-item'))) {
  // 抽屉入口换过位置的话，从菜单进
  const menu = await page.$('[aria-label="菜单"], .icon-btn')
  if (menu) { await menu.click(); await page.waitForTimeout(500) }
}
const navOk = await page.$('.manage-nav-item:has-text("受信目录")')
ok('抽屉里有「受信目录」这一项', navOk !== null, navOk ? '在' : '没找到 —— 入口没接上')
if (navOk) {
  await navOk.click()
  await page.waitForTimeout(1200)
  const rows = await page.$$('.trust-row')
  ok('列出了受信目录', rows.length >= 2, `${rows.length} 行`)
  const stale = await page.$$('.trust-row.missing')
  ok('已删掉的那个被标成陈旧', stale.length === 1, `${stale.length} 条陈旧`)
  if (stale.length === 1) {
    const txt = await stale[0].innerText()
    ok('陈旧标记文案看得见', txt.includes('目录已不存在'), txt.replace(/\s+/g, ' ').slice(0, 80))
    // 撤销它
    await stale[0].$('button').then((b) => b.click())
    await page.waitForTimeout(1500)
    ok('撤销之后那一行没了', (await page.$$('.trust-row.missing')).length === 0, '')
    const roots = await page.evaluate(async () => (await (await fetch('/api/trusted-roots')).json()).roots)
    ok('撤销真的落盘了', !roots.some((r) => r.includes('zuse-dead-')), JSON.stringify(roots.slice(-3)))
  }
}
ok('无控制台错误', errs.length === 0, errs.length ? errs.slice(0, 2).join(' | ') : '干净')
await page.screenshot({ path: 'C:/Users/nhn/AppData/Local/Temp/claude/e--ai-study-zuse/62bdc16d-7d61-4c8c-9d21-818ae1677d96/scratchpad/shot-trust-panel.png' })
await browser.close()
await post({ root: live, trusted: false }); rmSync(live, { recursive: true, force: true })
await post({ root: dead, trusted: false })
console.log(bad === 0 ? '\n✓ 通过' : `\n✗ ${bad} 项不合格`)
process.exit(bad === 0 ? 0 : 1)
