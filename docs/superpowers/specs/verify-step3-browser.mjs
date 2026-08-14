// 步骤 3 的真浏览器验证（本仓铁律：测试绿 ≠ 能用）。
// 有头浏览器，用户自己输密码；登录后脚本接管。
// playwright 是**全局**装的，不在本项目 node_modules 里。ESM 的 import 不认 NODE_PATH
// （只有 CJS 的 require 认），所以走 createRequire 直接给绝对路径。
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/nhn/.npm-global/node_modules/playwright')

const SHOT = 'C:/Users/nhn/AppData/Local/Temp/claude/e--ai-study-zuse/62bdc16d-7d61-4c8c-9d21-818ae1677d96/scratchpad'
const log = (...a) => console.log(...a)
// **失败必须影响退出码。** 这里原来只是 `log(...)` —— 一条检查失败时打出「✗ 失败」，
// 脚本照样 exit 0。谁把它接进门禁或者只看退出码，得到的就是一个永远通过的验证脚本。
// 本仓同目录下 verify-touch-controls.mjs / verify-step4-browser.mjs 都是这么做的，
// 只有这一份漏了。
let failed = 0
const ok = (c, msg) => { if (!c) failed++; log(`${c ? '  ✓' : '  ✗ 失败:'} ${msg}`) }

const browser = await chromium.launch({ headless: false, args: ['--window-size=1500,950'] })
const page = await browser.newPage({ viewport: { width: 1460, height: 900 } })

// 把浏览器控制台的错误也收上来 —— 前端崩了的话页面可能只是空白，日志里才有真相。
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('[console] ' + m.text()) })

await page.goto('http://127.0.0.1:4180', { waitUntil: 'domcontentloaded' })
log('\n>>> 浏览器已打开，请在窗口里输入密码登录。脚本会自动继续（最多等 5 分钟）\n')

// 登录成功的标志：输入框出现
await page.locator('textarea').first().waitFor({ timeout: 300_000 })
log('① 登录成功，页面已加载')
ok(pageErrors.length === 0, `页面加载期间 JS 错误 ${pageErrors.length} 条${pageErrors.length ? ': ' + pageErrors.slice(0, 2).join(' | ') : ''}`)

// ── 让模型写一段 Python ────────────────────────────────────────────
const PROMPT = '请只回复一个 python 代码块，不要用任何工具，不要读写文件。代码内容：打印 1 到 5 的平方，然后打印一行中文"计算完成"。'
log('\n② 发一条消息让模型写 Python（不让它用工具）')
const ta = page.locator('textarea').first()
await ta.click()
await ta.fill(PROMPT)
await ta.press('Enter')

// 等运行按钮出现（说明代码块被识别成可执行的 python）
log('   等模型回复并出现「在本机运行」按钮…')
const runBtn = page.locator('button.code-run', { hasText: '在本机运行' }).first()
await runBtn.waitFor({ timeout: 180_000 })
ok(true, '「在本机运行」按钮出现了 —— detect 认出了 python 代码块')
await page.screenshot({ path: `${SHOT}/shot-1-button.png` })

// ── 点运行 ───────────────────────────────────────────────────────
log('\n③ 点「在本机运行」')
await runBtn.click()

// 确认框
const confirmCard = page.locator('.confirm-card')
await confirmCard.waitFor({ timeout: 15_000 })
const confirmMsg = await confirmCard.locator('.confirm-msg').textContent()
ok(!!confirmMsg && confirmMsg.includes('真的执行'), `确认框文案: ${JSON.stringify(confirmMsg)}`)
await page.screenshot({ path: `${SHOT}/shot-2-confirm.png` })

log('\n④ 确认执行')
await confirmCard.getByRole('button', { name: '就在我电脑上运行' }).click()

// ── 右栏出现输出 ──────────────────────────────────────────────────
const rail = page.locator('.rail-exec')
await rail.waitFor({ timeout: 20_000 })
ok(true, '右栏出现了运行面板 .rail-exec')

// 等结束文案
await page.locator('.rail-exec .rx-note').filter({ hasText: /运行结束|没能启动|已停止/ }).first()
  .waitFor({ timeout: 90_000 })

const outText = await page.locator('.rail-exec .rx-out').textContent().catch(() => null)
const errText = await page.locator('.rail-exec .rx-err').textContent().catch(() => null)
const noteText = await page.locator('.rail-exec .rx-note').first().textContent()
log(`\n   stdout: ${JSON.stringify(outText)}`)
log(`   stderr: ${JSON.stringify(errText)}`)
log(`   结束文案: ${JSON.stringify(noteText)}`)

ok(!!outText && outText.includes('计算完成'), '输出里有中文「计算完成」（中文不乱码）')
ok(!!outText && /\b25\b/.test(outText), '输出里有 25（5 的平方，说明代码真的跑了）')
ok(!!noteText && noteText.includes('运行结束'), '结束文案是「运行结束」')
await page.screenshot({ path: `${SHOT}/shot-3-output.png` })

// ── 布局：右栏没被挤坏 ───────────────────────────────────────────
log('\n⑤ 布局检查（改 CSS 那条相邻选择器的实际效果）')
const box = await rail.boundingBox()
ok(!!box && box.height > 100, `.rail-exec 高度 ${Math.round(box?.height ?? 0)}px（<100 说明被挤扁了）`)
const railBox = await page.locator('aside.rail').boundingBox()
const chatBox = await page.locator('main.chat').boundingBox().catch(() => null)
log(`   右栏 x=${Math.round(railBox?.x ?? 0)} w=${Math.round(railBox?.width ?? 0)}；聊天区 w=${Math.round(chatBox?.width ?? 0)}`)
ok(!!chatBox && chatBox.width > 400, `聊天区宽度 ${Math.round(chatBox?.width ?? 0)}px（没被右栏挤没）`)

// ── 停止按钮在结束后应该消失 ──────────────────────────────────────
const stopVisible = await page.locator('.rail-exec-bar button', { hasText: '停止' }).isVisible().catch(() => false)
ok(!stopVisible, `跑完之后「停止」按钮已隐藏（当前可见=${stopVisible}）`)

// ── 关闭面板 = 收起 ───────────────────────────────────────────────
log('\n⑥ 点「关闭」')
await page.locator('.rail-exec-bar button', { hasText: '关闭' }).click()
await rail.waitFor({ state: 'detached', timeout: 10_000 })
ok(true, '运行面板已关闭')

ok(pageErrors.length === 0, `全过程 JS 错误 ${pageErrors.length} 条`)
if (pageErrors.length) pageErrors.slice(0, 5).forEach((e) => log('     ' + e))

writeFileSync(`${SHOT}/verify-result.txt`, `out=${outText}\nerr=${errText}\nnote=${noteText}\nerrors=${pageErrors.length}`)
log('\n截图: shot-1-button.png / shot-2-confirm.png / shot-3-output.png')
log(failed === 0 ? '\n全过。' : `\n${failed} 条未通过。`)
log('跑完，5 秒后关闭浏览器。')
await page.waitForTimeout(5000)
await browser.close()
process.exit(failed === 0 ? 0 : 1)
