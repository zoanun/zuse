# I5a 后续：回合进行中发送附件（图片 + 粘贴长文本）设计

> **状态**：设计已定，用户已授权「设计→直接实现→/ship」。属 I5a 的后续增强。
> **分支**：`i5a-paste-long-text`（在其上继续）。

## 目标

回复生成过程中（`thinking`），允许用户暂存图片 / 粘贴长文本并发送。带附件的插话**排队**，当前回复结束后立即作为一个**后续回合**（fresh submit）投递；不改动正在生成的当前回复。纯文本插话维持现状（折进当前回合的 tool_result）。

## 为什么是「后续回合」而非折进当前回合

steer 有两条投递路径：
1. `consumeSteer`（tool 批次边界）→ 把插话文本折进上一个 tool_result 的 output（纯文本）。
2. `drainSteerAsFollowUp`（回合结束）→ 把仍在队列里的插话经 `this.submit(text)` 作为新回合投递。

图片折进运行中的 tool_result 风险大：tool_result 里塞 image block 协议脆弱（OpenAI 兼容端尤甚）、非视觉模型还要中途调解析模型（与回合并发/竞争）。而 `submit()` 已在 I5a 里完整处理 images + pastedTexts。故：**带附件的插话一律走路径 2**（drain→submit），复用现成、稳妥逻辑；`consumeSteer` 保持纯文本、不动。

## 行为细节与边界

- 带附件插话**不参与** `consumeSteer` 的当前回合折叠：`consumeSteer` 只折**纯文本**队列项，带附件项留在队列，等回合结束由 `drainSteerAsFollowUp` 投递。
- 允许**只发附件、无文字**的插话（`text` 可空，只要有 images 或 pastedTexts）。
- 多个排队项在 drain 时合并成**一个**后续回合：文本用 `\n` 连接，images 全部拼接，pastedTexts 全部拼接，一次 `submit(text, images, pastedTexts)`。
- **顺序**：若在带附件插话之后又发了纯文本插话，纯文本可能折进当前回合、先被回答，带附件项随后作为后续回合——轻微乱序，可接受（附件本就无法即时折入）。
- **失败/中止**：沿用现有 `abortedMidTurn` 重排队逻辑（带附件项若曾入队，drain 时照常投递）。

## 数据流变更

### protocol（`packages/protocol/src/index.ts`）
steer 帧扩展（与 send 帧对齐字段）：
```ts
| { type: 'steer'; text: string; images?: UploadedImageRef[]; pastedTexts?: PastedTextInput[] }
```

### server（`SessionManager.ts` + `ws/clientMessage.ts`）
- `steerQueue` 项类型：`{ text: string; echoed: boolean; images?: UploadedImageRef[]; pastedTexts?: PastedTextInput[] }`。
- `steer(text, images?, pastedTexts?)`：`const trimmed = text.trim()`；**空文本且无附件**才 return（原来是空文本即 return）；push `{ text: trimmed, echoed:false, images, pastedTexts }`。
- `consumeSteer`：只折**无附件**项。实现：挑出 `!images?.length && !pastedTexts?.length` 的项，合并其 text（过滤空串），从队列**就地移除这些项**（保留带附件项）；若没有可折项返回 `null`。其余（echo、consumedThisTurn 记录）照旧，但只针对被折的文本。
- `drainSteerAsFollowUp`：`const items = this.steerQueue.splice(0)`；未 echo 项照旧 emit `user-echo`（文本，用于清除前端 pending 预览）；合并 `text = items.map(s=>s.text).filter(Boolean).join('\n')`、`images = items.flatMap(s=>s.images ?? [])`、`pastedTexts = items.flatMap(s=>s.pastedTexts ?? [])`；`await this.submit(text, images.length?images:undefined, pastedTexts.length?pastedTexts:undefined)`。
- `clientMessage.ts` `case 'steer'`：`mgr.steer(msg.text, msg.images, msg.pastedTexts)`（`isBusy()` 门槛不变）。

### web
- **Composer**：解除 `thinking` 限制——`stage()` 不再因 thinking 拦图；`onPaste` 长文本分支不再因 thinking 拦（移除上一版加的守卫）；回形针按钮不再 `disabled={thinking}`；`placeholder` 文案维持（插入消息到当前回合…）。
- **Shell.onSend**（thinking 分支）：若有 images/pastedTexts → 发 `{type:'steer', text, images, pastedTexts}`，并乐观 dispatch 带 attachments 的 `steer-queued`（预览气泡即时显示缩略图/卡片）；无附件 → 现状（纯文本 steer）。
- **reducer**：`steer-queued` action 与 `pendingSteers` 项携带 `attachments?: MessageAttachment[]`；带附件的 pending 预览气泡渲染 attachments（复用 `MessageImage`/`PastedTextChip`）。`user-echo` 到达时按文本段匹配清除 pending（现有逻辑）；权威消息的附件由后续 submit 的快照带回。
- 乐观 attachments 形状与 send 路径一致：图片 `{id,name,mediaType}`；粘贴 `{id,name:'粘贴文本 #N',mediaType:'text/plain',route:'pasted',text}`。

## 测试

- server：`steer` 带附件 → 队列项含 attachments；`consumeSteer` 跳过带附件项、只折纯文本；`drainSteerAsFollowUp` 合并 images/pastedTexts 调 `submit`；空文本 + 仅附件 不被 steer() 丢弃。
- web：thinking 时可 stage 图片 / 粘贴长文本出卡片（不再被拦）；Shell thinking + 附件 → 发带 images/pastedTexts 的 steer 帧 + 乐观 pending 带 attachments；reducer steer-queued 带 attachments 进 pendingSteers。
- Playwright（/ship 门禁）：回复进行中贴长文本 → 出 pending 预览卡片 → 当前回复结束后作为新回合发出、模型收到。

## 不做（YAGNI）
- 不把图片/文本折进正在运行的当前回合（协议脆弱 + 并发风险）。
- 不做多附件插话之间的排序保证（合并成一个后续回合即可）。
