// 真浏览器验收权限卡片的两件事：
//   ① 「必须确认」档要**看得见内容**（Memory(save) 原来只显示「Memory · save」）
//   ② 那一档要**藏掉「本次会话」「始终」**（服务端什么都不记，点了与「允许」等价）
// 全程点「拒绝」，不真的写任何东西。
const { chromium } = await import('file:///C:/Users/nhn/.npm-global/node_modules/playwright/index.mjs')
const base = 'http://127.0.0.1:4180'
let bad = 0
const ok = (n, c, d) => { console.log(`${c ? '✓' : '✗'} ${n} —— ${d}`); if (!c) bad++ }

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const errs = []
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
await page.goto(base + '/', { waitUntil: 'domcontentloaded' })
const pw = await page.$('input[type=password]')
if (pw) { await pw.fill('zuonaok'); await page.keyboard.press('Enter'); await page.waitForTimeout(2500) }

for (let i = 0; i < 4 && !(await page.$('.bypass-banner')); i++) {
  const btn = await page.$('button.chip-btn:has-text("权限")')
  if (!btn) break
  await btn.click(); await page.waitForTimeout(900)
}
ok('已切到全自主档', (await page.$('.bypass-banner')) !== null, '')

await page.click('textarea')
await page.keyboard.type('用 Memory 工具保存一条记忆：type 用 project，content 写「探针专用的一条记忆」。不要解释，直接存。')
await page.keyboard.press('Enter')

let card = null
for (let i = 0; i < 60; i++) { card = await page.$('.perm'); if (card) break; await page.waitForTimeout(1000) }
ok('全自主档下存记忆仍要确认', card !== null, card ? '卡片在' : '没弹 —— 这一档失效了')
if (card) {
  const text = (await card.innerText()).replace(/\s+/g, ' ')
  ok('卡片上看得见要写什么（原来只有「Memory · save」）', text.includes('探针专用的一条记忆'), text.slice(0, 150))
  const names = await page.$$eval('.perm .actions button', (bs) => bs.map((b) => b.textContent))
  ok('藏掉了「本次会话」和「始终」', !names.includes('本次会话') && !names.includes('始终'), JSON.stringify(names))
  ok('允许/拒绝还在', names.includes('允许') && names.includes('拒绝'), JSON.stringify(names))
  ok('说明了为什么每次都问', (await page.$('.perm-note')) !== null, '')
  await page.click('.perm .actions button:has-text("拒绝")')
  await page.waitForTimeout(2000)
}
ok('无控制台错误', errs.length === 0, errs.length ? errs.slice(0, 2).join(' | ') : '干净')
await page.screenshot({ path: 'C:/Users/nhn/AppData/Local/Temp/claude/e--ai-study-zuse/62bdc16d-7d61-4c8c-9d21-818ae1677d96/scratchpad/shot-perm-card.png' })
await browser.close()
console.log(bad === 0 ? '\n✓ 通过' : `\n✗ ${bad} 项不合格`)
process.exit(bad === 0 ? 0 : 1)
