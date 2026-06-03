# 第三批:`@zuse/tools` 工具层(P3)

这是 Phase 3 新增的包。它放**具体的工具实现**——模型能调来真正读文件、(以后)写文件、跑命令的那些东西。

为什么单独一个包,而不塞进 core?因为依赖方向:**`core` 谁都不依赖,`tools → core`,`tui → core, tools`**。core 只定义"什么是工具"(`Tool` 接口、`ToolRegistry`),具体工具是脏活(碰文件系统、跑子进程),放在依赖 core 的 tools 包里。core 保持纯净、可单测;工具实现可以随便加,不污染核心。

P3 只有一个工具(`Read`)。文件:

| 文件 | 职责 |
|------|------|
| `read.ts` | `ReadTool` —— 读文本文件,带行号输出 |
| `index.ts` | 导出工具 + `createDefaultRegistry()`(预装好工具集的登记表) |

---

## 1. read.ts —— `ReadTool`

一个满足 core `Tool` 接口的对象:`{ name: 'Read', description, inputSchema, run }`。仿照 Claude Code 的 FileReadTool。

**`inputSchema`**(模型读它来决定怎么调):
- `file_path`(必填,string)——要读的文件路径,相对路径相对工作目录解析。
- `offset`(可选,number)——从第几行开始读(**1-based**)。
- `limit`(可选,number)——最多读多少行,默认 `DEFAULT_LIMIT = 2000`。

两个常量:`DEFAULT_LIMIT = 2000`(一次最多返回的行数,output 有界)、`MAX_LINE_LENGTH = 2000`(单行超长就截断,避免把压缩成一行的文件整坨吐出来)。

**`run(rawInput: unknown, ctx)`** 逐步:

1. **收窄 + 校验**:`const input = (rawInput ?? {}) as ReadInput`;`file_path` 缺失或不是 string → 返回 `{ output: 'Read requires a file_path.', isError: true }`。注意——**不抛异常,而是返回 `isError` 结果**,这样错误会被喂回模型让它纠正(故障模式④)。
2. **解析路径**:`isAbsolute(file_path) ? file_path : resolve(ctx.cwd, file_path)`——绝对路径直接用,相对路径相对 `ctx.cwd` 解析。这就是 `ToolContext.cwd` 的用处。
3. **stat 探查**:
   - `stat` 抛错(文件不存在)→ `File not found` + `isError: true`。
   - 是目录 → `Path is a directory, not a file` + `isError: true`。(所以现在 Read **读不了目录**,这是有意的;列目录是另一个工具/Glob 的活。)
4. **读内容**:空文件 → 返回一句 `(file is empty: …)`,但 `isError: false`(空不是错)。
5. **切片 + 编号**:按 `\n` 拆行;`start = max(0, (offset ?? 1) - 1)`(1-based 转 0-based);`slice(start, start + limit)`;每行格式化成 `${行号}\t${文本}`(cat -n 风格),超 `MAX_LINE_LENGTH` 的单行截断加 `…[truncated]`。
6. **截断提示**:如果文件还有更多行没读完,末尾附 `[truncated: showing lines X-Y of Z]`,让模型知道"还有,可以用 offset 继续读"。

输出范例(读一个 3 行文件):
```
1	import x from 'y'
2
3	export const z = 1
```

---

## 2. index.ts —— 导出 + 默认登记表

```ts
import { ToolRegistry } from '@zuse/core'
import { ReadTool } from './read.js'

export { ReadTool }

/** 预装好 v1 工具集的登记表。P3:只有 Read。 */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(ReadTool)
  return registry
}
```

`createDefaultRegistry()` 是这个包对外的主要入口——TUI 的 `App.tsx` 调它拿到一个预装好工具的 `ToolRegistry`,再传给 `useConversation` → `runAgent`。**加新工具 = 写一个新 `Tool` + 在这里多 `register` 一行。**

---

**一句话:** tools 包是"脏活集合"——每个工具自己收窄校验输入、自己碰 I/O、把成败都用 `ToolResult` 表达;core 只规定接口,tools 负责实现,`createDefaultRegistry()` 把它们打包交给上层。P4 会往这里加 `Write` / `Edit` / `Bash` / `Glob` / `Grep`。
