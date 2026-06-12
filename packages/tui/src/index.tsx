import { render } from 'ink'
import { PassThrough } from 'node:stream'
import { argv, cwd as processCwd, env, exit, stderr, stdout } from 'node:process'
import { loadSettings, installProxy, type Conversation } from '@zuse/core'
import { App } from './App.js'
import { InputProvider } from './input/InputProvider.js'
import { pruneOldTempFiles } from './toolOutputFile.js'
import { listAutoSessions, loadAutoSession } from './commands/sessionStore.js'

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
    // 成功安装代理时不再向 stderr 打印——代理地址已在启动横幅的「代理」行展示，避免重复。
    installProxy(settings)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    stderr.write(`[zuse] 代理配置无效，已降级为直连：${msg}\n`)
  }
} catch {
  // loadSettings 失败：交由 App 统一处理配置错误。
}

try {
  // 启动清理：删 7 天前的临时输出文件（Windows %TEMP% 不自动回收，防堆积）。
  pruneOldTempFiles(7 * 24 * 60 * 60 * 1000, Date.now())
} catch {
  // 清理失败不影响启动
}

/**
 * 解析 --continue/-c 与 --resume <序号|id>(Phase 10A)。读盘失败/无会话都不阻断
 * 启动:提示一行后照常开新会话。`--resume` 无参则打印列表并退出(选择在会话内用
 * /resume <序号> 完成,不做启动期交互式选择器 —— 见 spec A5)。
 */
async function resolveInitialSession(): Promise<
  { conversation: Conversation; id: string; createdAt: string } | undefined
> {
  const args = argv.slice(2)
  const wantsContinue = args.includes('--continue') || args.includes('-c')
  const resumeIdx = args.indexOf('--resume')
  const wantsResume = resumeIdx !== -1
  if (!wantsContinue && !wantsResume) return undefined

  try {
    const metas = await listAutoSessions(cwd)
    if (metas.length === 0) {
      stderr.write('[zuse] 本目录还没有自动保存的会话,已开新会话。\n')
      return undefined
    }
    if (wantsContinue) {
      return await loadAutoSession(cwd, metas[0]!.id)
    }
    // --resume:取其后第一个非 flag 参数作为 序号|id。
    const ref = args[resumeIdx + 1]
    if (!ref || ref.startsWith('-')) {
      const lines = metas.map((m, i) => {
        const when = m.updatedAt.slice(0, 16).replace('T', ' ')
        return `  ${i + 1}. ${when}  ${String(m.messageCount).padStart(3)} 条  ${m.firstUserText}`
      })
      stdout.write(['本目录的自动会话(zuse --resume <序号> 续接):', ...lines, ''].join('\n'))
      exit(0)
    }
    const n = Number.parseInt(ref, 10)
    const meta =
      Number.isInteger(n) && n >= 1 && String(n) === ref ? metas[n - 1] : metas.find((m) => m.id === ref)
    if (!meta) {
      stderr.write(`[zuse] 没有匹配 "${ref}" 的会话,已开新会话(zuse --resume 可查看列表)。\n`)
      return undefined
    }
    return await loadAutoSession(cwd, meta.id)
  } catch (err) {
    stderr.write(`[zuse] 载入会话失败,已开新会话:${err instanceof Error ? err.message : String(err)}\n`)
    return undefined
  }
}

const initialSession = await resolveInitialSession()

// 给 Ink 喂一个非 TTY 哑流：Ink 的 useInput/焦点管理永不触发、不碰键盘，
// 真实 process.stdin 全权交给 InputProvider 接管（见 input/ 子系统）。
// Ink 仍正常渲染到 stdout，resize 走 stdout 不受影响。
const dummyStdin = new PassThrough() as unknown as NodeJS.ReadStream
dummyStdin.isTTY = false

// exitOnCtrlC:false 关掉 Ink 默认的「单击 Ctrl+C 立即退出」，改由 App 实现双击退出，
// 避免误触一次就丢掉会话（单击 Esc 才是中断流式）。
render(
  <InputProvider>
    <App cwd={cwd} initialSession={initialSession} />
  </InputProvider>,
  { stdin: dummyStdin, exitOnCtrlC: false },
)
