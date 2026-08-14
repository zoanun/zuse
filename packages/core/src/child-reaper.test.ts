import { describe, it, expect, beforeEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  trackChild,
  untrackChild,
  reapTrackedChildren,
  armChildReaper,
  __trackedPidsForTest,
  __resetChildReaperForTest,
} from './child-reaper.js'

/** 进程还活着吗（signal 0 只探测、不发信号）。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 轮询等一个 pid 死掉；返回是否在期限内死了。 */
async function waitDead(pid: number, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !alive(pid)
}

describe('child-reaper 记账', () => {
  beforeEach(() => __resetChildReaperForTest())

  it('undefined 不入册也不抛（spawn 失败时 pid 就是 undefined）', () => {
    expect(() => trackChild(undefined)).not.toThrow()
    expect(() => untrackChild(undefined)).not.toThrow()
    expect(__trackedPidsForTest()).toEqual([])
  })

  it('登记 / 注销', () => {
    trackChild(111)
    trackChild(222)
    expect(__trackedPidsForTest().sort()).toEqual([111, 222])
    untrackChild(111)
    expect(__trackedPidsForTest()).toEqual([222])
  })

  it('重复登记同一 pid 只算一条', () => {
    trackChild(333)
    trackChild(333)
    expect(__trackedPidsForTest()).toEqual([333])
  })

  it('armChildReaper 幂等：调 10 次只多一个 exit 监听器', () => {
    const before = process.listenerCount('exit')
    for (let i = 0; i < 10; i++) armChildReaper()
    expect(process.listenerCount('exit')).toBe(before + 1)
  })
})

describe('reapTrackedChildren 真的杀进程', () => {
  beforeEach(() => __resetChildReaperForTest())

  it('起两个真的长跑子进程，收割后两个都死了，册子清空', async () => {
    const a = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const b = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      expect(a.pid).toBeGreaterThan(0)
      expect(b.pid).toBeGreaterThan(0)
      trackChild(a.pid)
      trackChild(b.pid)

      const n = reapTrackedChildren()
      expect(n).toBe(2)
      expect(__trackedPidsForTest()).toEqual([])

      expect(await waitDead(a.pid!)).toBe(true)
      expect(await waitDead(b.pid!)).toBe(true)
    } finally {
      a.kill()
      b.kill()
    }
  }, 30_000)
})

/**
 * **这一条是唯一能证明「崩溃路径真的会清理」的测试** —— 上面几条都只是在测记账。
 *
 * 实测依据（node v22，本机）：未捕获异常和未处理的 Promise rejection 都会跑
 * `'exit'` 处理器（退出码 1），所以只挂 `'exit'` 就够，不需要 `uncaughtException`
 * ——后者会改变进程语义（node 默认的「打印堆栈 + 退出」得自己重新实现）。
 *
 * 起一个真子进程：它登记一个孙进程，然后 throw。断言孙进程被收掉。
 */
describe('崩溃路径端到端', () => {
  it('子进程未捕获异常时，它登记过的孙进程被收掉', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zuse-reaper-'))
    try {
      const beatFile = join(dir, 'beat.txt').replace(/\\/g, '/')
      const hbFile = join(dir, 'hb.cjs').replace(/\\/g, '/')
      writeFileSync(
        hbFile,
        `const fs=require('fs');let n=0;setInterval(()=>{n++;fs.writeFileSync(${JSON.stringify(beatFile)},String(n))},150)`,
        'utf8',
      )
      const here = fileURLToPath(new URL('.', import.meta.url))
      const reaperPath = join(here, 'child-reaper.ts').replace(/\\/g, '/')
      const script = join(dir, 'crash.mts')
      writeFileSync(
        script,
        [
          `import { spawn } from 'node:child_process'`,
          `import { writeFileSync } from 'node:fs'`,
          `import { trackChild } from ${JSON.stringify('file:///' + reaperPath)}`,
          // **必须经 shell 起孙进程**，与 spawnShellCommand 同构。
          // 直接 spawn 出来的孙进程会跟着父进程一起死（实测：父崩溃后 1.5s 就没了），
          // 那样一来「收割被改坏」时用例照样绿 —— 这条测试就白写了。
          // 心跳单独落一个 .cjs 文件，不用 `node -e` —— 内联代码要穿过
          // 「模板串 → 生成的脚本 → shell」三层引号，本仓已经栽过好几次：
          // 引号没活下来，脚本语法错误、瞬间退出，而用例只看到「什么都没发生」。
          `const g = spawn('"' + process.execPath + '" "' + ${JSON.stringify(hbFile)} + '"',`,
          `  { shell: true, stdio: 'ignore' })`,
          `trackChild(g.pid)`,
          // 崩溃前留够时间让 shell + node 真起来并写出第一个心跳，
          // 否则下面 existsSync(beatFile) 会因为「还没起来」而红 —— 那是假红。
          `setTimeout(() => { throw new Error('boom') }, 2500)`,
        ].join('\n'),
        'utf8',
      )

      // **用异步 spawn + 'exit'，不能用 spawnSync。** spawnSync 等的是 stdio 关闭，
      // 而 shell 包装器把 stdout 传给了孙进程 —— 孙进程不死它就不返回，整个用例挂死。
      // （这正是本仓 proc/settle.ts 那一轮记录过的 close/exit 之别。）
      let childLog = ''
      const code = await new Promise<number | null>((resolve) => {
        // 必须剥掉 _VOLTA_TOOL_RECURSION：本机 node 由 Volta 管，不剥的话子进程里
        // node/npx 直接解析不到 —— 表现是「退出码非 0 且一个字都不输出」（本仓已知坑）。
        const env = { ...process.env }
        delete env['_VOLTA_TOOL_RECURSION']
        const p = spawn('npx', ['tsx', script], {
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        })
        p.stdout.on('data', (d: Buffer) => (childLog += d.toString()))
        p.stderr.on('data', (d: Buffer) => (childLog += d.toString()))
        // 等 'exit' 而不是 'close'：孙进程继承了 stdout，close 要等它死，而它正是我们
        // 要观察的对象 —— 等 close 会把用例挂死（proc/settle.ts 那一轮的老坑）。
        p.once('exit', (c) => resolve(c))
      })
      // 子进程确实是崩溃退出的（不是正常结束）—— 否则测的就不是崩溃路径。
      expect(code).not.toBe(0)
      // 心跳真的起来过：没有这条，「心跳停了」可能只是因为它压根没跑起来（阴性对照）。
      // 把子进程输出带进断言消息 —— 否则脚本起不来时只看到一句 "expected false to be true"。
      expect(existsSync(beatFile), `心跳文件没出现；子进程输出：\n${childLog}`).toBe(true)
      // **心跳进程每 150ms 整份重写这个文件，所以读到「正在写的空文件」是可能的。**
      // 实测踩过一次：`Number('')` 是 0，断言变成 `expected 0 to be greater than 0`。
      // 这里保留上一次读到的非零值 —— 我们要判断的是「还在不在涨」，
      // 一次读空不代表心跳停了。
      let lastBeat = 0
      const readBeat = (): number => {
        const raw = readFileSync(beatFile, 'utf8').trim()
        const n = raw === '' ? NaN : Number(raw)
        if (Number.isFinite(n) && n > 0) lastBeat = n
        return lastBeat
      }
      // 起来得慢也不算失败：轮询到第一个心跳（上限 3 秒）。
      for (let i = 0; i < 30 && readBeat() === 0; i++) {
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(readBeat()).toBeGreaterThan(0)

      // **断言心跳，不断言 pid。** `spawn(..., {shell:true})` 拿到的是 shell 包装器的
      // pid，而真正干活的是它下面的 node。前一版断言 `waitDead(那个 pid)` 是**假绿**：
      // 父崩溃后包装器自己没了、pid 探测说「死了」，可 node 孙进程还在跑（实测在
      // 机器上留下 4 个孤儿）。心跳是它还活着的直接证据，且与机器负载无关。
      await new Promise((r) => setTimeout(r, 1200))
      const t1 = readBeat()
      await new Promise((r) => setTimeout(r, 3000))
      const t2 = readBeat()
      expect(t2).toBe(t1) // 还在涨 = 没被收掉
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
