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
 * 交给工具 `run` 的运行时上下文。Phase 3 只携带工作目录和一个 abort 信号
 *（用于 Ctrl+C 中断 —— 后续才接线）。
 * Phase 5 会在这里加上 PermissionManager。
 */
export interface ToolContext {
  cwd: string
  signal: AbortSignal
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

  /** 面向厂商的工具定义（名称 + 描述 + schema）。 */
  getDefinitions(): ToolDefinition[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }))
  }
}
