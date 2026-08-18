// 补上 73c51c7 明写的那条欠账：「外部目录 → 提示条出现」的回归证据。
//
// 上一轮失败的原因是**用 API 建会话，界面不会切过去**。所以这次走真实路径：
// 点 DirPicker → 选盘符 → 选目录 → 「使用此目录」。这条路才是用户实际会走的。
//
// 探针目录里放了一份**敌意** settings.json（allow: rm -rf * + defaultMode: bypass），
// 于是这个脚本同时是安全验证：未信任时那两条必须**不生效**，信任后才生效。
//
// 路径一律用正斜杠：Bash heredoc 会把两个反斜杠吃成一个，JS 于是把 t 前面那个
// 反斜杠解析成制表符。探针曾因此对着一个不存在的路径撤销信任，400 被静默吞掉，
// 让下一次跑带着「上一轮的信任」开始 —— 变异验证的结论直接作废。
const { chromium } = await import('file:///C:/Users/nhn/.npm-global/node_modules/playwright/index.mjs')

const PROBE = 'E:/trust-probe'
const base = 'http://127.0.0.1:4180'

const login = await fetch(base + '/api/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'zuonaok' }),
})
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
const untrust = () => fetch(base + '/api/trusted-roots', {
  method: 'POST', headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ root: PROBE, trusted: false }),
})

// 前置撤销**必须检查状态码**：静默失败会让后面每一条断言都在脏状态上跑
const pre = await untrust()
if (!pre.ok) {
  console.error('✗ 前置撤销信任失败：', pre.status, await pre.text())
  process.exit(2)
}

let bad = 0
const ok = (n, c, d) => { console.log(`${c ? '✓' : '✗'} ${n} —— ${d}`); if (!c) bad++ }

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const errs = []
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
await page.goto(base + '/', { waitUntil: 'domcontentloaded' })
const pw = await page.$('input[type=password]')
if (pw) { await pw.fill('zuonaok'); await page.keyboard.press('Enter'); await page.waitForTimeout(2500) }

// ---- 走真实路径：DirPicker ----
await page.click('.dirpick-btn')
await page.waitForSelector('.dirpick-pop', { timeout: 5000 })
const drives = await page.$$eval('.dirpick-drive', (bs) => bs.map((b) => b.textContent))
ok('DirPicker 列出了盘符', drives.some((d) => d.startsWith('E:')), JSON.stringify(drives))
await page.click('.dirpick-drive:has-text("E:")')
await page.waitForTimeout(800)
const entry = await page.$('.dirpick-dir:has(.dirpick-name:text-is("trust-probe"))')
ok('E: 下能看到 trust-probe', entry !== null, entry ? '在' : '没找到')
if (entry) await entry.click()
await page.waitForTimeout(800)
const cur = await page.textContent('.dirpick-cur')
ok('已进入探针目录', (cur ?? '').toLowerCase().includes('trust-probe'), cur ?? '(空)')
await page.click('.dirpick-ok')
await page.waitForTimeout(3000)

// ---- 第一条断言：这就是欠的那条证据 ----
const notice = await page.$('.trust-notice')
ok('未信任的外部目录 → 提示条出现', notice !== null, notice ? '.trust-notice 在' : '没出现')
if (notice) {
  ok('提示条真的看得见（不只是 DOM 里有）', await notice.isVisible(),
    (await notice.innerText()).replace(/\s+/g, ' ').slice(0, 90))
}
// ---- 安全断言：未信任时那份敌意配置的「放宽」半边不得生效 ----
const bypassBefore = await page.$('.bypass-banner')
ok('未信任时 defaultMode:bypass 没生效', bypassBefore === null,
  bypassBefore ? '**全自主横幅出现了 —— 敌意配置被吃进去了**' : '没有全自主横幅')

// ---- 第二条方向：点了信任之后 ----
if (notice) {
  await page.click('.trust-notice-btn')
  await page.waitForTimeout(3500)
  ok('点了「信任」之后提示条消失', (await page.$('.trust-notice')) === null, '')
  const roots = await page.evaluate(async () => (await (await fetch('/api/trusted-roots')).json()).roots)
  ok('信任真的落盘了', roots.some((r) => r.toLowerCase().includes('trust-probe')), JSON.stringify(roots))
  const bypassAfter = await page.$('.bypass-banner')
  ok('信任之后 defaultMode:bypass 生效了', bypassAfter !== null,
    bypassAfter ? '全自主横幅出现（预期）' : '没出现 —— 信任了却没放宽，闸门只有一半')
}
ok('无控制台错误', errs.length === 0, errs.length ? errs.slice(0, 2).join(' | ') : '干净')

await page.screenshot({ path: 'C:/Users/nhn/AppData/Local/Temp/claude/e--ai-study-zuse/62bdc16d-7d61-4c8c-9d21-818ae1677d96/scratchpad/shot-trust-dirpicker.png' })
await browser.close()
const post = await untrust()
console.log(post.ok ? '· 已撤销探针目录的信任' : `· ⚠ 收尾撤销失败 ${post.status} —— 手工清 ~/.zuse/trusted-roots.json`)
console.log(bad === 0 ? '\n✓ 真浏览器验收通过' : `\n✗ ${bad} 项不合格`)
process.exit(bad === 0 ? 0 : 1)
