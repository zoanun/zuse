// 真跑验收换模型这件事：不是「配置解析对了」，是**页面上真的能跑完一轮**。
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

const chip = (await page.textContent('button.chip-btn[title*="切换模型"]').catch(() => '')) ?? ''
ok('顶栏显示的是新默认模型', chip.includes('qwen3.8-max'), chip.trim())

await page.click('textarea')
await page.keyboard.type('只回四个字：配置生效')
await page.keyboard.press('Enter')
let replied = false
for (let i = 0; i < 60; i++) {
  const t = await page.textContent('body')
  if (t.includes('配置生效') && !t.includes('quota exhausted')) { replied = true; break }
  if (t.includes('需要选择模型')) break
  await page.waitForTimeout(1000)
}
ok('真的跑完一轮（模型有回复，不是 quota exhausted）', replied, '')
// ctx 那个 chip **要等一轮跑完、而且要等 context-update 事件到**才出现。
// 探针前两版都在这里读早了：第一版在发消息之前读，第二版在回复文字一出现就读 ——
// 而回复文字是 text-delta 流出来的，用量事件比它晚。两次都报「窗口不是 1M」，
// **两次都是探针的错，不是配置的错**。改成轮询。
let ctx = null
for (let i = 0; i < 15; i++) {
  ctx = (await page.textContent('body')).match(/ctx [\d.]+k \/ ([\d.]+)k/)
  if (ctx) break
  await page.waitForTimeout(1000)
}
ok('上下文窗口是 1M（不是 20K）', ctx !== null && parseFloat(ctx[1]) > 900, ctx ? ctx[0] : '没读到 ctx 显示')
ok('无控制台错误', errs.length === 0, errs.length ? errs.slice(0, 2).join(' | ') : '干净')
await page.screenshot({ path: 'C:/Users/nhn/AppData/Local/Temp/claude/e--ai-study-zuse/62bdc16d-7d61-4c8c-9d21-818ae1677d96/scratchpad/shot-models.png' })
await browser.close()
console.log(bad === 0 ? '\n✓ 通过' : `\n✗ ${bad} 项不合格`)
process.exit(bad === 0 ? 0 : 1)
