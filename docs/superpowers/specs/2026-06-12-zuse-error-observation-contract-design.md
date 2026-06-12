# Zuse 错误回传契约(Observation Contract)设计 —— Phase 8

日期:2026-06-12
状态:已定
对应 roadmap:Phase 8(错误回传契约),对故障模式④「工具错误吞」的系统性收口。

## 1. 核心原则

**工具交还给模型的一切(成功输出 / 报错 / 截断块)都是写给模型读的 observation,不是写给开发者的日志。**

每条失败 observation 必须满足三条:

1. **不抛裸异常、不回 stack trace** —— 失败以 `ToolResult{ isError: true }` 返回,文本是自然语言。
2. **说清发生了什么** —— 带具体的入参回显(路径、pattern、exit code),让模型能定位。
3. **带下一步指令** —— 模型读完知道接下来该干什么(重读文件 / 换工具 / 改入参 / 别再重试)。

参考:Crush `internal/agent/tools/edit.go`(失败回纠正指令,如 "you must read the file
before editing it. Use the View tool first")、OpenCode `tool/edit.ts` 错误分支。

## 2. 现状盘点(2026-06-12 全量审计)

把 `packages/tools/src/` + `packages/core/src/agent.ts` 所有 `isError: true` 路径过了一遍:

**已达标(不动)**:Edit/Write 的 read-before-edit 与 mtime 乐观锁(自带"Read it again
before editing")、Edit old_string 不唯一("Add more surrounding context… or set
replace_all")、Read 截断尾("pass offset: N to continue")、Glob 截断尾("narrow the
pattern for the rest")、WebSearch 鉴权拉黑("fix the API key and restart")、WebFetch
SPA 提示、Lsp 安装指引("Call LspInstall with lang=… Do NOT silently switch to Grep")、
各工具坏入参("X requires a …")。这些本来就是按契约写的。

**有差距(本期收口)**:

| 位置 | 现状 | 问题 |
| --- | --- | --- |
| `core/agent.ts` gateAndRunTool | `Unknown tool: nope` | 没告诉模型有哪些工具可用 |
| `core/agent.ts` deny(settings) | `Permission denied by settings (rule).` | 没说"别原样重试"+"硬护栏"性质 |
| `core/agent.ts` deny(user) | `Permission denied by user (rule).` | 没说下一步(问用户 / 换路子) |
| `tools/read.ts` 文件不存在 | `File not found: X` | 没给定位手段(Glob) |
| `tools/read.ts` readFile 抛错 | 裸抛 → agent 兜底 `Tool "Read" failed: EACCES…` | 裸 errno 串,无指引 |
| `tools/read.ts` 二进制文件 | 乱码当正文喂给模型 | 应识别并拒读,指引换 Bash 检查 |
| `tools/edit.ts` old_string 未命中 | `old_string not found in X.` | 没说最常见原因(空白/缩进漂移)与下一步(重读) |
| `tools/edit.ts` 读后文件被删 | `File not found: X` | 没提示"读过之后被删了" |
| `tools/bash.ts` 超时 | `[timed out after Nms]` | 没说可调 timeout 入参 |
| `tools/bash.ts` exit 127 | `[exit code: 127]` | 127=命令不存在是高频失因,应点破 |

## 3. 设计决策

- **D1 改文案不改结构**:`ToolResult` 形状、`is_error` 回喂管线(Phase 3 已建)全部不动,
  本期只改失败文本本身。错误分类枚举(`ErrorCategory`)是模型调用层的事(failover 已做),
  工具层 observation 不需要机器可读分类——读者是模型,自然语言即契约。
- **D2 权限拒绝两档语义分开**:settings deny 是**硬护栏**(配置写死,重试无意义,模型应换
  路子或让用户改配置);user deny 是**本次裁决**(用户刚按了拒绝,模型应问用户意图,不该
  立刻原样重发)。两条文案分别写。
- **D3 Unknown tool 列出可用清单**:`registry.list()` 现成,把工具名列进去,纠错成本最低
  (典型场景:模型把 `Read` 写成 `read_file`)。
- **D4 Read 二进制检测用 NUL 字节**:`raw.includes('\0')` 即判二进制——廉价、零依赖、
  足够准(UTF-8 文本不含 NUL)。检测命中不 markRead(读到的不是真内容,不给 Edit 通行证)。
- **D5 exit 127 单列**:POSIX shell 与 git-bash 一致用 127 表"command not found",
  在 exit code 行内点破并给下一步(查拼写 / 装它 / 用绝对路径)。其余非零码不猜原因——
  stderr 已在 body 里,模型自己读。
- **D6 agent.ts 兜底 catch 保持现状**:`Tool "X" failed: ${err.message}` 不含 stack
  (`.message` 本就无栈),它是真正意外的最后防线;工具内部能预见的失败(如 Read 的
  EACCES)应在工具内变成带指引的 observation,而不是指望兜底层补救。本期给 Read 补
  readFile 的 try/catch,其余工具维持。

## 4. 文案规格(实现以此为准)

- Unknown tool:
  `Unknown tool: ${name}. Available tools: ${names.join(', ')}.`
- deny by settings:
  `Permission denied by settings rule "${rule}". This is a hard guardrail; do not retry the same call. Take a different approach, or ask the user to change their permission settings.`
- deny by user:
  `The user declined this ${name} call (rule: ${rule}). Do not retry the same call. Ask the user how to proceed, or take a different approach.`
- Read 文件不存在:
  `File not found: ${path}. Check the path, or use Glob to locate the file.`
- Read 读失败(EACCES 等):
  `Failed to read ${path}: ${err.message}. Check file permissions, or inspect it with Bash.`
- Read 二进制:
  `${path} appears to be a binary file; Read only supports text. Use Bash (e.g. \`file\`) to inspect it.`
- Edit old_string 未命中:
  `old_string not found in ${path}. The file content may differ from what you expect (check whitespace and indentation). Read the file again and copy the exact text.`
- Edit 读后文件被删:
  `File not found: ${path} (it existed when read but is gone now). Re-check the path or recreate it with Write.`
- Bash 超时:
  `[timed out after ${timeout}ms; partial output above. Increase the timeout parameter for long-running commands]`
- Bash exit 127:
  `[exit code: 127 — command not found. Check the spelling, install it, or use an absolute path]`

## 5. 验证(TDD)

每条新文案一条失败路径测试,断言返回文本**含下一步指令的关键词**(如 `Glob`、
`do not retry`、`Read the file again`、`timeout parameter`、`command not found`),
而非仅断言 isError。已达标路径已有测试覆盖,不重复加。

## 6. 不做(out of scope)

- 坏 JSON tool_use 的回喂(「你的入参不是合法 JSON,请重发」)→ Phase 11 故障注入。
- 大输出塑形归一(head+tail 截断策略)→ Phase 9。
- 错误的机器可读分类透传到 TUI → failover 已覆盖模型调用层,工具层无此需求。
