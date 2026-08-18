// 真跑验收两条修复（都对着在跑的 daemon，不是单测）：
//   A. 目录删掉之后仍然撤得掉信任
//   B. trusted 是字符串 "false" 时必须 400，绝不能当成「授予」
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const base = 'http://127.0.0.1:4180'
let bad = 0
const ok = (n, c, d) => { console.log(`${c ? '✓' : '✗'} ${n} —— ${d}`); if (!c) bad++ }

const login = await fetch(base + '/api/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'zuonaok' }),
})
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
const post = (body) => fetch(base + '/api/trusted-roots', {
  method: 'POST', headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
})
const list = async () => (await (await fetch(base + '/api/trusted-roots', { headers: { cookie } })).json()).roots

const dir = mkdtempSync(join(tmpdir(), 'zuse-untrust-'))
const before = await list()

const t = await post({ root: dir })
ok('信任一个真实目录 → 200', t.status === 200, String(t.status))
ok('表里多了这一条', (await list()).length === before.length + 1, '')

rmSync(dir, { recursive: true, force: true })
const u = await post({ root: dir, trusted: false })
ok('目录已删，仍然撤得掉（这条修之前是 400）', u.status === 200, `${u.status} ${u.ok ? '' : await u.text()}`)
ok('表恢复原样', JSON.stringify(await list()) === JSON.stringify(before), JSON.stringify(await list()))

const s = await post({ root: 'E:/ai-study/zuse', trusted: 'false' })
ok('trusted 是字符串 "false" → 400（修之前是 200 且授予信任）', s.status === 400, `${s.status} ${await s.text()}`)
const after = await list()
ok('那条请求没改动过表', JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after))

// 撤销一个从没信任过的路径：幂等，200
const idem = await post({ root: tmpdir(), trusted: false })
ok('撤销一个从没信任过的路径 → 200（幂等）', idem.status === 200, String(idem.status))

console.log(bad === 0 ? '\n✓ 通过' : `\n✗ ${bad} 项不合格`)
process.exit(bad === 0 ? 0 : 1)
