import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { ToolsConfig } from './types.js'

/**
 * 对一个工具输入的极简 JSON Schema 描述。模型读它来决定如何调用该工具。
 * 我们故意保持松散类型 —— 它会被原样传给厂商的 `tools` 参数。
 */
export interface JSONSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  [key: string]: unknown
}

/**
 * 把工具传入的路径解析成绝对路径：绝对路径原样返回，相对路径对着 cwd 解析。
 * 所有读写文件的工具共用这一处 —— Phase 5 的工作区边界/权限校验只需改这里，
 * 不必在每个工具里各自维护一份（否则漏掉一处就是一个越界漏洞）。
 */
export function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p)
}

/**
 * 文件内容指纹 —— read-before-edit 乐观锁的版本标识。
 * 用内容哈希而非 mtime：mtime 在粗粒度文件系统（FAT/部分网络盘/容器挂载）上
 * 分辨率可达 1~2 秒，同一时刻的外部改动 mtime 不变，会骗过相等比较的乐观锁；
 * 浮点 mtimeMs 的表示误差又会造成误判。内容哈希直接比"读的字节是不是这些"，
 * 既挡住 TOCTOU 同刻改动，也不会因时间精度误伤。代码文件不大，哈希成本可忽略。
 */
export function fingerprintContent(content: string): string {
  return createHash('sha1').update(content, 'utf8').digest('hex')
}

/**
 * 文件读取追踪器 —— read-before-edit 校验的状态载体（Phase 4）。
 * 记的不是"读过没"这个布尔位，而是"读的是哪个版本"：登记读取那一刻的
 * 内容指纹。Edit/Write 执行前重读文件、重算指纹比对，挡住两种危险：
 * ① 没读就改（盲改）；② 读完文件被外部改动、却基于过期快照改（TOCTOU）。
 * 这是一种乐观锁。
 */
export interface FileReadTracker {
  /** Read/Write/Edit 成功后登记：绝对路径 -> 当时的内容指纹。 */
  markRead(absPath: string, fingerprint: string): void
  /** 返回登记时的内容指纹；从未读过返回 undefined。 */
  getFingerprint(absPath: string): string | undefined
}

/** 基于 Map 的 FileReadTracker 默认实现。每个会话建一个。 */
export function createFileTracker(): FileReadTracker {
  const fingerprints = new Map<string, string>()
  return {
    markRead(absPath: string, fingerprint: string): void {
      fingerprints.set(absPath, fingerprint)
    },
    getFingerprint(absPath: string): string | undefined {
      return fingerprints.get(absPath)
    },
  }
}

/**
 * 交给工具 `run` 的运行时上下文。携带工作目录、一个 abort 信号
 *（用于 Ctrl+C 中断），以及 read-before-edit 用的文件追踪器。
 * 权限校验不在这里 —— 由 agent 循环在调用 `run` 之前统一过闸（见 agent.ts 的
 * gateAndRunTool）,工具自身无需关心。
 *
 * `cwd` 是本次调用的工作目录快照；agent 每次工具调用都按会话当前 cwd 重建 ctx,
 * 所以 Bash 里的 `cd` 通过 `setCwd` 回写后,后续工具就能看到新目录。
 */
export interface ToolContext {
  cwd: string
  signal: AbortSignal
  tracker: FileReadTracker
  /**
   * 由 Bash 工具回写"命令执行后的工作目录",让 `cd` 跨命令、跨工具持久化。
   * 可选：无头/测试场景构造的 ctx 可不提供（此时 cd 不持久,但命令照常执行）。
   */
  setCwd?(absPath: string): void
}

/**
 * 运行一个工具的结果。`output` 是作为 tool_result 块回喂给模型的文本。
 * `isError: true` 标记一次失败，好让模型被告知工具失败了，而不是默默地
 * 当作成功（故障模式④）。
 */
export interface ToolResult {
  output: string
  isError?: boolean
}

/**
 * 模型可以调用的一个工具。`input` 是模型按照 `inputSchema` 产生的非结构化
 * JSON，所以类型是 `unknown` —— 每个工具内部各自收窄（并校验）它。
 * `run` 干实际的活，返回供模型读取的文本。
 */
export interface Tool {
  name: string
  description: string
  inputSchema: JSONSchema
  run(input: unknown, ctx: ToolContext): Promise<ToolResult>
  /** 只读工具（Read/Glob/Grep 为 true），供 defaultMode 分类。 */
  readOnly?: boolean
  /** 返回用于规则限定符匹配的字符串：Bash 返回命令，文件工具返回路径；无则 null。 */
  specifierFor?(input: unknown): string | null
}

/** 发送给厂商 API `tools` 参数的形状。 */
export interface ToolDefinition {
  name: string
  description: string
  input_schema: JSONSchema
}

/**
 * ToolRegistry —— 注册/获取/列举。Agent 循环用 `getDefinitions()` 告诉模型
 * 有哪些工具，用 `get(name)` 执行模型选中的那一个。纯粹、无 I/O ——
 * 极易做单元测试。
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>()

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`)
    }
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  list(): Tool[] {
    return [...this.tools.values()]
  }

  /** 面向厂商的工具定义（名称 + 描述 + schema）。可按 tools 配置过滤暴露。 */
  getDefinitions(toolsConfig?: ToolsConfig): ToolDefinition[] {
    let tools = this.list()
    if (toolsConfig?.enabled) {
      const set = new Set(toolsConfig.enabled)
      tools = tools.filter((t) => set.has(t.name))
    }
    if (toolsConfig?.disabled) {
      const set = new Set(toolsConfig.disabled)
      tools = tools.filter((t) => !set.has(t.name))
    }
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }))
  }
}
