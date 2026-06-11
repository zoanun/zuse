# 可点击查看全文(临时文件链接 + 清理)设计文档

- 日期:2026-06-11
- 状态:已定(用户在线确认范围:粘贴展开=A、Grep content 可点、临时文件 >7 天启动清理)
- 范围:`packages/tui`

## 1. 背景

zuse 已有「工具超长输出落临时文件 + OSC-8 可点击链接」机制(`toolOutputFile.ts`:`writeToolOutputFile` 写 `tmpdir()/zuse/<name>-<ts>-<rand>.txt`,`osc8FileLink` 包 OSC-8)。但有三处缺口/隐患,本设计一并收口:

1. **临时文件不清理**:`toolOutputFile.ts` 注释「由系统自行回收」对 Windows 偏乐观——`%TEMP%` 默认不自动清,文件会堆积。
2. **Grep content/count 模式不可点**:`summarizeOutput` 把它们归为 `kind:'line'`(只一行计数),`useConversation` 的落盘条件只覆盖 `preview`/`files` 且 `moreCount>0`,故 content 模式的命中行**既不落盘也无链接**——内容只进了模型,UI 看不到。
3. **粘贴折叠发送后无法回看全文**:第二期把折叠标签发送后只显标签、全文仅发模型;用户想点开看原文。

## 2. 目标

- **A1 临时文件清理**:启动时 prune `tmpdir()/zuse/` 里 mtime 早于 **7 天**的文件;不删本会话新建的(发完还能点)。跨平台、不依赖系统回收。
- **A2 Grep content/count 可点**:给「会隐藏内容」的 `line` 摘要(当前为 Grep `content` / `count` 模式)落临时文件,并在 `OutputCell` 的 `line` 分支渲成 OSC-8 链接(有 `outputFile` 才点)。Read/Edit/Write 等不隐藏内容的 `line` 摘要不加链接、不落盘。
- **A3 粘贴展开**:提交时把每段折叠粘贴的全文写临时文件,`UIMessage` 携 id→路径;滚动区回显的 `[粘贴#N · …]` 标签渲成 OSC-8 链接。

## 3. 非目标

- 不改模型侧内容(模型始终拿完整输出/全文,本设计只动 UI 展示层与临时文件)。
- 不做应用内查看器(复用「点链接→系统/编辑器打开 txt」,不自绘弹窗)。
- 不改 Grep/工具本身的协议与截断逻辑。

## 4. 模块布局

| 文件 | 改动 | 职责 |
|---|---|---|
| `packages/tui/src/toolOutputFile.ts` | 改 | 新增 `pruneOldTempFiles(maxAgeMs)`:删 `tmpdir()/zuse/` 里超龄文件;`writeToolOutputFile` 保持不变 |
| `packages/tui/src/index.tsx` | 改 | 启动时调一次 `pruneOldTempFiles(7 天)`(try/catch 包,失败不影响启动) |
| `packages/tui/src/hooks/useConversation.ts` | 改 | 扩展落盘条件:Grep `content`/`count` 模式(有命中)也 `writeToolOutputFile`;粘贴展开的临时文件在提交路径写 |
| `packages/tui/src/components/toolSummary.ts` | 改 | 让落盘判定可复用:导出一个「该摘要是否隐藏内容、需落盘」的判定(见 §6) |
| `packages/tui/src/components/StreamRenderer.tsx` | 改 | `OutputCell` 的 `line` 分支:有 `outputFile` 时渲成 OSC-8 链接;user 消息的 `[粘贴#N]` 标签按 `pasteFiles` 渲成链接 |
| `packages/tui/src/types.ts` | 改 | `UIMessage += pasteFiles?: Record<number, string>`(id→临时文件路径) |
| `packages/tui/src/components/InputBox.tsx` | 改 | 提交时为每段 paste 写临时文件,产出 `pasteFiles`,`onSubmit(full, display, pasteFiles)` |
| `packages/tui/src/App.tsx` / `useConversation.ts` | 改 | `handleSubmit`/`submit`/`sendMessage` 透传 `pasteFiles` 到 `UIMessage` |

## 5. A1:临时文件清理

```ts
// toolOutputFile.ts
/** 删除 tmpdir()/zuse/ 下 mtime 早于 now-maxAgeMs 的文件。失败静默(best-effort 清理)。 */
export function pruneOldTempFiles(maxAgeMs: number, now: number): void
```
- 实现:`readdirSync(dir)` → 对每个文件 `statSync` 取 mtimeMs,`now - mtimeMs > maxAgeMs` 则 `unlinkSync`;整体 try/catch,单个文件失败跳过。
- `now` 作参数传入(便于单测;`Date.now()` 在脚本环境不可用,但此处是运行时 React/Node,可在 index.tsx 调用处传 `Date.now()`)。
- index.tsx 启动:`pruneOldTempFiles(7 * 24 * 60 * 60 * 1000, Date.now())`,try/catch。
- 不删本会话文件:7 天阈值天然保证(本会话文件 mtime≈now)。

## 6. A2:Grep content/count 可点

- **落盘条件扩展**(useConversation tool-result):除现有 `(preview|files) && moreCount>0` 外,增加「摘要隐藏了内容」的情形。为避免 useConversation 内嵌 Grep 细节,在 `toolSummary.ts` 导出纯判定:
  ```ts
  /** 该工具结果的 line 摘要是否「隐藏了完整内容」、值得落盘给链接(当前:Grep content/count 有命中)。 */
  export function lineSummaryHidesContent(tool: UIToolCall): boolean
  ```
  逻辑:`tool.name==='Grep'` 且 `output_mode∈{content,count}` 且输出非「No matches」。useConversation:
  ```ts
  const truncated = (summary.kind==='preview' || summary.kind==='files') && summary.moreCount>0
  const hides = summary.kind==='line' && lineSummaryHidesContent(probe)
  const outputFile = (truncated || hides) ? writeToolOutputFile(name, event.output) : undefined
  ```
- **渲染**(OutputCell `line` 分支):
  ```ts
  if (summary.kind === 'line') {
    return tool.outputFile
      ? <Text dimColor>{osc8FileLink(tool.outputFile, summary.text)}</Text>
      : <Text dimColor>{summary.text}</Text>
  }
  ```
  即整段计数文字成为链接热区;无 outputFile 时回落纯文本(Read/Edit/Write 等不变)。

## 7. A3:粘贴展开

- 提交时(InputBox.handleSubmit):对 `model.pastes` 里每个 `(id, content)`,`writeToolOutputFile('paste', content)` 拿路径,组成 `pasteFiles: Record<number, string>`(只对真正发出去的 paste 落盘)。落盘失败的 id 不进 map(链接退化为纯文本标签)。
- `onSubmit(full, display, pasteFiles)` → App → submit → sendMessage → `UIMessage.pasteFiles`。
- **渲染**(StreamRenderer user 分支):displayText 里的 `[粘贴#N · …]` 用正则 `/\[粘贴#(\d+) · [^\]]*\]/g` 切分;每个匹配若 `pasteFiles[N]` 存在 → `osc8FileLink(path, 匹配串)`,否则纯文本。其余文本段原样。按行渲染(displayText 仍可能多行)。
  - 抽一个纯函数 `splitPasteLabels(line): Array<{text:string, id?:number}>` 便于单测;StreamRenderer 据 `pasteFiles` 包链接。

## 8. 数据流(粘贴展开)

```
提交:InputBox
  full = expand(buf.text, pastes)              // 发模型(不变)
  display = toDisplay(buf.text, pastes)         // [粘贴#N] 标签串(不变)
  pasteFiles = { id: writeToolOutputFile('paste', content) }   // 新:每段落盘
  onSubmit(full, display, pasteFiles)
→ submit(input, displayText, pasteFiles) → sendMessage(...) → UIMessage{ text:full, displayText, pasteFiles }
回显:StreamRenderer user
  按行 splitPasteLabels(line) → 标签段查 pasteFiles[id] → 有则 OSC-8 链接,无则纯文本
```

## 9. 错误处理 / 边界

- 落盘失败(磁盘满/无权限):`writeToolOutputFile` 返回 undefined → 对应链接退化为纯文本(标签/计数仍可见)。主流程不受影响。
- prune 失败:try/catch 静默,不阻塞启动。
- OSC-8 不被终端支持:退化为纯文本(现有机制已如此)。
- 终端把 `tmpdir()/zuse/` 当只读/不可建:writeToolOutputFile 已 try/catch 返回 undefined。
- 多段粘贴:各自独立 id/文件/链接。
- 单行粘贴:不折叠、无 paste 文件。

## 10. 测试策略

- `toolOutputFile.test.ts`:`pruneOldTempFiles` —— 造若干文件(改 mtime 或用可注入 now),断言超龄删、未超龄留、目录不存在不报错。
- `toolSummary.test.ts`:`lineSummaryHidesContent` —— Grep content/count 有命中=true、No matches=false、Read/Edit/Write/files 模式=false。
- `StreamRenderer.test.ts`:`line` 摘要有 outputFile → 帧含 OSC-8 链接(可断言含 file:// 或路径);user 消息 `[粘贴#1]` 在 pasteFiles 命中时渲成链接、未命中纯文本。
- `splitPasteLabels` 纯函数单测:多标签、标签夹文本、无标签。
- InputBox.test:提交后 onSubmit 第三参 pasteFiles 含各 id→路径(可 mock writeToolOutputFile 或断言路径形态)。
- 手动冒烟:Grep content 结果点开看命中行;粘贴发送后点标签看原文;重启后旧 txt 被清(改系统时间或等价验证从略,人工抽查目录)。

## 11. 自检

- 三块(清理 / Grep 可点 / 粘贴展开)共用 writeToolOutputFile + osc8FileLink + prune,无重复机制。
- 落盘范围收敛:只对「隐藏内容」的摘要与「真正发出的粘贴」落盘,不平白生成文件。
- 模型侧不变(全文照旧)。
- 与既有 outputFile 渲染(preview/files)风格一致。
