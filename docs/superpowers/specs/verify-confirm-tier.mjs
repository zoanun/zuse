// 真跑验证「必须确认」档：开着全自主（bypass）时，写 ZUSE.md 仍必须弹卡片。
// 这条是 features.md 里我刚写下的一句话 —— 没实跑过就不许写。
// 最后一律点「拒绝」，不在仓库里留文件。
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

// 切到全自主：权限 chip 循环点，直到全自主横幅出现
for (let i = 0; i < 4 && !(await page.$('.bypass-banner')); i++) {
  const btn = await page.$('button.chip-btn:has-text("权限")')
  if (!btn) break
  await btn.click()
  await page.waitForTimeout(900)
}
const inBypass = (await page.$('.bypass-banner')) !== null
ok('已切到全自主档', inBypass, inBypass ? '全自主横幅在' : '没切成 —— 后面的断言无意义')
if (!inBypass) { await browser.close(); process.exit(2) }

await page.click('textarea')
await page.keyboard.type('用 Write 工具在当前目录创建 ZUSE.md，内容就一行：探针。不要解释，直接写。')
await page.keyboard.press('Enter')

let card = null
for (let i = 0; i < 60; i++) {
  card = await page.$('.perm')
  if (card) break
  await page.waitForTimeout(1000)
}
ok('全自主档下写 ZUSE.md 仍然弹了确认卡片', card !== null,
  card ? (await card.innerText()).replace(/\s+/g, ' ').slice(0, 120) : '没弹 —— 那句话是假的，必须从 features.md 删掉')
await page.screenshot({ path: 'C:/Users/nhn/AppData/Local/Temp/claude/e--ai-study-zuse/62bdc16d-7d61-4c8c-9d21-818ae1677d96/scratchpad/shot-confirm-tier.png' })
if (card) {
  await page.click('.perm .actions button:has-text("拒绝")')
  await page.waitForTimeout(1500)
}
ok('无控制台错误', errs.length === 0, errs.length ? errs.slice(0, 2).join(' | ') : '干净')
await browser.close()
console.log(bad === 0 ? '\n✓ 通过' : `\n✗ ${bad} 项不合格`)
process.exit(bad === 0 ? 0 : 1)
