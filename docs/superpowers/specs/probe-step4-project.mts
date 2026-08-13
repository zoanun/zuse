// 步骤 4 探针：PROJECT_POLICY 全仓**零调用点、零真跑** —— 它承诺的
// 「无墙钟 + 断连不杀 + 环形缓冲不杀」到底成不成立，用真进程量一遍。
// 片段档那三条是反过来的（有墙钟、断连就杀、超预算就杀），两档共用一套状态机，
// 所以「另一档也对」不是免费的。
import { RunRegistry, PROJECT_POLICY, SNIPPET_POLICY, runEnv } from '../../../packages/tools/src/run/index.js'
import { spawnShellCommand, killTree } from '../../../packages/tools/src/proc/index.js'

const reg = new RunRegistry({
  deps: {
    spawn: (command: string, opts: { cwd: string; env?: NodeJS.ProcessEnv }) =>
      spawnShellCommand(command, { cwd: opts.cwd, ...(opts.env ? { env: opts.env } : {}) }),
    killTree,
  },
})
const cwd = 'E:/ai-study/zuse'
const ok = (c: boolean, msg: string) => console.log(`${c ? '  ✓' : '  ✗ 失败:'} ${msg}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

console.log('① 项目档：唯一的订阅者断开后，进程**仍然活着**（片段档到这里就被杀了）')
{
  const run = reg.start({
    command: 'node -e "setInterval(()=>console.log(Date.now()),200)"',
    cwd, sessionId: 's', policy: PROJECT_POLICY, env: runEnv(process.env, {}),
  })
  const off = run.subscribe(() => {})
  await sleep(400)
  off()                                                  // 「关掉页面」
  await sleep(800)
  ok(run.status === 'running', `status=${run.status}（片段档这里会是 exited/detach）`)

  console.log('② 断连期间的输出没丢：重新接回来能拿到历史（可重连的全部意义）')
  let replayed = ''
  const off2 = run.subscribe((e) => { if (e.type === 'chunk') replayed += e.text }, { replay: true })
  ok(replayed.length > 0, `重连拿回 ${replayed.length} 字符历史`)
  const linesAtReconnect = replayed.split('\n').filter(Boolean).length
  await sleep(500)
  ok(replayed.split('\n').filter(Boolean).length > linesAtReconnect, '重连之后还在继续收新输出')

  console.log('③ 停止：DELETE 那条路（registry.stop）能真的把它收掉')
  const stopped = reg.stop(run.id)
  ok(stopped, 'stop 返回 true')
  await sleep(1500)
  ok(run.status === 'exited', `status=${run.status}`)
  ok(run.endReason === 'killed', `reason=${run.endReason}`)
  off2()
}

console.log('④ 项目档没有墙钟：跑过片段档的 300 秒线也不会被砍（这里只验证没装定时器）')
{
  const run = reg.start({ command: 'node -e "setInterval(()=>{},1000)"', cwd, sessionId: 's', policy: PROJECT_POLICY })
  const off = run.subscribe(() => {})
  await sleep(300)
  ok(run.status === 'running', `status=${run.status}`)
  // 真等 300 秒不现实。改为对照：同一条命令在片段档里注入 400ms 墙钟，必须被砍。
  const snip = reg.start({
    command: 'node -e "setInterval(()=>{},1000)"', cwd, sessionId: 's',
    policy: { ...SNIPPET_POLICY, wallClockMs: 400, killGraceMs: 400 },
  })
  const offSnip = snip.subscribe(() => {})
  await sleep(1800)
  ok(snip.endReason === 'wall-clock', `片段档 reason=${snip.endReason}（对照组：墙钟确实在工作）`)
  ok(run.status === 'running', `项目档同期 status=${run.status}（没有被墙钟波及）`)
  offSnip(); off()
  reg.stop(run.id)
  await sleep(1200)
}

console.log('⑤ 项目档的环形缓冲：输出刷屏**不杀进程**（片段档到这里会 output-cap）')
{
  const run = reg.start({
    command: 'node -e "for(let i=0;i<30000;i++)console.log(\'x\'.repeat(50))"',
    cwd, sessionId: 's', policy: PROJECT_POLICY, env: runEnv(process.env, {}),
  })
  const done = new Promise<string>((resolve) => {
    run.subscribe((e) => { if (e.type === 'end') resolve(e.reason) })
  })
  const reason = await done
  ok(reason === 'exit', `reason=${reason}（'output-cap' 说明环形缓冲没生效、按截断档处理了）`)
}

console.log('⑥ 读当前目录的 package.json scripts（命名脚本按钮的数据来源）')
{
  const { readFileSync } = await import('node:fs')
  const pkg = JSON.parse(readFileSync(`${cwd}/package.json`, 'utf8')) as { scripts?: Record<string, string> }
  const names = Object.keys(pkg.scripts ?? {})
  ok(names.length > 0, `本仓根 package.json 有 ${names.length} 条 script: ${names.join(', ')}`)
  // 白名单是**便利不是安全边界**：scripts.x 完全可以是 rm -rf。
  console.log('     提醒：这些命令的正文照样要过确认闸，不因为「来自 package.json」豁免。')
}

reg.closeAll()
await sleep(300)
console.log('\n跑完。')
