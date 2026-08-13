// v4 §8 只测了 11 条一次性命令（ESC 全为 0），**没测过 dev server**。
// TermBuffer 的「ANSI 只做 strip、不做 ansi→span」就建在那个观察上。
// dev server 是长跑的、会重绘、常带颜色 —— 这一条必须单独量。
import { spawn } from 'node:child_process'

function probe(label, command, cwd, ms) {
  return new Promise((resolve) => {
    const p = spawn(command, { shell: true, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const bufs = { out: [], err: [] }
    p.stdout.on('data', (b) => bufs.out.push(b))
    p.stderr.on('data', (b) => bufs.err.push(b))
    setTimeout(() => {
      try { spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
      const out = Buffer.concat(bufs.out), err = Buffer.concat(bufs.err)
      const count = (b, byte) => b.reduce((n, x) => n + (x === byte ? 1 : 0), 0)
      resolve({
        label,
        outBytes: out.length, errBytes: err.length,
        outEsc: count(out, 0x1b), errEsc: count(err, 0x1b),
        outCR: count(out, 0x0d), errCR: count(err, 0x0d),
        sample: out.toString('utf8').slice(0, 220),
      })
    }, ms)
  })
}

const CASES = [
  ['vite dev（真 dev server）', 'pnpm -F @zuse/web dev', 'E:/ai-study/zuse', 6000],
  ['vitest（跑测试，常带颜色）', 'npx vitest run --root E:/ai-study/zuse packages/tools/src/run/planExec.test.ts', 'E:/ai-study/zuse', 12000],
  ['uv run pytest --version', 'uv run --no-project python -c "print(1)"', 'E:/ai-study/zuse', 5000],
]

console.log('ESC = 0x1b（ANSI 转义序列的引导字节）；CR = 0x0d（\\r）\n')
for (const [label, cmd, cwd, ms] of CASES) {
  const r = await probe(label, cmd, cwd, ms)
  console.log(`── ${r.label}`)
  console.log(`   stdout ${r.outBytes} 字节  ESC=${r.outEsc}  CR=${r.outCR}`)
  console.log(`   stderr ${r.errBytes} 字节  ESC=${r.errEsc}  CR=${r.errCR}`)
  console.log(`   样本: ${JSON.stringify(r.sample.slice(0, 150))}`)
  const verdict = (r.outEsc + r.errEsc) === 0
    ? '   ✓ 无 ANSI —— strip 就够了'
    : `   ⚠ **有 ANSI（${r.outEsc + r.errEsc} 个 ESC）** —— strip 之后会是无色纯文本，进度条/重绘会变成一堆行`
  console.log(verdict + '\n')
}
console.log('跑完。')
