// 步骤 5 端到端：用**生产代码**的 createSession + SessionManager.submit 走一轮，
// 用一个「录音机」client 截下真正发给模型的 messages 与 tools，验三件事：
//   1. RunOutput 真的在发给模型的工具清单里
//   2. §8(b) 的现状提示真的进了发给模型的那份副本
//   3. 那段提示**没有**进账本（不进用户气泡、不进标题、不被 retry 重发）
import { createSession } from 'file:///E:/ai-study/zuse/packages/server/src/session/createSession.ts'
import { RunRegistry, spawnShellCommand, killTree, killTreeHard } from 'file:///E:/ai-study/zuse/packages/tools/src/index.ts'

const runs = new RunRegistry({ deps: {
  spawn: (c: string, o: { cwd: string }) => spawnShellCommand(c, { cwd: o.cwd }),
  killTree, killTreeHard,
} })

let seenMessages: unknown[] = []
let seenTools: Array<{ name: string }> = []
const recorder = {
  getModel: () => 'fake',
  async *sendMessages(messages: unknown[], _cfg: unknown, tools?: Array<{ name: string }>) {
    seenMessages = messages
    seenTools = tools ?? []
    yield { type: 'text-delta', text: 'ok' }
    yield { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
  },
} as never

const mgr = createSession({ sessionId: 's-e2e', cwd: process.cwd(), client: recorder, runs })

// 起一个**会失败**的后台命令 —— §8(b) 只列在跑的/非零退出的。
runs.start({ command: `"${process.execPath}" -e "process.exit(3)"`, label: '会失败的构建',
  cwd: process.cwd(), sessionId: 's-e2e', policy: { wallClockMs: null, idleMs: null, killGraceMs: 3000,
    onDetach: 'keep', sink: { kind: 'truncate', budget: 10000 } } })
await new Promise((r) => setTimeout(r, 1500))

await mgr.submit('修一下')

const flat = JSON.stringify(seenMessages)
let bad = 0
const ok = (n: string, c: boolean, d: string) => { console.log(`${c ? '✓' : '✗'} ${n} —— ${d}`); if (!c) bad++ }

ok('RunOutput 在发给模型的工具清单里', seenTools.some((t) => t.name === 'RunOutput'),
   `工具数=${seenTools.length}`)
ok('§8(b) 的现状提示进了发给模型的副本', flat.includes('后台命令现状'),
   flat.includes('会失败的构建') ? '含 label' : '不含')
ok('提示里引导去用 RunOutput', flat.includes('RunOutput'), '')

// 账本侧：那段提示绝不能进去（否则用户气泡/标题/retry 全被污染）
const ledger = JSON.stringify(mgr.getState())
ok('提示**没有**进账本', !ledger.includes('后台命令现状'),
   ledger.includes('后台命令现状') ? '污染了账本！' : '账本干净')

runs.disposeAll()
console.log(bad === 0 ? '\n✓ 步骤 5 端到端通过' : `\n✗ ${bad} 项不合格`)
process.exit(bad === 0 ? 0 : 1)
