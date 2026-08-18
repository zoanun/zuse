// 真跑验收：全自主档下调 MCP 工具仍要确认（修之前是无条件放行）。
// 全程点「拒绝」，什么都不真的执行。
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
const inBypass = (await page.$('.bypass-banner')) !== null
ok('已切到全自主档', inBypass, inBypass ? '全自主横幅在' : '没切成，后面无意义')
if (!inBypass) { await browser.close(); process.exit(2) }

await page.click('textarea')
// **不能用 mcp__everything__echo** —— 本机 .zuse/settings.local.jsonc 的 allow 表里
// 正好有这一条裸规则，那是「用户显式表态」，本档刻意放行。第一版探针挑的就是它，
// 于是测了一个**被设计成会放行**的路径，还把结果当成「修没生效」。
await page.keyboard.type('用 mcp__everything__get-env 工具查一下环境变量。不要解释，直接调用。')
await page.keyboard.press('Enter')

let card = null
for (let i = 0; i < 60; i++) { card = await page.$('.perm'); if (card) break; await page.waitForTimeout(1000) }
ok('全自主档下 MCP 工具仍然弹确认卡（修之前是无条件放行）', card !== null,
  card ? (await card.innerText()).replace(/\s+/g, ' ').slice(0, 130) : '没弹 —— 还是白卡放行')
if (card) {
  const reason = await page.$('.perm-reason')
  ok('卡片说清楚为什么', reason !== null, reason ? await reason.innerText() : '没有 .perm-reason')
  await page.click('.perm .actions button:has-text("拒绝")')
  await page.waitForTimeout(2000)
}
ok('无控制台错误', errs.length === 0, errs.length ? errs.slice(0, 2).join(' | ') : '干净')
await page.screenshot({ path: 'C:/Users/nhn/AppData/Local/Temp/claude/e--ai-study-zuse/62bdc16d-7d61-4c8c-9d21-818ae1677d96/scratchpad/shot-mcp.png' })
await browser.close()
console.log(bad === 0 ? '\n✓ 通过' : `\n✗ ${bad} 项不合格`)
process.exit(bad === 0 ? 0 : 1)
