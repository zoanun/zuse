// TermBuffer 下沉之后的真跑验收：真 daemon + 真 SSE。
//
// **必须在同一个进程里「起 run → 立刻订阅」**：片段档是 onDetach:'kill'，
// 没有订阅者的 run 会被立刻收掉；两个 curl 进程之间那几十毫秒就够它消失
//（实测：分两次 curl 一律拿到 {"error":{"code":"not_found"}}，即使命令要跑 6 秒）。
import { TermBuffer } from 'file:///E:/ai-study/zuse/packages/protocol/src/term-text.ts'

const base = 'http://127.0.0.1:4180'
const SCRIPT = 'E:/ai-study/zuse/docs/superpowers/specs/verify-termbuffer-probe.cjs'

const login = await fetch(base + '/api/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'zuonaok' }),
})
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
if (!cookie) { console.log('✗ 登录失败'); process.exit(1) }

const sess = await (await fetch(base + '/api/sessions', {
  method: 'POST', headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ cwd: 'E:/ai-study/zuse' }),
})).json()

const run = await (await fetch(base + '/api/runs', {
  method: 'POST', headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ command: `node "${SCRIPT}"`, sessionId: sess.id }),
})).json()
const rid = run.runId ?? run.id
if (!rid) { console.log('✗ 起 run 失败:', JSON.stringify(run)); process.exit(1) }

const res = await fetch(`${base}/api/runs/${rid}/stream?sessionId=${encodeURIComponent(sess.id)}`, { headers: { cookie } })
console.log('SSE status =', res.status, res.headers.get('content-type'))
if (!res.ok) { console.log('✗ 订阅失败:', await res.text()); process.exit(1) }

const buf = new TermBuffer()
let raw = ''
const dec = new TextDecoder()
const reader = res.body.getReader()
let sse = ''
const deadline = Date.now() + 15000
outer: while (Date.now() < deadline) {
  const { value, done } = await reader.read()
  if (done) break
  sse += dec.decode(value, { stream: true })
  let i
  while ((i = sse.indexOf('\n\n')) >= 0) {
    const frame = sse.slice(0, i); sse = sse.slice(i + 2)
    const line = frame.split('\n').find((l) => l.startsWith('data:'))
    if (!line) continue
    let ev
    try { ev = JSON.parse(line.slice(5).trim()) } catch { continue }
    if (ev.type === 'chunk' && ev.stream === 'out') { raw += ev.text; buf.push(ev.text) }
    if (ev.type === 'end') break outer
    if (raw.includes('done')) break outer
  }
}
await reader.cancel().catch(() => {})

const text = buf.flush()
console.log('--- 服务端推来的原始 chunk ---'); console.log(JSON.stringify(raw))
console.log('--- 经 TermBuffer 渲染 ---');     console.log(JSON.stringify(text))

let bad = 0
const ok = (n, c, d) => { console.log(`${c ? '✓' : '✗'} ${n} —— ${d}`); if (!c) bad++ }
ok('服务端确实推了带 ANSI/CR 的原始字节', raw.includes('\u001b') && raw.includes('\r'),
   `ESC=${raw.includes('\u001b')} CR=${raw.includes('\r')}`)
ok('ANSI 被剥掉', !text.includes('\u001b'), text.includes('\u001b') ? '仍有 ESC' : '干净')
ok('进度条折叠：只剩最后一帧', text.includes('100%') && !text.includes('10%') && !text.includes('50%'),
   JSON.stringify(text.split('\n').filter((l) => l.includes('%'))))
ok('正文没丢', text.includes('start') && text.includes('done'), '首尾都在')
console.log(bad === 0 ? '\n✓ 真跑验收通过' : `\n✗ ${bad} 项不合格`)
process.exit(bad === 0 ? 0 : 1)
