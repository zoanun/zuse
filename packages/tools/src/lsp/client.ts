import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node'
import {
  InitializeRequest,
  InitializedNotification,
  DidOpenTextDocumentNotification,
  DefinitionRequest,
  ReferencesRequest,
  HoverRequest,
  WorkspaceSymbolRequest,
  ShutdownRequest,
  ExitNotification,
  type Position,
  type Location,
  type LocationLink,
  type Hover,
  type InitializeParams,
  type SymbolInformation,
  type WorkspaceSymbol,
} from 'vscode-languageserver-protocol'
import { findOnPath, killTree } from '../util.js'
import { queryWithWarmup } from './warmup.js'
import type { LanguageServerConfig } from './servers.js'

/** 就绪等待与 initialize 握手的总超时（毫秒）。超时不算致命，降级放行。 */
const READY_TIMEOUT = 30_000
/** 单次查询请求的超时（毫秒）。到点 reject。 */
const REQUEST_TIMEOUT = 20_000
/** dispose 时 shutdown 请求的短宽限（毫秒）。 */
const SHUTDOWN_GRACE = 2_000
/** shutdown/exit 之后到 killTree 兜底的延时（毫秒）。 */
const KILL_DELAY = 500
/** 冷启动暖场重试的退避时延（毫秒）：tsserver 后台加载工程期间 navto 会空，等它就绪。 */
const WARMUP_DELAYS = [500, 1000, 2000, 3000]
/** 普通定时睡眠。 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * $/progress 通知的 value 形态（只关心 kind，用来判断索引是否结束）。
 * 服务器侧 value 是 WorkDoneProgress 的 begin/report/end 之一。
 */
interface ProgressParams {
  value?: { kind?: string }
}

/** 类型化 LSP 错误；installHint 用于「没装」场景回喂安装命令。 */
export class LspError extends Error {
  constructor(message: string, readonly installHint?: string) {
    super(message)
    this.name = 'LspError'
  }
}

/** definition 的返回可能是 Location | Location[] | LocationLink[] | null，归一为 Location[]。 */
function toLocations(result: Location | Location[] | LocationLink[] | null): Location[] {
  if (!result) return []
  const arr = Array.isArray(result) ? result : [result]
  // LocationLink 用 targetUri/targetRange，Location 用 uri/range —— 按字段判别归一。
  return arr.map((r) =>
    'targetUri' in r ? { uri: r.targetUri, range: r.targetRange } : r,
  )
}

/** 给一个 Promise 加超时；到点 reject 一个 LspError。 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new LspError(`${label} timed out after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(t)
        reject(e instanceof Error ? e : new LspError(String(e)))
      },
    )
  })
}

/**
 * LspClient —— 封装「一个 server 进程 + 一条 vscode-jsonrpc 连接」。
 * 生命周期五阶段：启动 spawn → initialize 握手 → 就绪等待 → didOpen 干活 → 优雅关闭。
 * 同一 client 内对同一文件只 didOpen 一次（记一个 Set<uri>）。
 */
export class LspClient {
  /** 已 didOpen 过的文件 uri 集合，避免重复 open。 */
  private opened = new Set<string>()
  /** workspace/symbol 暖场状态：拿到过非空结果后置真，之后空结果不再重试。 */
  private readonly warm = { warmed: false }

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly conn: MessageConnection,
    private readonly config: LanguageServerConfig,
  ) {}

  /** 启动：spawn → 建连 → initialize 握手 → 就绪等待。失败抛 LspError。 */
  static async start(
    config: LanguageServerConfig,
    cwd: string,
    dataDir: string | undefined,
    signal: AbortSignal,
  ): Promise<LspClient> {
    // spawn 前先确认命令存在。Windows 走 shell:true（cmd.exe）时，命令不存在不会触发
    // child 的 'error'(ENOENT)——cmd.exe 自身正常启动并退出，于是「没装」不会快速失败，
    // 而要死等到 initialize 超时（30s）才抛个不带 installHint 的泛化错误。故按 PATHEXT
    // 预解析一次（findOnPath 已识别 .CMD 等启动器），找不到立即抛带 installHint 的 LspError。
    if (!findOnPath(config.command)) {
      throw new LspError(
        `Language server '${config.command}' not found. Install: ${config.installHint}`,
        config.installHint,
      )
    }
    const rawArgs = [...config.args, ...(config.dataDirArg && dataDir ? config.dataDirArg(dataDir) : [])]
    // Windows 上语言服务器多为 npm 全局安装的 .CMD 启动器（typescript-language-server.CMD 等），
    // 而 spawn 不开 shell 时不套用 PATHEXT，按裸名 spawn 会 ENOENT。故 win32 走 shell（cmd.exe），
    // 由它按 PATHEXT 解析 .CMD —— 与 Bash 工具同款思路。killTree 用 taskkill /T 收掉 cmd 这棵树。
    const useShell = process.platform === 'win32'
    // shell:true 下 Node 把 command 与 args 以空格拼成一行交给 cmd，不做转义，
    // 故含空格的参数（如 jdtls 的 -data <临时目录>）需自行加引号，避免被拆断。
    const args = useShell ? rawArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : rawArgs
    let child: ChildProcessWithoutNullStreams
    try {
      // 不传 stdio 选项时 stdin/stdout/stderr 均为管道（非空），故可安全收窄为无空流类型。
      child = spawn(config.command, args, { cwd, shell: useShell }) as ChildProcessWithoutNullStreams
    } catch (e) {
      throw new LspError(`Failed to spawn ${config.command}: ${(e as Error).message}`, config.installHint)
    }
    // spawn 的 ENOENT 是异步通过 'error' 事件来的（不是同步 throw），需监听后与握手赛跑。
    const spawnErr = new Promise<never>((_, reject) => {
      child.on('error', (e: NodeJS.ErrnoException) => {
        reject(
          new LspError(
            e.code === 'ENOENT'
              ? `Language server '${config.command}' not found. Install: ${config.installHint}`
              : `${config.command} failed: ${e.message}`,
            config.installHint,
          ),
        )
      })
    })
    const conn = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
    )
    const client = new LspClient(child, conn, config)
    const ready = client.handshakeAndReady(cwd, signal)
    try {
      await Promise.race([ready, spawnErr])
    } catch (e) {
      // 启动失败：杀掉可能已起来的进程并清理连接，避免孤儿。
      killTree(child.pid)
      conn.dispose()
      throw e
    }
    return client
  }

  /** initialize 握手 + 按 config.ready 等待就绪（带超时降级 + signal 中断）。 */
  private async handshakeAndReady(cwd: string, signal: AbortSignal): Promise<void> {
    // 就绪通知/进度要在 initialize 之前挂好监听，避免竞态丢通知。
    let resolveReady!: () => void
    const readySignal = new Promise<void>((r) => {
      resolveReady = r
    })
    if (this.config.ready === 'awaitNotification' && this.config.readyNotification) {
      // 自定义就绪通知（jdtls 的 language/status，payload type === 'ServiceReady'）。
      // onNotification 的 string 重载 handler 为 GenericNotificationHandler((...params) => …)，
      // 这里只关心首个参数，显式 typed 为 unknown 以避免隐式 any。
      this.conn.onNotification(this.config.readyNotification, (p: unknown): void => {
        if (!p || (p as { type?: string }).type === 'ServiceReady') resolveReady()
      })
    }
    if (this.config.ready === 'awaitProgress') {
      // 索引型服务器（gopls/rust-analyzer）：监听 $/progress 的 end 类进度即视为就绪。
      this.conn.onNotification('$/progress', (p: unknown): void => {
        if ((p as ProgressParams | null)?.value?.kind === 'end') resolveReady()
      })
    }
    this.conn.listen()

    const rootUri = pathToFileURL(cwd).toString()
    const params: InitializeParams = {
      processId: process.pid,
      rootUri,
      capabilities: {},
      initializationOptions: this.config.initializationOptions,
      workspaceFolders: [{ uri: rootUri, name: 'root' }],
    }
    await withTimeout(this.conn.sendRequest(InitializeRequest.type, params), READY_TIMEOUT, 'initialize')
    await this.conn.sendNotification(InitializedNotification.type, {})

    if (this.config.ready === 'immediate') return

    // 慢启动：等就绪通知/进度，或到达就绪超时后降级放行（不抛错），或被 signal 中断。
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, READY_TIMEOUT) // 超时降级：直接放行
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(new LspError('Startup aborted'))
      }
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void readySignal.then(() => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve()
      })
    })
  }

  /** 首次查某文件前发 didOpen（同一文件只 open 一次）。 */
  openDocument(absPath: string, text: string): void {
    const uri = pathToFileURL(absPath).toString()
    if (this.opened.has(uri)) return
    void this.conn.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId: this.config.id, version: 1, text },
    })
    this.opened.add(uri)
  }

  /** 跳定义：返回归一后的 Location[]。 */
  async definition(absPath: string, position: Position): Promise<Location[]> {
    const uri = pathToFileURL(absPath).toString()
    const r = await withTimeout(
      this.conn.sendRequest(DefinitionRequest.type, { textDocument: { uri }, position }),
      REQUEST_TIMEOUT,
      'definition',
    )
    return toLocations(r)
  }

  /** 找引用：context.includeDeclaration = true，把声明本身也算进去。 */
  async references(absPath: string, position: Position): Promise<Location[]> {
    const uri = pathToFileURL(absPath).toString()
    const r = await withTimeout(
      this.conn.sendRequest(ReferencesRequest.type, {
        textDocument: { uri },
        position,
        context: { includeDeclaration: true },
      }),
      REQUEST_TIMEOUT,
      'references',
    )
    return r ?? []
  }

  /**
   * 按符号名全工程搜索（workspace/symbol）：不需要文件，适合「还不知道符号在哪」的冷查询。
   * 服务器侧是模糊匹配，返回 SymbolInformation[] 或 WorkspaceSymbol[]；null 归一为空数组。
   */
  async workspaceSymbol(
    query: string,
    signal?: AbortSignal,
  ): Promise<(SymbolInformation | WorkspaceSymbol)[]> {
    const navto = async (): Promise<(SymbolInformation | WorkspaceSymbol)[]> => {
      const r = await withTimeout(
        this.conn.sendRequest(WorkspaceSymbolRequest.type, { query }),
        REQUEST_TIMEOUT,
        'workspace/symbol',
      )
      return r ?? []
    }
    // 冷启动时 tsserver 还在加载工程，navto 先空后有；暖场后空即真空，不再重试。
    return queryWithWarmup(navto, this.warm, WARMUP_DELAYS, sleep, () => signal?.aborted ?? false)
  }

  /** 看类型/悬停信息：无 hover 时返回 null。 */
  async hover(absPath: string, position: Position): Promise<Hover | null> {
    const uri = pathToFileURL(absPath).toString()
    const r = await withTimeout(
      this.conn.sendRequest(HoverRequest.type, { textDocument: { uri }, position }),
      REQUEST_TIMEOUT,
      'hover',
    )
    return r ?? null
  }

  /** 优雅关闭：shutdown 请求 + exit 通知，短宽限后 killTree 兜底，最后释放连接。 */
  async dispose(): Promise<void> {
    try {
      // ShutdownRequest.type 是 ProtocolRequestType0（无参），exit 同理无参。
      await withTimeout(this.conn.sendRequest(ShutdownRequest.type), SHUTDOWN_GRACE, 'shutdown')
      await this.conn.sendNotification(ExitNotification.type)
    } catch {
      // 忽略：握手没回应或已断连，直接走杀树兜底。
    }
    // 给进程一点时间自行退出；没退就杀整棵树防孤儿。
    setTimeout(() => killTree(this.child.pid), KILL_DELAY)
    this.conn.dispose()
  }
}
