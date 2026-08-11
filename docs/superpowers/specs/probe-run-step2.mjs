// 探针：① 首块到达的字节数与时刻（判断 4KB/300ms 首窗能不能定码）
//       ② 传入极小 env 时子进程实际拿到什么（libuv 强塞了什么）
import { spawn } from 'node:child_process'

const shell = process.env.COMSPEC || 'cmd.exe'

function run(label, command, opts = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const chunks = []
    const child = spawn(command, {
      cwd: process.cwd(), shell, stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts.env ? { env: opts.env } : {}),
    })
    let firstAt = null, firstLen = 0, bytesBy300 = 0, total = 0
    const onData = (b) => {
      const dt = Date.now() - t0
      if (firstAt === null) { firstAt = dt; firstLen = b.length }
      if (dt <= 300) bytesBy300 += b.length
      total += b.length
      chunks.push(b)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('close', (code) => {
      const buf = Buffer.concat(chunks)
      const utf8 = buf.toString('utf8')
      const fffd = utf8.split('�').length - 1
      // 首 4KB 窗口单独判一次，看结论和全量是否一致
      const win = buf.subarray(0, 4096).toString('utf8')
      const winFffd = win.split('�').length - 1
      resolve({
        label, code, ms: Date.now() - t0,
        firstAt, firstLen, bytesBy300, total,
        fffdRatioAll: total ? +(fffd / utf8.length).toFixed(4) : 0,
        fffdRatioWin4k: win.length ? +(winFffd / win.length).toFixed(4) : 0,
      })
    })
  })
}

const cmds = [
  ['ping(OEM中文)', 'ping 127.0.0.1 -n 2'],
  ['git log', 'git log --oneline -30'],
  ['tsc -v', 'npx tsc -v'],
  ['dir', 'dir'],
  ['echo utf8', 'echo 你好世界'],
]

console.log('=== ① 首块与首窗 ===')
for (const [label, c] of cmds) console.log(JSON.stringify(await run(label, c)))

console.log('\n=== ② 极小 env：子进程实际看到的变量名 ===')
const minimal = { PATH: process.env.PATH, SYSTEMROOT: process.env.SystemRoot }
const out = await new Promise((res) => {
  let s = ''
  const c = spawn('set', { shell, stdio: ['ignore', 'pipe', 'pipe'], env: minimal })
  c.stdout.on('data', (b) => { s += b.toString('latin1') })
  c.on('close', () => res(s))
})
const names = out.split(/\r?\n/).map((l) => l.split('=')[0]).filter(Boolean).sort()
console.log('传入 2 个，子进程实得 %d 个:', names.length)
console.log(names.join(' '))
