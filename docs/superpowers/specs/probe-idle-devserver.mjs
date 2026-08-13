// 验证子代理提的那条：PROJECT_POLICY.idleMs = 30 分钟，而 idle 定时器**每次输出都重置**。
// 问题是 —— 一个没人访问的 dev server，启动之后到底还吐不吐字节？
// 如果它完全安静，30 分钟后就会被当成「一直没有输出」杀掉，而用户只是去吃了顿饭。
import { spawn } from 'node:child_process'

const p = spawn('pnpm -F @zuse/web dev', { shell: true, cwd: 'E:/ai-study/zuse', stdio: ['ignore', 'pipe', 'pipe'] })
const t0 = Date.now()
const stamps = []
p.stdout.on('data', (b) => stamps.push({ ms: Date.now() - t0, n: b.length }))
p.stderr.on('data', (b) => stamps.push({ ms: Date.now() - t0, n: b.length, err: true }))

await new Promise((r) => setTimeout(r, 25000))
spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' })

const last = stamps.length ? stamps[stamps.length - 1].ms : -1
console.log(`25 秒内共 ${stamps.length} 次输出，最后一次在 ${last}ms`)
console.log('各次:', stamps.map((s) => `${s.ms}ms/${s.n}B`).join(' '))
const quietFor = 25000 - last
console.log(`\n启动完成后已安静 ${quietFor}ms`)
if (quietFor > 15000) {
  console.log('→ **dev server 启动后就完全安静了**。')
  console.log('  项目档 idleMs = 30 分钟 + 每次输出重置 = 没人访问的 dev server 会在 30 分钟后被杀，')
  console.log('  而 UI 文案是「一直没有输出，已停止」—— 用户午饭回来看到这个，完全不知道发生了什么。')
} else {
  console.log('→ dev server 有周期性输出，idle 不会误杀。')
}
