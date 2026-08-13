// 把之前标着「未实测」的几条，能测的都测掉。
// 其中第 ① 条最重要：我用「EventSource 会自动重连」论证了「不用 EventSource、改用 fetch 流」
// 这个架构决定，但**从没真跑过**。按规范推的结论不算数。
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/nhn/.npm-global/node_modules/playwright')

const log = (...a) => console.log(...a)
const ok = (c, msg) => log(`${c ? '  ✓' : '  ✗'} ${msg}`)

// ── 起一个最小 SSE 服务器，模拟 run 服务的行为：推几条，然后 res.end() ──
let connects = 0
const srv = createServer((req, res) => {
  if (req.url.startsWith('/sse')) {
    connects++
    const n = connects
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
    res.write(`data: ${JSON.stringify({ conn: n, type: 'chunk' })}\n\n`)
    res.write(`data: ${JSON.stringify({ conn: n, type: 'end' })}\n\n`)
    // **和 run 服务一样：end 之后主动关连接**
    res.end()
    return
  }
  if (req.url.startsWith('/slow')) {
    // 永不结束的流，用来测「同时能开几条」
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: open\n\n')
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><meta charset=utf-8><body>probe</body>')
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${srv.address().port}`
log(`探针服务器: ${base}\n`)

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await page.goto(base)

// ── ① EventSource 在服务端关连接后会不会自动重连 ──────────────────
log('① EventSource：服务端 end 之后关连接，它会不会自己重连')
{
  const before = connects
  const result = await page.evaluate(async (b) => {
    const seen = []
    const es = new EventSource(b + '/sse')
    es.onmessage = (e) => seen.push(JSON.parse(e.data))
    await new Promise((r) => setTimeout(r, 8000))   // 等 8 秒，看它重连几次
    es.close()
    return seen
  }, base)
  const conns = [...new Set(result.map((r) => r.conn))]
  log(`   8 秒内服务端收到 ${connects - before} 次连接；客户端收到 ${result.length} 条消息，来自连接 #${conns.join(', #')}`)
  ok(connects - before > 1, `EventSource **确实会自动重连**（>1 次连接 = 我用来否决它的那条理由成立）`)
  log(`   → 这条决定了 RailExec 用 fetch 流而不是 EventSource：run 服务在 end 之后就 res.end()，`)
  log(`     配上自动重连就是「重连→拿到全量 replay+end→又被关→再重连」的死循环。`)
}

// ── ② fetch 流：读完就结束，不重连 ─────────────────────────────────
log('\n② fetch + ReadableStream（RailExec 实际用的）：读到 end 就结束，不重连')
{
  const before = connects
  const result = await page.evaluate(async (b) => {
    const res = await fetch(b + '/sse')
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let text = ''
    for (;;) { const { done, value } = await reader.read(); if (done) break; text += dec.decode(value, { stream: true }) }
    await new Promise((r) => setTimeout(r, 5000))   // 等同样久，看会不会自己再连
    return text
  }, base)
  log(`   5 秒等待期内服务端收到 ${connects - before} 次连接`)
  ok(connects - before === 1, `fetch 流**只连一次**（=1 才对）`)
  ok(result.includes('"type":"end"'), 'end 事件收到了')
}

// ── ③ HTTP/1.1 每域名 6 连接：同时开多个流会不会排队 ────────────────
log('\n③ HTTP/1.1 每域名连接上限（步骤4 §6 说「只给聚焦的 run 开 SSE」的依据）')
{
  const r = await page.evaluate(async (b) => {
    const t0 = Date.now()
    const opened = []
    // 开 8 条永不结束的流，记录每条 header 到达的时刻
    const ps = Array.from({ length: 8 }, (_, i) =>
      fetch(b + '/slow?i=' + i).then(() => opened.push({ i, ms: Date.now() - t0 })))
    await Promise.race([Promise.all(ps), new Promise((r2) => setTimeout(r2, 4000))])
    return opened.sort((a, c) => a.ms - c.ms)
  }, base)
  log(`   8 条并发流，成功建立 ${r.length} 条：${r.map((x) => `#${x.i}@${x.ms}ms`).join(' ')}`)
  ok(r.length <= 6, `同时最多 ${r.length} 条（≤6 说明确实有连接上限，§6 的顾虑成立）`)
  if (r.length > 6) log('   → 上限不是 6（可能走了 HTTP/2 或浏览器策略不同），§6 的理由要改')
}

await browser.close()
srv.close()
log('\n跑完。')
