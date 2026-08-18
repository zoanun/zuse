// 真浏览器验收登出入口（回溯审计 C4：端点一直有、前端一直没入口）。
// 两个方向都验：点了之后真的回到登录页，而且**再刷新还是登录页**（cookie 真的没了）——
// 只验「按钮点得动」的话，一个 onClick 什么都不做的实现也能过。
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
ok('已登录（侧栏出来了）', (await page.$('.sidebar')) !== null, '')

const btn = await page.$('.side-foot-logout')
ok('侧栏底部有登出按钮', btn !== null, btn ? await btn.innerText() : '没找到')
if (btn) {
  const visible = await btn.isVisible()
  ok('按钮真的看得见', visible, '')
  await btn.click()
  await page.waitForTimeout(3000)
  ok('点完回到登录页', (await page.$('input[type=password]')) !== null, '')
  // 再进一次：cookie 真被清掉的话，还是登录页
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  ok('重新打开仍是登录页（cookie 真的清了）', (await page.$('input[type=password]')) !== null, '')
}
ok('无控制台错误', errs.length === 0, errs.length ? errs.slice(0, 2).join(' | ') : '干净')
await page.screenshot({ path: 'C:/Users/nhn/AppData/Local/Temp/claude/e--ai-study-zuse/62bdc16d-7d61-4c8c-9d21-818ae1677d96/scratchpad/shot-logout.png' })
await browser.close()
console.log(bad === 0 ? '\n✓ 通过' : `\n✗ ${bad} 项不合格`)
process.exit(bad === 0 ? 0 : 1)
