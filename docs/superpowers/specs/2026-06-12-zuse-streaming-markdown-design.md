# TUI 流式 Markdown 增量渲染设计(稳定前缀)

> 状态:设计已批准,待落实现计划。
> 上游:[2026-06-07-zuse-markdown-rendering-design.md](2026-06-07-zuse-markdown-rendering-design.md) §6 的「流式双态」策略升级。该 spec 当时刻意选择流式期纯文本;本 spec 在其渲染管线之上做增量化,定稿期路径不变。

## 1. 目标与动机

当前流式期间整条助手消息保持原始 Markdown 纯文本([StreamRenderer.tsx](../../../packages/tui/src/components/StreamRenderer.tsx) 第 304 行的 `isStreaming` 分支),要等 `message-stop` 后才一次性富渲染。长回复(尤其含表格)时,早已生成完毕的标题、表格会以裸 `#`、`|` 形态停留十几秒,可读性差。

目标:**流式期间,已确定完整的块先渲染成富文本;只有正在生成的尾部块保持纯文本。** 视觉稳定不闪烁,观感对齐 Claude Code。

### 方案选型(已决策)

- **方案 A(采纳):渲染层切分。** 只改 StreamRenderer 的流式分支,每帧对累积全文重新 lexer,按 token 边界切「稳定前缀 + 未完成尾部」。自纠错:任何切分偏差下一帧自动修正,定稿时还有 `<Markdown>` 整体重渲染兜底。
- 方案 B(否决,留作后续演进):已完成块逐步提交进 Ink `<Static>` 冻结区。体验最佳但架构改动大(消息拆块级 rows、committed/live 模型重构),且 Static 写入不可撤回,块边界误判即永久错误。等方案 A 用起来后长消息重绘成为实际痛点再评估。
- 全文实时解析 / 加节流(否决):尾部不完整构造(半张表格、未闭合 `**`)会渲染错误再跳变,视觉抖动。

## 2. 核心机制:用 marked 的 token 边界切分

不手工找空行,而是复用现有解析器的块边界:

1. 对累积全文跑 `marked.lexer(source, { gfm: true, breaks: false })`(与 [Markdown.tsx](../../../packages/tui/src/components/markdown/Markdown.tsx) 同参数),得到顶层块级 token 数组;
2. **最后一个 token 视为「可能未完成的尾部」**——流式追加的字符大概率仍属于它;
3. 前面的 tokens 已被后续内容封口,走现有 `renderBlocks()` 富渲染;
4. 尾部 token 用其 `.raw` 原文走 `<Text>` 纯文本(保留 marked 吃掉的原始字符)。

选 token 边界而非空行的关键理由:**未闭合代码围栏**。marked 把未闭合的 ``` 围栏(连同内部空行)解析为一个延伸到文末的 `code` token,天然落在尾部、整体保持纯文本;按空行切则会把代码块拦腰截断。

### 已知行为边界(接受)

- **表格 / 列表是单个顶层 token**:生成中的表格、列表整块保持纯文本,直到该块完成(后面出现新块)才富渲染。对表格这是合理的——列宽需要完整数据才不跳动。不做「列表已完成项先渲染」的 item 级细分(YAGNI)。
- **罕见的回溯语法**(如段落次行出现 `===` 变 setext 标题):后续字符可改写前一个 token。因每帧全文重新 lexer,下一帧自动纠正,代价是闪一下;定稿重渲染保证最终正确。

## 3. 组件与接线

新增 `packages/tui/src/components/markdown/StreamingMarkdown.tsx`:

```tsx
export function StreamingMarkdown({ source }: { source: string }): ReactElement | null
```

- `source === ''` → 返回 `null`(对齐 `Markdown`);
- lexer 成功且 tokens ≥ 2 → `<>{renderBlocks(tokens.slice(0, -1))}<Text>{last.raw}</Text></>`;
- tokens ≤ 1 → 全纯文本(等价现状);
- lexer 抛错 → 整体回退 `<Text>{source}</Text>`(对齐 `Markdown` 的兜底)。

**唯一接线点**:[StreamRenderer.tsx](../../../packages/tui/src/components/StreamRenderer.tsx) 第 304 行流式分支:

```tsx
// 改前
{message.isStreaming ? <Text>{message.text}</Text> : <Markdown source={message.text} />}
// 改后
{message.isStreaming ? <StreamingMarkdown source={message.text} /> : <Markdown source={message.text} />}
```

其余一概不动:定稿分支、`usage` 行、Spinner/`●` 前缀、user/tool/system 分支、[useConversation.ts](../../../packages/tui/src/hooks/useConversation.ts) 数据流、App.tsx 的 committed/live 模型。无新增依赖。

## 4. 性能

- 每个 `text-delta` 触发的重渲染本来就存在(纯文本也每帧重绘 live 帧),新增成本是全文 `lexer` + 前缀 `renderBlocks`。几 KB 文本的 lexer 在亚毫秒级,大头仍是 Ink 重绘。
- **前缀缓存**:用 `useRef` 缓存 `{ prefixRaw, nodes }`——稳定前缀的 raw 拼接串未变时直接复用上次的 ReactNode 数组,跳过 `renderBlocks`。前缀只在「新块完成」时变化,绝大多数帧命中缓存。
- 不引入节流;刷新频率维持现状,如成为实际问题再议。

## 5. 错误处理与回退

- lexer 抛错 → 整体纯文本,绝不崩 TUI;
- 任何帧的切分偏差 → 下一帧全文重 lexer 自动纠正;
- 定稿(`isStreaming: false`)仍走 `<Markdown>` 完整重渲染,作为最终正确性兜底。

## 6. 测试策略

`StreamingMarkdown.test.tsx`(vitest + ink-testing-library,跟现有 markdown 测试套路):

- 空 `source` → 渲染 null;
- 单个未完成块(一段无空行文字)→ 全纯文本,无富样式;
- 「完整标题 + 完整段落 + 半个粗体尾部」→ 前缀出现富样式(标题加粗/着色),尾部含字面 `**`;
- 未闭合代码围栏(内含空行)→ 围栏整体保持纯文本,不被空行错切;
- 已完成表格 + 生成中的下一段 → 表格出现边框字符 `┌│└`;
- StreamRenderer 集成:`isStreaming: true` 走 StreamingMarkdown、`false` 走 Markdown,切换不回归(若现有 StreamRenderer 测试已覆盖该分支则扩展之)。

## 7. 范围外 / 后续

- 方案 B(逐块提交 `<Static>`):长消息 live 帧重绘与终端高度问题的根治方案,本次不做。
- 列表/表格的 item 级、行级增量渲染:不做。
- 节流 / 帧率控制:不做,留观察。
