# Phase 4 计划 · 工具集补全(Write/Edit/Bash/Glob/Grep/LS)

> 让模型从"只能读"升级到"能改、能跑、能找"。
> 参考:phase-roadmap §Phase 4;补充文档 §一(故障模式④);Claude Code 的 FileWriteTool / FileEditTool / BashTool / GlobTool / GrepTool。
> 延续 Phase 3 的两条不变量:① 工具错误以 `isError` 回喂模型(故障④);② 整轮原子落账由 agent loop 负责,工具本身只管单次执行。

## 0. 目标(本阶段做完能干什么)

跑起来后,问它"把 foo.ts 里的 bar 改成 baz 并跑一下测试",它会:
1. `Read` foo.ts(建立"已读"记录)→ `Edit` 精确替换 → `Bash` 跑 `pnpm test`,基于真实输出回答。
2. 问"项目里哪些文件用了 runAgent",它会 `Grep "runAgent"` 定位;问"有哪些测试文件",它会 `Glob "**/*.test.ts"`。
3. 误改未读文件时被 **read-before-edit 校验**拦下,收到 `isError`,自己先 Read 再重试 —— 不是崩溃,是被引导走正确流程。

## 1. 关键架构决策

### 决策 A:`FileReadTracker` 进 `ToolContext`(read-before-edit 的状态载体)

read-before-edit 需要一份"本会话哪些文件被读过"的共享记录。它天然属于运行时上下文,放进 `ToolContext`(与 `cwd`/`signal` 并列,Phase 5 的 PermissionManager 也会进这里)。

```ts
// core/tool.ts
export interface FileReadTracker {
  /** Read/Write 成功后登记:绝对路径 → 当时的 mtimeMs。 */
  markRead(absPath: string, mtimeMs: number): void
  /** 返回登记时的 mtimeMs;从未读过返回 undefined。 */
  getReadTime(absPath: string): number | undefined
}
export function createFileTracker(): FileReadTracker { /* Map 实现 */ }

export interface ToolContext {
  cwd: string
  signal: AbortSignal
  tracker: FileReadTracker   // 新增(必填)
}
```

- **生命周期**:由 TUI 在 `useConversation` 用 ref 持有一个 session 级 tracker,传入 `runAgent` → `ToolContext`。这样跨多次 submit 都记得(turn 1 Read、turn 3 Edit 也能过)。
- **runAgent 签名**:加可选参数 `tracker`,缺省时内部 `createFileTracker()` 新建一个 —— 保证 `agent.test.ts` 和无头调用不受影响。
- **波及**:`read.test.ts` 现在构造 `ctx = { cwd, signal }`,改成带 `tracker: createFileTracker()`。仅此一处。

### 决策 B:Read/Write 登记,Edit 校验

- `Read` 成功后 `markRead(absPath, mtimeMs)`。
- `Write` 成功后也 `markRead`(写完即"已读最新版",允许接着 Edit)。
- `Edit` 执行前两道校验:
  1. **必须读过**:`getReadTime(absPath)` 为 undefined → `isError`,提示先 Read。
  2. **快照未过期(乐观锁)**:当前 `stat.mtimeMs` ≠ 登记值 → `isError`,提示文件被外部改动、请重新 Read。
  校验通过后做精确串替换,成功后刷新 `markRead` 为新 mtime。

> 第 2 道(mtime 乐观锁)是 Claude Code 的进阶细节,教学价值高且实现便宜,本期纳入;若实测带来摩擦可在验收时摘掉,降级为只保留第 1 道。

### 决策 C:Glob 用 Node 内置,Grep 手搓 —— 零新依赖

环境 Node 22.22.0、`rg` 不在 PATH、tools 包当前零运行时依赖。

- **Glob**:`fs/promises` 的 `glob(pattern, { cwd })`(Node 22 稳定)。零依赖。
- **Grep**:不引 ripgrep。用同一套文件枚举 + 逐行正则扫描,返回 `file:line:text`。慢于 rg 但正确、可控、讲得清原理,契合"Mini Harness 最小依赖"。

### 决策 D:Bash = `child_process.spawn` + cwd + timeout + 截断 + signal

- input:`{ command: string; timeout?: number }`。`timeout` 毫秒,默认 120000,上限 600000。
- `spawn(command, { cwd: ctx.cwd, shell: true })`,合并 stdout/stderr,带退出码。
- 超时:`setTimeout` 到点 `child.kill()`,输出标注 `[timed out after Nms]`,`isError: true`。
- 中断:`ctx.signal` abort 时 kill 进程(为 Ctrl+C 铺路)。
- 长输出截断(复用常量,如 30000 字符),标注被截断。

### 决策 E:Phase 4 仍不做权限闸(留 Phase 5)

Write/Edit/Bash 都"不问自动执行"。在每个工具(尤其 Bash)留 `// TODO Phase 5: 权限校验` 锚点,与 Phase 3 的 `ToolContext` 注释一致。

## 2. 故障模式防御(本阶段)

- **④ 工具错误吞**(延续):六个工具的失败(路径不存在、未读就 Edit、`old_string` 不唯一/找不到、Bash 非零退出或超时、正则非法)统统转 `isError: true` 显式回喂,绝不假装成功。
- **read-before-edit**:把"必须先看到真实内容才能改"从"指望模型自觉"升级为**工具层硬约束**。

## 3. 文件清单(按 sub-step,一步一提交)

| step | 文件 | 动作 |
|---|---|---|
| 4.1 | `core/tool.ts` | 加 `FileReadTracker` 接口 + `createFileTracker()`;`ToolContext` 加 `tracker` |
| 4.1 | `core/agent.ts` | `runAgent` 加可选 `tracker` 参数,构造 `ToolContext` 时带上(缺省新建) |
| 4.1 | `core/index.ts` | 导出 `FileReadTracker` / `createFileTracker` |
| 4.1 | `tools/read.ts` + `read.test.ts` | Read 成功后 `markRead`;测试 ctx 补 `tracker` + 断言已登记 |
| 4.2 | `tools/write.ts` + `write.test.ts` | WriteTool(父目录自动建、写文件、写后 markRead);测试 |
| 4.3 | `tools/edit.ts` + `edit.test.ts` | EditTool(read-before-edit + mtime 乐观锁 + 唯一性 + `replace_all`);测试覆盖每条 isError |
| 4.4 | `tools/ls.ts` + `ls.test.ts` | LSTool(列目录,标注 dir/file);测试 |
| 4.5 | `tools/glob.ts` + `glob.test.ts` | GlobTool(`fs.glob`,相对 cwd,结果有界);测试 |
| 4.6 | `tools/grep.ts` + `grep.test.ts` | GrepTool(枚举 + 逐行正则,`file:line:text`,非法正则报错);测试 |
| 4.7 | `tools/bash.ts` + `bash.test.ts` | BashTool(spawn/cwd/timeout/截断/signal/非零退出);测试 |
| 4.8 | `tools/index.ts` | 全部注册进 `createDefaultRegistry()` + 导出 |
| 4.9 | `README.md` | 标记 Phase 4 完成 |
| 4.10 | — | typecheck + lint + test 全绿;手动端到端(读→改→跑) |

## 4. 各工具规格

### WriteTool
- input:`{ file_path: string; content: string }`,required 两者。
- 父目录不存在 → `mkdir -p`。写 UTF-8。成功输出 `Wrote N bytes to <path>` 并 `markRead`。
- 错误:路径是已存在目录 → isError。

### EditTool ⭐(本期核心)
- input:`{ file_path: string; old_string: string; new_string: string; replace_all?: boolean }`。
- 校验顺序:① 未读过 → isError;② mtime 变了 → isError;③ `old_string` 在文件中 0 次 → isError("未找到");④ 出现 >1 次且非 `replace_all` → isError("不唯一,请带更多上下文")。
- 通过后替换、写回、刷新 markRead。`new_string === old_string` 视为非法(无变化)。

### LSTool
- input:`{ path?: string }`(缺省 cwd)。返回条目列表,目录加 `/` 后缀。路径不存在/非目录 → isError。

### GlobTool
- input:`{ pattern: string; cwd?: string }`。相对 `ctx.cwd` 解析。结果上限(如 100 条)+ 超出标注。无匹配返回明确提示(非 error)。

### GrepTool
- input:`{ pattern: string; path?: string; glob?: string }`。`pattern` 为正则(`new RegExp` 失败 → isError)。用 Glob 枚举候选(默认全树,`glob` 可缩范围),逐行扫,输出 `相对路径:行号:命中行`。命中数 + 行长都设上限。

### BashTool
- 见决策 D。输出形如 `<合并的 stdout/stderr>\n[exit code: N]`;超时/非零退出 → isError。

## 5. 不做(本阶段)

- 权限闸 / PermissionManager(Phase 5)
- 多 provider / cache 标记(Phase 6)
- Grep 引 ripgrep 提速(本期手搓;若日后嫌慢再议,记 BACKLOG)
- Bash 的交互式命令、TTY、后台进程管理(只做一次性命令 + 超时)
- Windows 下 kill 进程树的完整覆盖(`child.kill()` 在 Windows 杀子进程有局限,留注释说明)

## 6. 验收

- `pnpm typecheck` / `pnpm lint` / `pnpm test` 全绿。
- 新单测:Write、Edit(每条 isError 路径都覆盖,尤其"未读就改""old_string 不唯一")、LS、Glob、Grep、Bash(含超时与非零退出)。
- 手动:配好 .env,`pnpm dev`,让它完成一次"读文件 → 改一行 → 跑命令验证"的闭环。
