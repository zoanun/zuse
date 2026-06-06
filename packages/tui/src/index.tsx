#!/usr/bin/env tsx
import { render } from 'ink'
import { cwd as processCwd, env, stderr } from 'node:process'
import { loadSettings, installProxy } from '@zuse/core'
import { App } from './App.js'

// 在 bin 入口处一次性定下工作目录，再往下传，而不是散落到 hook 里临时取。
// pnpm -F 会把进程 cwd 切到包目录（packages/tui），INIT_CWD 才记着用户真正敲
// 命令的目录；dev 时优先用它，装成 CLI 直接跑时回落 process.cwd()。
const cwd = env.INIT_CWD ?? processCwd()

// 启动时若配置了代理，先装全局 dispatcher，使后续所有出站请求（大模型 API / WebFetch /
// WebSearch）都走代理。必须在任何网络调用之前完成，故放在 render 之前。
// 两层 try/catch 区分两类错误：
//   外层 loadSettings 失败（坏 JSON 等）→ 静默跳过，App 挂载时会再次 loadSettings 并把
//     同一个配置错误渲染成友好错误页，不在 Ink 接管终端前抛栈污染输出。
//   内层 installProxy 失败（代理地址非法）→ App 不会复现这个错误，故必须在此显式告警，
//     否则用户会以为在走代理、实则已降级直连。告警后不阻断启动。
try {
  const settings = loadSettings()
  try {
    const proxy = installProxy(settings)
    if (proxy) stderr.write(`[zuse] 出站请求经代理: ${proxy}\n`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    stderr.write(`[zuse] 代理配置无效，已降级为直连：${msg}\n`)
  }
} catch {
  // loadSettings 失败：交由 App 统一处理配置错误。
}

render(<App cwd={cwd} />)
