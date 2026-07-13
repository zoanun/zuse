# I5b 任意文件上传 + agent/skill 解析 设计

> **状态**：设计已与用户确认，待 writing-plans。I5 的第二个子系统（I5a 已上线）。
> **依据**：扫了 cc-haha / opencode / hermes-agent / openclaw 四家实现（2026-07-12 均更新至最新）。
> 一致结论：交互式附件普遍"**存下来 + 给模型路径**"，**不建服务端格式解析器注册表**，解析交给模型的
> 工具/skill；skill 选择是模型自己的判断（靠描述匹配），**无人做"按文件类型→skill 的选择器 UI"**。
> hermes 的加强被采纳：给路径的同时**在说明里点名一个工具/skill**，降低模型把球踢回用户的概率。

## 目标

用户可上传**任意文件**（图片、粘贴文本之外的一切：pdf/docx/csv/zip/二进制…）。**服务端只负责存储**，不做任何格式解析。发送时给模型一条**文本说明 + 文件的绝对路径**，让模型用 Read/Bash 或相应 skill/agent 自行处理；处理不了就由模型直说（不再有服务端"无法解析"徽标）。

附带一个 I5a 小改：**粘贴文本过大时按 CC 方式截断**发给模型的内容。

## 非目标（明确不做，四家也都不做）

- 不建服务端"按 MIME→解析器"的注册表（pdf/docx/xlsx→文字）。docx/xlsx 等一律当不透明文件。
- 不做"选择解析用哪个 skill/agent"的选择器 UI（v1）。模型靠 skill 描述自行选择；说明里给一个具名提示即可。
- 上传文件**不进原生文件块/vision 块**（hermes/openclaw 明确规避 provider 400）；只作为文本说明+路径。
- 不做 PDF 原生 document 块特化（保持"纯路径 + 让模型用工具"的统一模型；日后要 PDF 特化再单开）。

## 分流总览（三类附件，各走各的）

| 输入 | 归属 | 处理 |
|---|---|---|
| 图片文件（image/*） | I2 | 直传/解析路径，原生 image 块 |
| 剪贴板**文本**（非文件） | I5a | 卡片，全文（过大截断，见下） |
| **其它任意文件** | **I5b（本 spec）** | 上传到服务端存储 → 给模型路径 + 说明 |

## 上传存储（服务端只做这个）

- 路径：`~/.zuse/uploads/<uuid>/<原始文件名>`（保留原名+扩展名，agent/skill 靠扩展名判类型）。
- `UploadService` 扩展：
  - `saveFile(bytes, name): Promise<{ id, name }>` —— 存到 `<uploadsDir>/<uuid>/<safeName>`；**不校验 MIME**（任意类型）；文件名做基本清洗（去路径分隔符/`..`，防穿越），空名回退 `file`。
  - `filePath(id, name): string` —— 返回绝对路径 `<uploadsDir>/<id>/<name>`（供 expandAttachments 拼说明）。
  - 字节上限：`FILE_MAX_BYTES = 50 * 1024 * 1024`（50MiB；比图片 25MiB 宽，参考 hermes 32/openclaw 20/opencode 10，取够用值）。超限 → `TooLargeError`。
- HTTP 端点：`POST /api/uploads/file`（与图片 `POST /api/uploads` 并列）—— **传输方式与图片端点完全一致**（plan 阶段先读 `POST /api/uploads` 的实现：body 编码、`readJsonBody`/流式落盘、body cap、返回 ref 的形状，照搬），只是不校验 MIME、cap 用 `FILE_MAX_BYTES`、落盘到 `<uuid>/<原始文件名>`。鉴权同其它端点。返回 `{ id, name, mediaType }`。

## 数据模型

### protocol（`packages/protocol/src/index.ts`）
```ts
/** 一次上传后的任意文件引用（客户端持有、随 send 上行）。 */
export interface UploadedFileRef { id: string; name: string; mediaType: string }

// MessageAttachment.route 增加 'file'
route?: 'direct' | 'parsed' | 'pasted' | 'file'
// route==='file' 时不带 text/description；名字在 name，路径发送时由服务端解析。

// send 帧并列新增 files
| { type: 'send'; text: string; images?: UploadedImageRef[]; pastedTexts?: PastedTextInput[]; files?: UploadedFileRef[] }
// steer 帧同样并列 files（回合中也能传文件，沿用 I5a mid-turn 的 follow-up 投递机制）
| { type: 'steer'; text: string; images?: UploadedImageRef[]; pastedTexts?: PastedTextInput[]; files?: UploadedFileRef[] }
```
core `MessageAttachment` 同步加 `'file'`。

### 发送物化（`packages/server/src/upload/imageExpand.ts`）
`makeExpandAttachments` 加 `route==='file'` 分支：对每个文件附件产出**一条文本说明块**（不是原生块），插在原 content 之前（材料在前）。块顺序变为：image → 图片parsed → pasted → **file** → 原始问题。

**说明文案用英文**（给模型看，指令遵循更稳）。单/多文件都逐个列出路径（不像 pasted 那样合并正文，因为每个文件是独立实体）：
```
[The user attached N file(s), saved on this machine. To use their contents, read these paths with the Read/Bash tools or an appropriate skill/agent; if you can't process a file, say so plainly.]

▍<name1> — <abs path1>
▍<name2> — <abs path2>
```
单文件时省略"N"计数，仍是英文：`[The user attached a file, saved at <abs path>. To use it, read the path with Read/Bash or an appropriate skill/agent; if you can't process it, say so plainly.]`。路径由 `upload.filePath(a.id, a.name)` 现算（expandAttachments 已持有 `upload`）。

> 说明点名 **Read/Bash + skill/agent**（hermes 式具名提示），让模型知道有哪些手段、且"读不了就直说"，避免踢回用户。

## 后端会话层

- `clientMessage.ts`：send/steer 分支透传 `msg.files` → `mgr.submit(text, images, pastedTexts, files, opts)` / `mgr.steer(text, images, pastedTexts, files)`。
- `SessionManager.submit` 签名加 `files?: UploadedFileRef[]`（第 4 参，opts 顺延为第 5）：把 files 转成 `route:'file'` 的 attachment（`{ id, name, mediaType, route:'file' }`），并入 `userAttachments`。**无 vision/解析分支**——文件附件不读盘、不描述，纯挂路径（expandAttachments 现算路径）。
- `steer` / `steerQueue` 项加 `files?`；`consumeSteer` 仍只折纯文本（带 files 的项同带附件项一样留给 `drainSteerAsFollowUp` 作后续回合投递）；drain 合并 files 传给 submit；`echoAttachments` 加 file 项（`{id,name,mediaType,route:'file'}`）供气泡即时显示。
- retry 的 route 拆分扩展：`route==='file'` 的附件恢复回 `files` 参（与 pasted 拆分并列；不进 images）。
- failover resend 透传 files。

## 前端

- **上传 API**（`state/manageApi.ts`）：`uploadFile(file): Promise<UploadedFileRef>` → `POST /api/uploads/file`。
- **Composer**：
  - 回形针 `accept` 由 `image/*` 放宽到 `*/*`；`aria-label` 改"添加附件"。
  - 分流：选/拖/粘贴的文件里，`image/*` → 现有图片管道；**其它 → 文件管道**（`uploadFile` → 暂存为 `PendingFile {id?, name, status}` 卡片，与图片 `pending`、粘贴 `pastes` 并列）。
  - 新增 `otherFilesFrom(dt)`（对称于 `imageFilesFrom`，取非 image 文件）。整屏拖拽（Shell）同样把非图片文件转交。
  - 托盘渲染文件卡片：`📎 <name>`（上传中转圈、失败重试、`×` 删除）；**不做点击预览**（任意文件无法通用预览）。
  - `canSend` / `submit` / `clearPending` 纳入 files；发送带 `files`。
  - mid-turn（thinking 时）允许暂存文件（沿用 I5a 放开守卫的结论）。
- **Shell.onSend**：签名加 `files`；乐观 attachments 里加 file 项（`{id,name,mediaType,route:'file'}`）；send/steer 帧带 files。
- **Message.tsx**：气泡渲染 `route:'file'` 的附件为 `📎 <name>` 卡片（复用 `.paste-card` 外观，无 lightbox）。
- **reducer/types**：`user-send`/`steer-queued`/`pendingSteers`/`user-echo` 的 attachments 已是 `MessageAttachment[]`，`route:'file'` 自动兼容，无需改结构。

## I5a 小改：粘贴文本过大——按 cc 真实语义，模型拿全文

> **2026-07-12 修正**：初版误读了 cc-haha，做成了"砍发给模型的文本"（前 500 + `[… M lines truncated …]` + 后 500）。
> 复核 cc-haha 源码后确认其真实语义相反 —— **截断纯属输入框显示层**：`maybeTruncateInput`（`inputPaste.ts`）
> 把中段存进 `pastedContents[N]`，输入框只显示紧凑占位符 `[...Truncated text #N...]`；**提交时 `expandPastedTextRefs`
> （`history.ts`）把占位符原样还原成全文**，`handlePromptSubmit.ts` 里 `finalInput` = 完整全文才发给模型。
> 中段一个字都不丢。（processUserInput 的 `applyTruncation` 只作用于 hook 输出，与用户粘贴无关。）

因此 `imageExpand.ts` 的 **pasted 分支不做任何模型侧截断，直接把 `attachment.text` 全文喂给模型**。已删除
`truncateForModel` / `PASTE_TRUNCATE_THRESHOLD` / `PASTE_PREVIEW_HALF`。

- 我们 Web 端的"显示层截断"由 I5a 的粘贴管道天然承担：粘贴长文折成卡片、textarea 不刷裸文本，
  点开 TextLightbox 看全文——等价于 cc 的输入框占位符 + 展开，不需要在模型侧另做截断。
- cc 是本地 CLI，唯一约束是模型 context window，它选择"信任大 context、全喂"；我们跟随该语义。
  超大粘贴吃 token/爆窗口的兜底，日后若要做，走"落盘 + 给路径让模型按需 Read"（同上传文件路径），
  而不是无条件砍中段丢信息。

## "无法解析"

不再有服务端徽标。模型拿到路径 + 说明后：能处理就处理，不能就（被说明明确提示）直说"这个文件我处理不了"。这是四家的一致做法。

## 测试

- **server（UploadService）**：`saveFile` 存到 `<id>/<name>`、文件名清洗（`../`、路径分隔符）、超 50MiB → TooLargeError、任意 MIME 不被拒。
- **server（imageExpand）**：`route:'file'` 单/多文件产出说明块（含路径、具名提示）、块顺序 image→parsed→pasted→file→原文、无 file 时不产该块；pasted 截断：≤10000 原样、>10000 首尾各 500 + `[……中间已截断 M 行……]`、attachment.text 不被截。
- **server（SessionManager）**：submit 带 files → route:'file' attachments；retry 按 route 拆出 files；steer 带 files → 队列项含 files、drain 合并 files→submit、echoAttachments 含 file 项。
- **server（http）**：`POST /api/uploads/file` 存盘返 ref、超限 413、未鉴权 401。
- **web（Composer）**：非图片文件 → 文件卡片(不进 textarea/不进图片管道)；图片仍走图片管道；`×` 删除；发送 payload 带 files；mid-turn 可暂存。
- **web（Message）**：`route:'file'` 渲染 `📎 <name>` 卡片。
- **Playwright**：上传一个 .csv/.txt 之外的文件（如构造一个 .bin 或 .md）→ 文件卡片 → 发送 → 气泡显示 📎 卡片 → 模型回复引用到该路径（或说明能/不能处理）；再验证粘贴超 1 万字符时模型侧被截断（前后各 500 + 截断标记）。

## 涉及文件

- 改：`packages/protocol/src/index.ts`（UploadedFileRef、route 'file'、send/steer.files）
- 改：`packages/core/src/types.ts`（MessageAttachment route 'file'）
- 改：`packages/server/src/upload/UploadService.ts`（saveFile/filePath/FILE_MAX_BYTES）
- 改：`packages/server/src/upload/imageExpand.ts`（'file' 分支 + pasted 截断）
- 改：`packages/server/src/http/server.ts`（POST /api/uploads/file）
- 改：`packages/server/src/ws/clientMessage.ts`（send/steer 透传 files）
- 改：`packages/server/src/session/SessionManager.ts`（submit/steer/drain/retry/echoAttachments 带 files）
- 改：`packages/server/src/session/startServer.ts`（若需给 expandAttachments 传 upload——已传，确认）
- 改：`packages/web/src/state/manageApi.ts`（uploadFile）
- 改：`packages/web/src/components/Composer.tsx`（otherFilesFrom、文件管道、accept *、文件卡片）
- 改：`packages/web/src/components/Shell.tsx`（onSend files + 乐观 + 帧）
- 改：`packages/web/src/components/Message.tsx`（file 卡片渲染）
- 测试：各包对应 `*.test.ts(x)`
