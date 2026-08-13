import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasBlockingBashSecurityIssue } from '@zuse/core'
import {
  RunLimitError, planExec, EXEC_DIR_PLACEHOLDER,
  type RunPolicy, type RunRegistry, type RunEvent, type ExecKind,
} from '@zuse/tools'
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
  /** 用户已看过提示并确认继续。 */
  confirmed?: unknown
  /** 步骤 3 的第二种形态：跑一段代码，而不是一条命令。 */
  exec?: unknown
}

/**
 * 「这段代码用户已经确认过」的缓存，键 = `sha256(cwd + '\0' + code)`。
 *
 * **为什么在服务端**：键里必须含 cwd，而 cwd 只有服务端有
 * （见下面 startRun 的注释：绝不接受客户端传），且只在 201 响应里回 ——
 * 那已经是跑起来之后了。前端算不出这个键。
 *
 * **为什么按代码正文而不是按语言/按会话**：代码是逐字执行的，改一个字符就是另一段程序。
 * **为什么不写进 `permissions.allow`**：那是持久化的，一次点击换永久放行太重。
 *
 * 进程内存活，daemon 重启即清空 —— 这是刻意的，不是遗漏。
 */
const execConsent = new Set<string>()
/**
 * **sessionId 必须进键。** v4 §9 要的是「存 `sessionAllow`（**会话**内存层）」，
 * 而这里是个模块级 Set —— 键里不带 sessionId 就等于全局放行：
 * 会话 A 确认过的代码，会话 B（同一个项目目录，这是常态）点同一个按钮**不再问**。
 * 会话在这里本来就是一条真实边界（`registry.killSession()` 就是按它切的）。
 *
 * cwd 也必须在（v4 §9 的原始理由）：本仓会话的 cwd 是活的，模型 `cd ../other-project`
 * 之后同一条 `python check.py` 命中缓存、**跑的是另一个项目里的那个文件**。
 */
function consentKey(sessionId: string, cwd: string, code: string): string {
  return createHash('sha256').update(sessionId).update('\0').update(cwd).update('\0').update(code).digest('hex')
}
/** 仅供测试重置。 */
export function __resetExecConsent(): void { execConsent.clear() }

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
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  if (!sessionId) return bad('sessionId 不能为空')

  const exec = parseExec(body.exec)
  if (exec === 'bad-kind') return bad('不认识这种代码：本步只支持 python / java')

  const command = typeof body.command === 'string' ? body.command.trim() : ''
  if (!exec && !command) return bad('command 不能为空')

  const mgr = await deps.service.getOrLoad(sessionId)
  if (!mgr) return { status: 404, json: { error: { code: 'not_found', message: '找不到这个会话' } } }
  const cwd = mgr.getState().cwd

  if (exec) return startExec(exec, cwd, sessionId, body.confirmed === true, deps, makePolicy, buildEnv)

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

const EXEC_KINDS: ExecKind[] = ['python', 'java']

/**
 * 只从请求体里取 `kind` 和 `code` 两个字段，**其余一律无视**。
 *
 * 这不是防御式编程的洁癖：下面 `startExec` 要按这个结果**往磁盘写文件**。
 * 请求体里多塞的 `name` / `path` 之类必须一个字都进不了路径 —— 否则就是路径穿越。
 * 文件名只来自 `planExec` 返回的常量。
 */
function parseExec(raw: unknown): { kind: ExecKind; code: string } | null | 'bad-kind' {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as { kind?: unknown; code?: unknown }
  if (typeof o.code !== 'string') return null
  const kind = EXEC_KINDS.find((k) => k === o.kind)
  return kind ? { kind, code: o.code } : 'bad-kind'
}

function startExec(
  exec: { kind: ExecKind; code: string },
  cwd: string,
  sessionId: string,
  confirmed: boolean,
  deps: RunsRouteDeps,
  makePolicy: () => RunPolicy,
  buildEnv: (cwd: string) => NodeJS.ProcessEnv,
): RunRouteResult {
  const plan = planExec(exec.kind, exec.code)
  const key = consentKey(sessionId, cwd, exec.code)

  // 内容检测被实测排除了（step3 spec §0.1：误报可观、漏报 100% —— 那个闸是按 shell
  // 语法做的匹配，认不出 os.system("curl … | sh")，却会把带 `$` 的正则拦下来）。
  // 所以这里不检测内容，只是**明确说一次「这会在你电脑上真的执行」**，把判断权交给
  // 看得懂代码的人。确认过的按 hash(cwd+代码) 记住，改一个字符就重新问。
  if (!confirmed && !execConsent.has(key)) {
    return {
      status: 409,
      json: {
        error: { code: 'exec_confirm', message: '这会在你的电脑上真的执行这段代码。' },
        label: plan.label,
        ...(plan.hint ? { hint: plan.hint } : {}),
      },
    }
  }
  execConsent.add(key)

  // 每次一个全新目录。**文件名只用 plan 给的常量**，不拼任何来自请求体的字符串。
  const dir = mkdtempSync(join(tmpdir(), 'zuse-run-'))
  try {
    for (const f of plan.files) writeFileSync(join(dir, f.name), f.content, 'utf8')
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw e                                    // 落盘失败就是 500，不降级往别处写
  }

  const command = plan.command.split(EXEC_DIR_PLACEHOLDER).join(dir.replace(/\\/g, '/'))
  try {
    // cwd 用**会话的** cwd，不是临时目录 —— 脚本里 open("data.csv") 该读到用户项目里的文件。
    const run = deps.runs.start({ command, cwd, sessionId, policy: makePolicy(), env: buildEnv(cwd) })
    // 清理挂在 run 的结束事件上。**必须 internal: true** —— 否则这个订阅会算进
    // 「有没有人在看」，把片段档的 onDetach:'kill' 顶掉（步骤 2 刚踩过这个坑）。
    // 故意不在进程退出前删：Windows 上文件被占用时删除会失败。
    const off = run.subscribe((e) => {
      if (e.type !== 'end') return
      off()
      // 删不掉不上报给用户 —— tmp 里的垃圾不是用户的问题。
      try { rmSync(dir, { recursive: true, force: true }) } catch (err) { console.warn('[zuse-run] 临时目录没删掉', dir, err) }
    }, { internal: true })
    return { status: 201, json: { runId: run.id, cwd, dir, label: plan.label } }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    if (e instanceof RunLimitError) return { status: 429, json: { error: { code: 'too_many_runs', message: e.message } } }
    throw e
  }
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
  //
  // **绝不能写成 `const off = run.subscribe(cb)` 再在 `cb` 里引用 `off`。**
  // replay 会**同步**调用 `cb`（对一个已经结束的 run，第一次调用就是 end），
  // 那一刻 `off` 还在 TDZ 里，`off()` 抛 `Cannot access 'off' before initialization`。
  // 实测过这个后果：对已结束的 run 开流，`res.end()` 永远不执行、连接一直挂着，
  // 测试直接卡到超时。所以用「可变引用 + 补退订」这个绕法，别图好看改回去。
  let off: (() => void) | null = null
  let done = false
  const stop = (): void => {
    done = true
    if (off) { off(); off = null }
  }

  const cb = (e: RunEvent): void => {
    if (done) return                                    // 收尾之后来的一律不写（replay 同步阶段也可能已经收尾）
    // **写失败必须自己退订。** 库那边会拦住订阅者抛出的异常（否则整个 daemon 死 ——
    // 真跑复现过），但拦住之后订阅仍然留在 set 里：不在这里退订的话，一条写坏的响应
    // 会在之后**每一个**事件上再抛一次，日志被刷屏，而且片段档还会因为「还有订阅者」
    // 而误以为有人在看。写失败就是断连，按断连处理。
    try {
      res.write(`data: ${JSON.stringify(e)}\n\n`)
    } catch {
      stop()
      res.destroy()
      return
    }
    if (e.type === 'end') { stop(); res.end() }
  }

  off = run.subscribe(cb, { replay: true })
  // replay 同步阶段就收尾了 → 那时 `off` 还是 null，`stop()` 退不掉，这里补一次。
  if (done) { off(); off = null }

  // 客户端断开（关页面 / 切走）→ 退订。片段档的 onDetach:'kill' 会因此把进程收掉，
  // 项目档则保留可重连 —— 两档的差异全在 policy 里，这里一视同仁。
  req.on('close', stop)
  return true
}
