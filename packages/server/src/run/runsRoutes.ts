import type { IncomingMessage, ServerResponse } from 'node:http'
import { hasBlockingBashSecurityIssue } from '@zuse/core'
import { RunLimitError, type RunPolicy, type RunRegistry, type RunEvent } from '@zuse/tools'
import type { SessionService } from '../session/SessionService.js'

export interface RunsRouteDeps {
  runs: RunRegistry
  service: SessionService
}

/**
 * 本步注入给子进程的 runner 变量。
 *
 * **只给 Python 那两个，不给 `JAVA_TOOL_OPTIONS`。** 后者会让 JVM 往 stderr 打一行垃圾，
 * 实测（本机 Temurin 21.0.9）：
 *
 * ```
 * $ JAVA_TOOL_OPTIONS="-Dfile.encoding=UTF-8" java -version
 * Picked up JAVA_TOOL_OPTIONS: -Dfile.encoding=UTF-8
 * openjdk version "21.0.9" 2025-10-21 LTS
 * ```
 *
 * 无条件注入 = 每次跑 Java 的 stderr 都凭空多一行。而 spec §5 本来就写的是
 * 「**按语言注入**，不是无脑全给」—— 本步只有一个裸 command 字符串、认不出语言，
 * 所以把它推给步骤 3 的 runner（那里知道自己在跑 Java）。
 *
 * Python 那两个反过来：不注入的话 `print` 是块缓冲的，「流式输出」全是假的
 * （这是本仓 CLAUDE.md 记着的坑），而它们对非 Python 进程完全无副作用，可以无条件给。
 */
export function runnerDeclaredEnv(): Record<string, string> {
  return { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
}

export interface StartRunBody {
  command?: unknown
  sessionId?: unknown
  /** 用户已看过安全提示并确认继续。见 §6.1 —— 不是同意缓存，只对**这一次**请求有效。 */
  confirmed?: unknown
}

export type RunRouteResult =
  | { status: number; json: unknown }
  /** SSE：调用方自己接管响应，不要再 sendJson。 */
  | { sse: true }

/**
 * `POST /api/runs` 的全部判断，抽成纯函数以便脱离 http 层单测。
 *
 * ## `cwd` **只能服务端反查**，绝不接受客户端传
 *
 * v4 §0.2 把这条列为「必须保留」。理由直白：这个端点执行任意命令，再让客户端指定目录
 * 就是「任意命令 + 任意目录」。而且本仓会话的 cwd 是**活的**（`applyCapturedCwd` 让
 * `cd` 跨命令持久），客户端那份随时可能是过期的。
 *
 * ## 安全闸是「可确认」而不是「硬拒」
 *
 * `$(...)` 命中的是 `checkId:8 command-substitution severity:'block'`。若做成硬拒，
 * 用户在自己写的代码里点运行 `echo "构建于 $(date)"` 会**永久跑不了**；而模型走 Bash
 * 工具跑同一条命令时 `decide()` 返回的是 `{decision:'ask'}` —— 点一下就能跑。
 * 用户对自己写的代码比模型受限更严，方向是反的。
 *
 * 所以：命中 → 409 带上 `securityHit`，前端把 `reason` 显示在确认框里；
 * 用户确认后带 `confirmed: true` 重发即可放行。
 * **不做同意缓存**（v4 §9 的 `hash(cwd+'\0'+command)` 属于步骤 4 的项目档输入框）——
 * 「能不能确认」和「要不要记住这次确认」是两件正交的事，v1 把前者当后者的理由推错了。
 */
export async function startRun(
  body: StartRunBody,
  deps: RunsRouteDeps,
  makePolicy: () => RunPolicy,
  buildEnv: (cwd: string) => NodeJS.ProcessEnv,
): Promise<RunRouteResult> {
  const command = typeof body.command === 'string' ? body.command.trim() : ''
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  if (!command) return bad('command 不能为空')
  if (!sessionId) return bad('sessionId 不能为空')

  const mgr = await deps.service.getOrLoad(sessionId)
  if (!mgr) return { status: 404, json: { error: { code: 'not_found', message: '找不到这个会话' } } }
  const cwd = mgr.getState().cwd

  if (body.confirmed !== true) {
    const hit = hasBlockingBashSecurityIssue(command)
    if (hit) {
      return {
        status: 409,
        json: {
          error: { code: 'security_confirm', message: hit.reason },
          // 把结构化的命中信息一并给出去：前端要按 name 决定文案，按 reason 显示细节。
          securityHit: { checkId: hit.checkId, name: hit.name, reason: hit.reason },
        },
      }
    }
  }

  try {
    const run = deps.runs.start({ command, cwd, sessionId, policy: makePolicy(), env: buildEnv(cwd) })
    return { status: 201, json: { runId: run.id, cwd } }
  } catch (e) {
    // 并发超限是「稍后再试」，不是「坏了」—— 429 而不是 500。
    if (e instanceof RunLimitError) return { status: 429, json: { error: { code: 'too_many_runs', message: e.message } } }
    throw e
  }
}

function bad(message: string): RunRouteResult {
  return { status: 400, json: { error: { code: 'bad_request', message } } }
}

/**
 * SSE 推流。
 *
 * 为什么不复用现有 WebSocket：那条通道是 **per-session** 的（`wsServer.ts` 只认 `/ws`、
 * 从 query 取 sessionId、把 socket 绑死在一个 SessionManager 上），而切会话时 socket 是
 * **真的关掉重开**的（`store.tsx` 调 `reconnect()` → `ws/client.ts` 里 `ws.close()`）。
 * 走 ws 则输出投递会断、重连后还得补历史；若再把 detach 绑在连接关闭上就会**误杀**。
 * 注意 ws 关闭本身并不会杀 run —— run 活在服务端注册表里。
 *
 * 代价：多一个连接；HTTP/1.1 下每域名 6 连接上限意味着同时看 6 个以上 run 会排队。
 * 本步只有片段档、同时最多 1 个，不构成问题。
 */
export function streamRun(
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
  deps: RunsRouteDeps,
): boolean {
  const run = deps.runs.get(runId)
  if (!run) return false

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // 有些反代会缓冲 event-stream，导致「流式」变成一次性。这个头是给 nginx 看的。
    'x-accel-buffering': 'no',
  })
  res.flushHeaders?.()

  // `replay: true` —— 中途接进来的必须先拿到已有输出，否则只看得到「从现在起」的部分。
  // 已结束的 run 还会补一条 end，那头才不会一直等一个永不到来的收尾。
  const off = run.subscribe((e: RunEvent) => {
    res.write(`data: ${JSON.stringify(e)}\n\n`)
    if (e.type === 'end') { off(); res.end() }
  }, { replay: true })

  // 客户端断开（关页面 / 切走）→ 退订。片段档的 onDetach:'kill' 会因此把进程收掉，
  // 项目档则保留可重连 —— 两档的差异全在 policy 里，这里一视同仁。
  req.on('close', () => { off() })
  return true
}
