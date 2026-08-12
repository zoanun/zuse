// 真跑验证：用**真的** spawn / killTree / 真命令，把 run 服务的底座端到端走一遍。
// 单测里子进程全是假的 —— 这个脚本要证明的正是「接上真进程也能用」。
import { RunRegistry, SNIPPET_POLICY, PROJECT_POLICY, runEnv } from '../../../packages/tools/src/run/index.js'
import { spawnShellCommand, killTree } from '../../../packages/tools/src/proc/index.js'

const deps = {
  spawn: (command, opts) => spawnShellCommand(command, { cwd: opts.cwd, ...(opts.env ? { env: opts.env } : {}) }),
  killTree,
}
const reg = new RunRegistry({ deps })
const cwd = 'E:/ai-study/zuse'

function run(command, policy = SNIPPET_POLICY, env) {
  return new Promise((resolve) => {
    const r = reg.start({ command, cwd, sessionId: 's', policy, env })
    let out = '', err = ''
    r.subscribe((e) => {
      if (e.type === 'chunk') { if (e.stream === 'out') out += e.text; else err += e.text }
      else resolve({ id: r.id, reason: e.reason, exitCode: e.exitCode, out, err, status: r.status })
    })
  })
}

const ok = (c, msg) => console.log(`${c ? '  ✓' : '  ✗ 失败:'} ${msg}`)

console.log('① 真命令的输出能流出来')
{
  const r = await run('echo hello-from-real-run')
  ok(r.out.includes('hello-from-real-run'), `out=${JSON.stringify(r.out.trim())}`)
  ok(r.reason === 'exit' && r.exitCode === 0, `reason=${r.reason} exitCode=${r.exitCode}`)
}

console.log('② 中文不乱码（走的是首窗定码那条路，不是一次性重解码）')
{
  const r = await run('node -e "console.log(\'中文输出正常\')"')
  ok(r.out.includes('中文输出正常'), `out=${JSON.stringify(r.out.trim())}`)
}

console.log('③ Windows 原生程序的 OEM 输出也认得出来')
{
  const r = await run('ping 127.0.0.1 -n 1')
  const mojibake = (r.out.match(/\uFFFD/g) || []).length
  ok(mojibake === 0, `U+FFFD 个数=${mojibake}（>0 说明按 UTF-8 硬解了 OEM 字节）`)
  console.log('     首行:', JSON.stringify(r.out.split(/\r?\n/).find(Boolean)))
}

console.log('④ stderr 与 stdout 分开投递')
{
  const r = await run('node -e "console.log(\'到O\');console.error(\'到E\')"')
  ok(r.out.includes('到O') && !r.out.includes('到E'), `out=${JSON.stringify(r.out.trim())}`)
  ok(r.err.includes('到E') && !r.err.includes('到O'), `err=${JSON.stringify(r.err.trim())}`)
}

console.log('⑤ 非零退出码原样报出来')
{
  const r = await run('node -e "process.exit(7)"')
  ok(r.exitCode === 7 && r.reason === 'exit', `reason=${r.reason} exitCode=${r.exitCode}`)
}

console.log('⑥ 墙钟到点：真的把一个长命令杀掉（注入 800ms）')
{
  const t0 = Date.now()
  const r = await run('node -e "setInterval(()=>{},1000)"', { ...SNIPPET_POLICY, wallClockMs: 800, killGraceMs: 500 })
  const dt = Date.now() - t0
  ok(r.reason === 'wall-clock', `reason=${r.reason}`)
  ok(dt < 5000, `耗时 ${dt}ms（该在 1s 左右，不是等满 300s）`)
  ok(r.status === 'exited', `status=${r.status}（不是 zombie，说明真的死了）`)
}

console.log('⑦ 空闲超时：一直不吐字的进程被收掉（注入 700ms）')
{
  const r = await run('node -e "setInterval(()=>{},1000)"', { ...PROJECT_POLICY, idleMs: 700, killGraceMs: 500 })
  ok(r.reason === 'idle', `reason=${r.reason}`)
}

console.log('⑧ 有输出的进程不会被空闲杀掉（v4 §3 的判据）')
{
  const r = await run('node -e "let n=0;const t=setInterval(()=>{console.log(++n);if(n>6){clearInterval(t)}},100)"',
    { ...PROJECT_POLICY, idleMs: 400, killGraceMs: 500 })
  ok(r.reason === 'exit', `reason=${r.reason}（一直在吐字，不该被判空闲）`)
  ok(r.out.trim().split(/\r?\n/).length >= 6, `收到 ${r.out.trim().split(/\r?\n/).length} 行`)
}

console.log('⑨ 输出超预算 → 杀掉并报 output-cap')
{
  const r = await run('node -e "for(let i=0;i<20000;i++)console.log(\'x\'.repeat(50))"',
    { ...SNIPPET_POLICY, sink: { kind: 'truncate', budget: 5000 }, killGraceMs: 500 })
  ok(r.reason === 'output-cap', `reason=${r.reason}`)
  // 契约是「预算 + 触发溢出的那一块」，不是「精确等于预算」—— 那一块要全推，
  // 用户得看得到出事前的最后一段。关键是它**不再**随进程继续刷屏而增长（修复前是 1,020,000）。
  ok(r.out.length < 100_000, `可见输出 ${r.out.length} 字符（修复前 1,020,000）`)
}

console.log('⑩ env 白名单在真进程上生效')
{
  process.env.ZUSE_E2E_SECRET = 'sk-e2e-MUST-NOT-LEAK'
  const env = runEnv(process.env, { PYTHONUNBUFFERED: '1' })
  const r = await run('node -e "const e=process.env;console.log(JSON.stringify({leak:Object.values(e).some(v=>String(v).includes(\'sk-e2e-MUST-NOT-LEAK\')),py:e.PYTHONUNBUFFERED,hasPath:!!(e.PATH||e.Path)}))"', SNIPPET_POLICY, env)
  const got = JSON.parse(r.out.trim() || '{}')
  ok(got.leak === false, `凭据泄露=${got.leak}`)
  ok(got.py === '1', `PYTHONUNBUFFERED=${got.py}`)
  ok(got.hasPath === true, `子进程有 PATH=${got.hasPath}`)
  delete process.env.ZUSE_E2E_SECRET
}

console.log('⑪ 注册表：结束的 run 仍可查到退出码；closeAll 不留活口')
{
  const rows = reg.list()
  ok(rows.length > 0 && rows.every((x) => x.status === 'exited'), `${rows.length} 条，状态=${[...new Set(rows.map((x) => x.status))].join(',')}`)
  reg.closeAll()
  ok(true, 'closeAll 未抛')
}
console.log('\n跑完。')
