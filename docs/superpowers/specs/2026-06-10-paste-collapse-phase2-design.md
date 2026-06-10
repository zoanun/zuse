# 文本粘贴折叠(第二期)设计文档

- 日期:2026-06-10
- 状态:已定(用户授权自主推进,边做边留档供评审)
- 范围:`packages/tui`
- 前置:第一期「输入层地基」已完成(可靠 `isPasted` + bracketed paste),见 [2026-06-10-input-layer-paste-collapse-design.md](2026-06-10-input-layer-paste-collapse-design.md) §7/§12。本文把 §7 的设计落到可实现的接口,并定下 §12 的开放点。

## 1. 目标

用户向输入栏粘贴**多行**文本时,折叠成一个紧凑标签(显示行数/字数),而非铺满整段;标签可作为**不可分割单元**编辑(光标整体跨越、退格/删除整块删);提交时展开成全文发给模型,**滚动区回显仍显折叠标签**。

范围按用户决定为 **B:编辑时折叠 + 提交后滚动区也保留 tag**。

## 2. 非目标(本期不做)

- 图片/文件等附件粘贴(剪贴板位图、右键图片)——独立的「附件期」,更靠后。
- 单行粘贴折叠(单行照常按纯文本插入)。
- 会话持久化的折叠态:**zuse 会话不落盘**(只 settings/模型选择写盘),故无 localStorage 持久化层要设计。`displayText` 仅是当前会话内存里的回显态。

## 3. 已定的开放点(原 §12)

- **占位符编码**:用私有区(PUA)哨兵成对包裹自增 id —— `START=''` + `<id 十进制>` + `END=''`,嵌在扁平 `buf.text` 里。渲染/光标计算更干净。粘贴内容若自身含这两个哨兵字符,折叠前**剥除**(防止破坏 span 解析)。
- **message 双份文本**:`UIMessage` 增可选 `displayText?: string`。`text` 仍是**全文**(模型 + API 历史用);`displayText` 是**折叠回显串**(含可见标签文本)。渲染层优先用 `displayText`。无折叠时 `displayText` 不设、回落 `text`。
- **折叠标签文案**:`[粘贴#{id} · {N} 行 · {M} 字符]`,其中 `N` = 内容 `\n` 数 + 1,`M` = 字符数(`≥1000` 显示 `x.xk`)。带序号 `#id` 以区分多次粘贴。样式:**v1 渲成方括号纯文本**(与输入文本同色),靠 `[...]` 与文案本身已足够辨识;**上色(青色)留作后续打磨**——见下方渲染方案,为复用现有渲染、降低风险,v1 不对标签单独着色。

## 4. 总体架构与数据流

```
粘贴(终端 bracketed paste)
  → 第一期:tokenizer 聚合 → ParsedKey{isPasted:true, sequence:已 CR→LF 规范化的全文}
  → inputBus.dispatch:isPasted 分流到「粘贴订阅者」(不再走按键订阅者)
  → usePaste(content) 回调 → InputBox
       ├─ content 含 \n(≥2 行)→ foldPaste:分配 id、存入 pastes Map、在光标处插入哨兵 span
       └─ 否则 → 当作普通文本 insert
编辑(方向/退格/删除等)
  → InputBox 经 pasteReduce(占位符感知)更新 (buf, pastes)
渲染
  → parseSegments(buf.text, pastes) 切成 文本/占位符 段 → InputBox 渲染:文本段带光标三段切分,占位符段渲成青色标签
提交
  → fullText = expand(buf.text, pastes)   // 哨兵 span → 全文
  → displayText = toDisplay(buf.text, pastes)  // 哨兵 span → 可见标签串(仅当 pastes 非空)
  → onSubmit(fullText, displayText?) → App → submit → sendMessage
       ├─ UIMessage{ text: fullText, displayText }   // 回显用 displayText
       └─ runAgent userText: fullText                // 模型收全文
回显
  → StreamRenderer:user 消息用 (displayText ?? text) 渲染
```

## 5. 模块布局

| 文件 | 改动 | 职责 |
|---|---|---|
| `packages/tui/src/input/inputBus.ts` | 改 | dispatch 分流 isPasted;新增 `subscribePaste` + 粘贴订阅者表 |
| `packages/tui/src/input/useInput.ts` | 改 | 新增 `usePaste(handler, opts?)` hook |
| `packages/tui/src/components/pasteFold.ts` | **新建** | 占位符纯逻辑:哨兵常量、`foldPaste`/`pasteReduce`/`expand`/`toDisplay`/`toDisplayCursor`/`tagLabel` |
| `packages/tui/src/components/InputBox.tsx` | 改 | 持 `pastes` Map + `nextId`;接 `usePaste`;编辑走 `pasteReduce`;渲染走 `parseSegments`;提交算 full/display |
| `packages/tui/src/types.ts` | 改 | `UIMessage += displayText?: string` |
| `packages/tui/src/hooks/useConversation.ts` | 改 | `submit`/`sendMessage` 加可选 `displayText`,透传到 UIMessage;`userText` 仍传全文 |
| `packages/tui/src/App.tsx` | 改 | `handleSubmit(text, displayText?)` → `submit` |
| `packages/tui/src/components/StreamRenderer.tsx` | 改 | user 渲染用 `displayText ?? text` |

`textBuffer.ts` 的纯原语(insert/backspace/move…)**不改**,被 `pasteFold` 在文本段上复用。

## 6. 关键接口(`pasteFold.ts`)

```ts
export const PASTE_START = ''
export const PASTE_END = ''

/** pastes:id → 全文内容。 */
export type PasteMap = ReadonlyMap<number, string>

/** 标签文案:`粘贴#{id} · {N} 行 · {M} 字符`(M≥1000 → x.xk)。 */
export function tagLabel(id: number, content: string): string

/** 折叠一次粘贴:剥哨兵、分配 id、存内容、在光标处插入哨兵 span。 */
export function foldPaste(
  buf: TextBuffer,
  pastes: PasteMap,
  nextId: number,
  content: string,
): { buf: TextBuffer; pastes: Map<number, string>; nextId: number }

/** 占位符感知地应用一个编辑事件,返回新 buf 与新 pastes(删除 span 时剪除其 id)。 */
export function pasteReduce(
  buf: TextBuffer,
  pastes: PasteMap,
  ev: InputEvent,
): { buf: TextBuffer; pastes: Map<number, string> }

/** 哨兵 span → 全文(发模型)。未知 id 的 span 退化为字面文本(防御)。 */
export function expand(text: string, pastes: PasteMap): string

/** 哨兵 span → 可见标签串 `[label]`(渲染 / 滚动区回显)。 */
export function toDisplay(text: string, pastes: PasteMap): string

/** 把 buf.text 里的光标偏移映射到 toDisplay 后字符串的偏移(光标不在 span 内部,故可逐段累加)。 */
export function toDisplayCursor(text: string, cursor: number, pastes: PasteMap): number
```

### 原子编辑语义(pasteReduce)

- **insert/newline**:在光标处插入文本(不碰 span)。
- **left/right**:若移动会落入某 span 内部,则整体跨过该 span(停在 span 外边界)。
- **backspace**:若光标紧跟在某 span 的 `END` 之后,删整段 span 并从 pastes 删除该 id;否则普通退格。
- **delete**:若光标正处于某 span 的 `START`,删整段 span 并剪除 id;否则普通向后删。
- **home/end/pageUp/pageDown/up/down**:照常移动;若落点在 span 内部,夹到最近的 span 外边界。
- 删除/编辑后,`pastes` 里**不再被任何 span 引用**的 id 一并剪除(以 `expand` 后的引用为准,保持 Map 与文本同步)。

### 渲染(复用现有 splitForRender,零新渲染逻辑)

关键简化:**不新写分段渲染**。InputBox 渲染时把内部带哨兵的 buf 转成「展示 buf」再喂现有 `splitForRender`:

```
const displayText = toDisplay(buf.text, pastes)            // span → [标签]
const displayCursor = toDisplayCursor(buf.text, buf.cursor, pastes)
const renderLines = splitForRender({ text: displayText, cursor: displayCursor })
```

因原子编辑保证**光标永不落在 span 内部**,`toDisplayCursor` 可逐段累加得到展示坐标。标签作为 `[…]` 纯文本随行渲染,光标三段切分、增高、横线全部沿用第一期 InputBox 渲染,无需改动。代价:标签不单独着色(留作后续打磨)。

## 7. 错误处理 / 边界

- **空粘贴**:`usePaste` 收到空内容 → 忽略(本期不做图片侦测)。
- **单行粘贴**:无 `\n` → 普通 insert(不折叠)。
- **内容含哨兵字符**:`foldPaste` 先 `content.replaceAll(PASTE_START/END, '')` 剥除。
- **未知 id 的 span**(理论上不应出现):`parseSegments`/`expand` 退化为把 span 当字面文本,不崩。
- **提交清理**:提交后 `buf` 清空、`pastes` 清空、`nextId` 可不重置(单调自增即可)。
- **粘贴订阅者缺席**:inputBus 把 isPasted 只投给粘贴订阅者;当前只有 InputBox 订阅,其它组件(App/SelectList/ModelSelect)不接收粘贴——符合预期(只有输入框接受文本)。

## 8. 测试策略

- `pasteFold.test.ts`(纯逻辑,重点):
  - `tagLabel`:行数/字数计算、`x.xk` 阈值。
  - `foldPaste`:插入哨兵 span、id 自增、剥哨兵、pastes 落键。
  - `pasteReduce`:左右移整体跨越 span;退格/删除整块删并剪 id;普通编辑不误伤;落点夹出 span 内部。
  - `expand`/`toDisplay`:span → 全文 / 标签串;多 span;未知 id 退化。
  - `toDisplayCursor`:光标在 span 前/后、多 span 前的展示坐标映射。
- `inputBus.test.ts`:isPasted 分流到粘贴订阅者、不触发按键订阅者;非粘贴键不触发粘贴订阅者。
- `useInput`/`usePaste`:订阅/退订、isActive 门控(沿用现有模式)。
- `InputBox.test.ts`:多行粘贴显示为标签;光标整体跨越;退格整块删;提交后 onSubmit 收到 (全文, 折叠串)。
- `StreamRenderer` / `useConversation`:`displayText` 优先渲染;`text` 仍发模型。
- 手动冒烟:真实终端粘贴多行 → 标签;编辑;提交后滚动区显标签、模型收全文。

## 9. 自检(spec review)

- 占位符编码、message 双份文本、标签文案三项 §12 开放点均已定。
- 数据流自洽:粘贴分流→折叠→编辑→渲染→提交展开→回显,接口闭环。
- 范围与第一期不重叠(第一期只到「可靠 isPasted + 纯文本插入」)。
- 与 zuse 现状一致:无会话持久化,故无持久化层;`textBuffer` 纯原语不动,新增逻辑集中在 `pasteFold`。
