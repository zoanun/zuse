// 探针（v2）：为 run 服务步骤 2 的设计取证。
//
// v1 有两处取证错误，评审指出后重做：
//   ① 五条样本总字节全 < 4096，于是「首 4KB 窗结论 == 全量结论」是 subarray 的
//      构造保证，不是观测 —— 同义反复。v2 必须有 **> 4KB** 的 OEM 样本。
//   ② stdout/stderr 灌进同一个数组统计，支撑不了「每条流各自定码还是共用一个决策」
//      这个设计问题。v2 分流统计。
// 另加 ③：窗口边界切断多字节序列会不会伪造 U+FFFD（这条直接决定定码判据怎么写）。
import { spawn } from 'node:child_process'

const shell = process.env.COMSPEC || 'cmd.exe'
const RATIO = 0.02 // = oem.ts 的 OEM_MOJIBAKE_RATIO，判据同源，不另立门户

const judge = (buf) => {
  const s = buf.toString('utf8')
  const f = s.split('�').length - 1
  return { bytes: buf.length, chars: s.length, fffd: f, ratio: s.length ? +(f / s.length).toFixed(4) : 0, verdict: s.length && f / s.length >= RATIO ? 'OEM' : 'utf8' }
}

function run(label, command) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const acc = { out: [], err: [] }
    const meta = { out: { firstAt: null, by300: 0 }, err: { firstAt: null, by300: 0 } }
    const child = spawn(command, { cwd: process.cwd(), shell, stdio: ['ignore', 'pipe', 'pipe'] })
    const on = (which) => (b) => {
      const dt = Date.now() - t0
      if (meta[which].firstAt === null) meta[which].firstAt = dt
      if (dt - meta[which].firstAt <= 300) meta[which].by300 += b.length  // 从**首字节**起算，不是从 spawn
      acc[which].push(b)
    }
    child.stdout.on('data', on('out'))
    child.stderr.on('data', on('err'))
    child.on('close', () => {
      const r = { label, ms: Date.now() - t0 }
      for (const which of ['out', 'err']) {
        const buf = Buffer.concat(acc[which])
        if (buf.length === 0) { r[which] = null; continue }
        // 首窗 = 首字节起 300ms 内到达的字节，与 4096 取小 —— 这就是 §3 状态机真正会看到的窗口
        const winLen = Math.min(meta[which].by300 || buf.length, 4096, buf.length)
        r[which] = { firstAt: meta[which].firstAt, win: judge(buf.subarray(0, winLen)), all: judge(buf) }
        r[which].agree = r[which].win.verdict === r[which].all.verdict
      }
      resolve(r)
    })
  })
}

console.log('=== ① 分流统计 + 首窗/全量是否同结论（含 >4KB 样本）===')
for (const [label, c] of [
  ['ping -n 2 (OEM,小)', 'ping 127.0.0.1 -n 2'],
  ['ping -n 40 (OEM,>4KB)', 'ping 127.0.0.1 -n 40 -w 1'],
  ['dir /s (OEM,>4KB)', 'dir /s /b'],
  ['git log (UTF8,>4KB)', 'git log --oneline -400'],
  ['tsc -v (首字节晚到)', 'npx tsc -v'],
  ['stderr OEM + stdout UTF8', 'git log --oneline -3 & ping 127.0.0.1 -n 1 1>&2'],
]) console.log(JSON.stringify(await run(label, c)))

console.log('\n=== ② 极小 env：子进程实得多少 ===')
const out = await new Promise((res) => {
  let s = ''
  const c = spawn('set', { shell, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SystemRoot } })
  c.stdout.on('data', (b) => { s += b.toString('latin1') })
  c.on('close', () => res(s))
})
const names = out.split(/\r?\n/).map((l) => l.split('=')[0]).filter(Boolean).sort()
console.log('传入 2 个，子进程实得 %d 个:\n%s', names.length, names.join(' '))

console.log('\n=== ③ 窗口切断多字节序列会不会伪造 U+FFFD ===')
const nihao = Buffer.from('你好', 'utf8')
console.log('完整 6 字节      ', JSON.stringify(judge(nihao)))
console.log('切到 4 字节      ', JSON.stringify(judge(nihao.subarray(0, 4))))
const big = Buffer.from('中'.repeat(60), 'utf8')
console.log('60 字切掉末字节  ', JSON.stringify(judge(big.subarray(0, big.length - 1))))
// 同一个截断窗口，先用 TextDecoder 的 stream 模式吃掉挂起的尾序列再判
const sd = new TextDecoder('utf-8')
const s2 = sd.decode(nihao.subarray(0, 4), { stream: true })
console.log('切4字节+stream判 ', JSON.stringify({ chars: s2.length, fffd: s2.split('�').length - 1, verdict: 'utf8(不产生 FFFD)' }))

console.log('\n=== ④ TextDecoder 的 stream 参数该放哪（GBK 双字节跨 chunk）===')
const gbk = Buffer.from([0xC4, 0xE3, 0xBA, 0xC3, 0xCA, 0xC0, 0xBD, 0xE7]) // 「你好世界」GBK
const c1 = gbk.subarray(0, 3), c2 = gbk.subarray(3)                        // 故意切在双字节中间
const A = new TextDecoder('gbk', { stream: true })
const a = A.decode(c1) + A.decode(c2)
const B = new TextDecoder('gbk')
const b = B.decode(c1, { stream: true }) + B.decode(c2, { stream: true })
console.log('A 构造函数传 stream:', JSON.stringify(a), '  ← 错，参数被静默忽略')
console.log('B decode 传 stream :', JSON.stringify(b), '  ← 对')
