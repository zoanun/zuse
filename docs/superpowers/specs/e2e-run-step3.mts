// 步骤 3 真跑验证：planExec 拼出来的命令，在这台机器上到底跑不跑得起来。
// 单测只断言了字符串长什么样 —— 那证明不了 `uv run --no-project` 和
// `java -Dstdout.encoding=…` 真的能把代码跑出来。
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunRegistry, SNIPPET_POLICY, planExec, runEnv, EXEC_DIR_PLACEHOLDER, type ExecKind } from '../../../packages/tools/src/run/index.js'
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

/** 完整走一遍服务端那条路：planExec → 落盘 → 起 run → 收输出。 */
function runCode(kind: ExecKind, code: string) {
  const plan = planExec(kind, code)
  const dir = mkdtempSync(join(tmpdir(), 'zuse-run-'))
  for (const f of plan.files) writeFileSync(join(dir, f.name), f.content, 'utf8')
  const command = plan.command.split(EXEC_DIR_PLACEHOLDER).join(dir.replace(/\\/g, '/'))
  return new Promise<{ out: string; err: string; reason: string; exitCode: number | null; dir: string; command: string }>((resolve) => {
    const r = reg.start({
      command, cwd, sessionId: 's', policy: SNIPPET_POLICY,
      env: runEnv(process.env, { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }),
    })
    let out = '', err = ''
    r.subscribe((e) => {
      if (e.type === 'chunk') { if (e.stream === 'out') out += e.text; else err += e.text }
      else resolve({ out, err, reason: e.reason, exitCode: e.exitCode, dir, command })
    })
  })
}

console.log('① Python：planExec 的命令在真机上跑得起来，中文不乱码')
{
  const r = await runCode('python', 'print("你好，这是真跑的 Python")\nfor i in range(3):\n    print(i)')
  console.log('     命令:', r.command)
  ok(r.out.includes('你好，这是真跑的 Python'), `stdout=${JSON.stringify(r.out.slice(0, 60))}`)
  ok(r.out.includes('0\n') || r.out.includes('0\r'), '循环输出也在')
  ok(r.reason === 'exit' && r.exitCode === 0, `reason=${r.reason} exitCode=${r.exitCode}`)
  rmSync(r.dir, { recursive: true, force: true })
}

console.log('② Python：报错走 stderr，traceback 完整')
{
  const r = await runCode('python', 'raise ValueError("故意报错")')
  ok(r.err.includes('ValueError'), `stderr 含 ValueError`)
  ok(r.err.includes('故意报错'), `stderr 里的中文没乱码: ${JSON.stringify(r.err.slice(-40))}`)
  ok(r.exitCode === 1, `exitCode=${r.exitCode}`)
  rmSync(r.dir, { recursive: true, force: true })
}

console.log('③ Python：--no-project 真的不碰用户项目（跑完 cwd 里不多出 .venv）')
{
  const before = existsSync(join(cwd, '.venv'))
  const r = await runCode('python', 'print("x")')
  ok(!existsSync(join(cwd, '.venv')) || before, `仓库根没有多出 .venv`)
  rmSync(r.dir, { recursive: true, force: true })
}

console.log('④ Java：单文件模式跑得起来，中文不乱码（三个 -D 起作用）')
{
  const r = await runCode('java', 'public class Main { public static void main(String[] a){ System.out.println("你好，这是真跑的 Java"); } }')
  console.log('     命令:', r.command)
  ok(r.out.includes('你好，这是真跑的 Java'), `stdout=${JSON.stringify(r.out.slice(0, 60))}`)
  ok((r.out.match(/\uFFFD/g) || []).length === 0, `U+FFFD 个数=${(r.out.match(/\uFFFD/g) || []).length}`)
  rmSync(r.dir, { recursive: true, force: true })
}

console.log('⑤ Java：编译错误走 stderr，且中文不乱码（-Dstderr.encoding 的意义就在这）')
{
  const r = await runCode('java', 'public class Main { public static void main(String[] a){ int x = "字符串"; } }')
  ok(r.exitCode !== 0, `exitCode=${r.exitCode}`)
  ok((r.err.match(/\uFFFD/g) || []).length === 0, `stderr U+FFFD 个数=${(r.err.match(/\uFFFD/g) || []).length}`)
  console.log('     stderr 首行:', JSON.stringify(r.err.split(/\r?\n/).find(Boolean)))
  rmSync(r.dir, { recursive: true, force: true })
}

console.log('⑥ 输出流是**边跑边来**的，不是最后一次性给（"流式"不能是假的）')
{
  const plan = planExec('python', 'import time\nfor i in range(4):\n    print(i, flush=True)\n    time.sleep(0.25)')
  const dir = mkdtempSync(join(tmpdir(), 'zuse-run-'))
  writeFileSync(join(dir, 'main.py'), plan.files[0]!.content, 'utf8')
  const command = plan.command.split(EXEC_DIR_PLACEHOLDER).join(dir.replace(/\\/g, '/'))
  const stamps: number[] = []
  const t0 = Date.now()
  await new Promise<void>((resolve) => {
    const r = reg.start({
      command, cwd, sessionId: 's', policy: SNIPPET_POLICY,
      env: runEnv(process.env, { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }),
    })
    r.subscribe((e) => {
      if (e.type === 'chunk' && e.stream === 'out') stamps.push(Date.now() - t0)
      else if (e.type === 'end') resolve()
    })
  })
  // 全是一次性给的话，所有时间戳会挤在最后。真流式则应该分散开。
  const spread = stamps.length > 1 ? stamps[stamps.length - 1]! - stamps[0]! : 0
  ok(stamps.length >= 2, `收到 ${stamps.length} 次推送（1 次 = 攒到最后才给）`)
  ok(spread > 200, `首末推送间隔 ${spread}ms（接近 0 说明是攒完一次性给的）`)
  console.log('     各次推送时刻(ms):', stamps.join(', '))
  rmSync(dir, { recursive: true, force: true })
}

reg.closeAll()
console.log('\n跑完。')
