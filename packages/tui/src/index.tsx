#!/usr/bin/env tsx
import { render } from 'ink'
import { cwd as processCwd, env } from 'node:process'
import { App } from './App.js'

// 在 bin 入口处一次性定下工作目录，再往下传，而不是散落到 hook 里临时取。
// pnpm -F 会把进程 cwd 切到包目录（packages/tui），INIT_CWD 才记着用户真正敲
// 命令的目录；dev 时优先用它，装成 CLI 直接跑时回落 process.cwd()。
const cwd = env.INIT_CWD ?? processCwd()

render(<App cwd={cwd} />)
