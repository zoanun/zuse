# I5a 粘贴长文本 → 附件卡片 设计

> **状态**:设计已与用户确认，待 writing-plans 出实现计划。
> **范围**:I5 拆成两个独立子系统，本文只覆盖 **I5a（粘贴长文本 → 卡片）**。
> I5b（上传任意文件 + 服务端工具/skill 解析）另立 spec，本文完成合并后再启动。

## 目标

在 Web Composer 里粘贴**超阈值**的长文本时，不把它灌进 `<textarea>`，而是像 I2 图片附件一样在输入框上方出现一张**折叠卡片** `📄 Pasted text #N (+M 行)`。发送时把各段粘贴全文**按顺序、带编号标签**拼成一个前置文本块发给模型（材料在前、用户问题在后）；气泡里（含刷新/重载后的历史）把它折叠成同款卡片，点击可看全文。

## 架构总览

复用 I2 已有的 attachment 管道，**不另起炉灶**：

- 数据模型层面，粘贴文本是 `MessageAttachment` 的一种新 `route`（`'pasted'`），全文内联存在 attachment 的 `text` 字段里，随消息落盘。
- 发送物化沿用 `makeExpandAttachments`（server），新增 `route==='pasted'` 分支，产出一个带编号标签的前置 text 块。
- 快照投影（`SessionManager.ts` 现有 `out.push({ ..., attachments })`）原样透传 attachment，`text` 字段自动进 snapshot → 刷新后气泡从持久化数据重建同款卡片。

**关键区别 vs 图片**：图片字节落盘（`~/.zuse/uploads/`），attachment 只存引用，气泡按 id 走 HTTP 端点重新取字节；粘贴文本**不落盘**，全文内联在 attachment/snapshot 里，气泡与"点开看全文"无需额外请求，也没有"上传文件被清理导致裂图"的风险。

## 触发规则（照搬 CC，已核 `E:\ai-study\cc-haha`）

来源：`src/components/PromptInput/PromptInput.tsx:1198-1232`（`onTextPaste`）、`src/utils/imagePaste.ts:30`（`PASTE_THRESHOLD = 800`）、`src/history.ts:47-55`（行数/格式）。

Composer 的 `onPaste` 里取 `e.clipboardData.getData('text')`，规范化 `\r`→`\n` 后：

```
charCount = text.length
newlineCount = (text.match(/\n/g) || []).length   // CC 语义：换行符个数，"a\nb\nc" = 2
触发条件： charCount > 800  ||  newlineCount > 2
```

- 命中 → `e.preventDefault()`，转卡片（不进 textarea）。
- 未命中 → 不拦截，走浏览器默认粘贴（正常进 textarea）。
- CC 的 `maxLines = Math.min(rows-10, 2)` 里 `rows-10` 是 TUI 终端重绘约束，Web 无此约束，等价取封顶值 `2`，即 `newlineCount > 2`。
- 规范化：`\r`→`\n`。（CC 还做 `stripAnsi` 和 `tab`→4 空格；Web 剪贴板文本极少含 ANSI，`stripAnsi` 省略；tab 保留原样即可——不影响判定与展示。）

## 行数辅助（core）

`+M 行` 的 M 与 CC 一致，用**换行符个数**，client 与 bubble 共用一个 helper，避免两处口径不一：

```ts
// packages/core：newline 计数，"a\nb\nc" → 2，与 cc-haha getPastedTextRefNumLines 同义
export function pastedLineCount(text: string): number {
  return (text.match(/\r\n|\r|\n/g) || []).length
}
```

卡片标签格式：`M === 0 → 📄 Pasted text #N`；否则 `📄 Pasted text #N (+M 行)`。

## 数据模型变更

### protocol（`packages/protocol/src/index.ts`）

`MessageAttachment` 扩展（core 同步同形状）：

```ts
export interface MessageAttachment {
  id: string
  name: string
  mediaType: string
  route?: 'direct' | 'parsed' | 'pasted'   // 新增 'pasted'
  description?: string
  /** route==='pasted' 时的粘贴全文（内联持久化 + 随 snapshot 下发；图片路径无此字段）。 */
  text?: string
}
```

`ClientMessage.send` 扩展（与 `images` 并列）：

```ts
| { type: 'send'; text: string; images?: UploadedImageRef[]; pastedTexts?: PastedTextInput[] }

/** 一段随 send 内联上行的粘贴文本（客户端持有，不经 HTTP 预上传）。 */
export interface PastedTextInput {
  id: string    // 客户端生成（uuid 或 `pasted-<seq>`），用于卡片 key / 删除
  text: string  // 粘贴全文，已规范化 \r→\n（入栈即规范化，展示/M 计数/发送口径统一）
}
```

- 图片走"HTTP 预上传拿 id → send 带 `UploadedImageRef`"；粘贴文本无需预上传，全文直接内联在 `pastedTexts` 里随 send 上行。这是两条不同的客户端管道，故 send 上分成两个字段而非强并为一。

### core（`packages/core/src/types.ts`）

`MessageAttachment` 同步加 `route: 'pasted'` 与 `text?: string`。新增 `pastedLineCount`（见上，放 `packages/core`，从 index 导出）。

## 发送物化（`packages/server/src/upload/imageExpand.ts`）

`makeExpandAttachments` 加 `route==='pasted'` 分支。产出**一个**合并的前置 text 块，插在原 `content`（用户输入的问题）之前。块顺序：`[图片 image 块…, 图片 parsed 描述块, 粘贴文本块, ...原始 content]`。

- 取 `atts.filter(a => a.route === 'pasted')`，逐条 `text` **不 trim 掉内部内容**（保留原文），但整段为空/纯空白的粘贴项跳过（防呆，正常不会出现）。
- 多段（`>1`）：带编号标签

  ```
  [以下是我粘贴的 N 段文本：]

  ▍粘贴文本 1
  <全文1>

  ▍粘贴文本 2
  <全文2>
  ```

- 单段（`===1`）：对齐 imageExpand 的单/多行为，去掉 `▍粘贴文本 1` 编号：

  ```
  [以下是我粘贴的 1 段文本：]

  <全文>
  ```

- 全部粘贴项都为空则不产出该块。

## 后端会话层

### `packages/server/src/ws/clientMessage.ts`

`case 'send'`：`mgr.submit(msg.text, msg.images, msg.pastedTexts)`（新增第三参）。

### `packages/server/src/session/SessionManager.ts`

`submit(text, images?, pastedTexts?, opts?)`：

- 把 `pastedTexts` 转成 `route:'pasted'` 的 `MessageAttachment`：
  - `id` = 客户端传来的 id
  - `name` = `Pasted text #N`（N 从 1 起，按本条消息内粘贴项顺序编号；固化进 name 以便刷新后编号稳定）
  - `mediaType` = `text/plain`
  - `route` = `'pasted'`
  - `text` = 全文
- 与图片 attachments **合并**挂到当前用户消息的 `attachments`。
- failover/重试路径：attachments 每回合经 `expandAttachments` 重新物化（I2 已有机制，`SessionManager.ts` 现有逻辑对全部 attachments 一视同仁），粘贴文本随之自动重展开，无需额外处理。
- 投影：现有 `out.push({ role, parts, checkpointId, ledgerIndex, attachments })` 原样透传，`text` 字段自动进 snapshot，无需改投影代码。

## 前端

### `packages/web/src/components/Composer.tsx`

- `onPaste` 增加文本分支：先看 `imageFilesFrom`（图片优先，维持 I2 行为）；否则取 `getData('text')`，**规范化 `\r`→`\n`** 后按触发规则判定；命中则 `preventDefault()` + 暂存一段粘贴文本（与图片 `pending` 并列的 `pastedTexts` 本地状态：`{ id, text }[]`，`text` 为规范化后文本）。
- 附件托盘：在图片缩略图旁渲染 `📄 Pasted text #N (+M 行)` 卡片，`×` 删除；序号 N 按当前暂存顺序实时显示，M 由 `pastedLineCount(text)` 现算。
- `canSend`：`value.trim() !== '' || doneRefs.length > 0 || pastedTexts.length > 0`。
- `submit()`：把 `pastedTexts`（`{id,text}[]`）纳入发送 payload；发送后连同图片一起清空。

### `packages/web/src/components/Message.tsx`

- 新增 `PastedTextChip`（仿 `MessageImage`）：从 `msg.attachments` 里 `route==='pasted'` 的项渲染同款 `📄 Pasted text #N (+M 行)` 卡片（N 取自 `name`，M 由 `pastedLineCount(att.text)` 现算）。
- 点击 → 打开 `TextLightbox`（新增，仿 `ImageLightbox`）：portaled 全屏弹层，等宽字体、可竖向滚动、`Esc`（capture 阶段 + stopPropagation）与点击遮罩关闭。

### 刷新/重载渲染（明确写明）

刷新后前端拉 snapshot，`SnapshotMessage.attachments` 携带 `route:'pasted'` 项与其 `text`。气泡的 `PastedTextChip` **与实时走同一条渲染路径、读同一份 attachment 数据**，因此重载后显示的是**同款折叠卡片**，点击 `TextLightbox` 直接展示 `att.text` 全文——不再发任何请求。`#N` 由持久化的 `name` 复现，`+M 行` 由 `text` 现算，均稳定。

## YAGNI（明确不做）

- 阈值不做 settings 配置项（硬编码 `800` / `2`）。
- 卡片不做拖拽排序。
- 粘贴文本不落盘（内联 ledger + snapshot）。若日后超长对话导致 snapshot 膨胀，再加"按 attachment id 懒取全文"的 HTTP 端点（与图片同路），届时 snapshot 只带预览+行数。
- 不做 CC 的"内联占位符 + 原子删除/光标跳过"（那是 TUI `Cursor.ts` 的做法；本设计走卡片式，无占位符进 textarea）。

## 测试

- **core**：`pastedLineCount` 边界（空串→0、无换行→0、`"a\nb\nc"`→2、`\r\n`/`\r` 混合、末尾换行）。
- **server（`imageExpand.test.ts`）**：新增 `route:'pasted'` 分支用例——
  - 单段：header + 全文、**不带** `▍粘贴文本 1`。
  - 多段：`[以下是我粘贴的 2 段文本：]` + `▍粘贴文本 1/2` 编号、顺序正确。
  - 与图片混合：块顺序 = image 块 → 图片 parsed 块 → 粘贴文本块 → 原 content。
  - 全空粘贴项：不产出块。
  - 不 mutate 原消息（与现有 direct/parsed 用例一致）。
- **server（`SessionManager` 测试）**：`submit` 带 `pastedTexts` → 用户消息挂上 `route:'pasted'` attachments（name=`Pasted text #N`、text=全文）；投影 snapshot 带 `text`。
- **web（Composer 测试）**：粘贴超阈值 → 出卡片、不进 textarea；粘贴未超阈值 → 进 textarea、无卡片；多段编号 #1/#2；`×` 删除；发送 payload 带 `pastedTexts`、发送后清空；仅有粘贴文本无输入文字时 `canSend` 为真。
- **web（Message 测试）**：`route:'pasted'` attachment 渲染卡片 + 标签；点击开 `TextLightbox` 显示全文。
- **Playwright 冒烟**：粘贴一大段文本 → 出卡片 → 发送 → 气泡显示折叠卡片 → 点开 `TextLightbox` 看全文 → 刷新页面 → 历史里仍是同款卡片、可再次点开。

## 涉及文件清单

- 改：`packages/protocol/src/index.ts`（MessageAttachment.route/text、ClientMessage.send.pastedTexts、PastedTextInput）
- 改：`packages/core/src/types.ts`（MessageAttachment 同步）、新增 `pastedLineCount`（core，index 导出）
- 改：`packages/server/src/upload/imageExpand.ts`（'pasted' 分支）
- 改：`packages/server/src/ws/clientMessage.ts`（send 传 pastedTexts）
- 改：`packages/server/src/session/SessionManager.ts`（submit 第三参 → route:'pasted' attachments）
- 改：`packages/web/src/components/Composer.tsx`（onPaste 文本分支 + 卡片托盘 + 发送）
- 改：`packages/web/src/components/Message.tsx`（PastedTextChip）
- 新增:`packages/web/src/components/TextLightbox.tsx`（全文查看弹层）
- 测试：上述各包对应 `*.test.ts(x)`
