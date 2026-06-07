# TUI 助手回复 Markdown 富渲染设计（Phase 7 子项）

> 状态：设计已批准，待落实现计划。
> 上游：[phase-roadmap.md](../plans/phase-roadmap.md) Phase 7「UI 打磨」的「Markdown 富渲染」子项。
> 范围：仅 **助手回复气泡的 Markdown 渲染**。Phase 7 的其余 5 个子项（`/model` 选择器、权限对话框箭头列表、多行输入、工具执行块对齐、TUI 文案全中文化）各自独立，本 spec 不涉及。

## 1. 目标与动机

当前 TUI 把助手回复当纯文本一次性 `<Text>{message.text}</Text>` 打印（见 [StreamRenderer.tsx](../../../packages/tui/src/components/StreamRenderer.tsx) 助手分支）。模型大量输出 Markdown——标题、列表、代码块、表格、强调——这些在终端里全是裸的 `#`、`*`、`|`，可读性差。

目标：**助手回复定稿后,把 Markdown 渲染成终端富文本**(加粗、列表项、带框代码块、表格网格线等),向 Claude Code 的观感看齐。

### 范围档位(已决策)

- **元素集 = 第二档 + 表格,不做语法高亮。** 具体覆盖:
  - 块级:标题(H1–H6)、段落、无序/有序列表、嵌套列表、围栏代码块(不高亮)、引用块、水平分割线、**表格(GFM)**。
  - 行内:加粗、斜体、删除线、行内代码、链接。
- **明确不做**(YAGNI):代码语法高亮、任务列表勾选框、脚注、定义列表、HTML 内联、图片、OSC 8 终端超链接。

## 2. 实现路线:方案 A(marked 词法器 + 自渲染 Ink 组件)

两条候选路线:

- **方案 A(采纳)**:用 `marked.lexer()` 仅做**词法分析**(token 化),拿到 token 树后**手写映射到原生 Ink `<Box>`/`<Text>` 组件**。
- 方案 B(否决):用 `marked-terminal` / `ink-markdown` 直接产出渲染结果。

**选 A 的理由(显示效果 + 学习价值)**:

1. **显示效果**:`marked-terminal` 预渲染成**定宽 ANSI 字符串**,终端宽度变化时不会重排;原生 Ink 组件由 Yoga 布局,会随终端宽度 reflow、表格边框贴合可用宽度、长行按宽度折行。要「显示效果最好」,必须走原生组件。
2. **学习价值**:把「解析」(交给 marked,零依赖踩坑)与「渲染」(token→组件映射、表格列宽、CJK 宽度、流式双态——本子项真正的学习点)解耦,既不掉进自己写 Markdown 解析器的正确性深坑,又保留手搓渲染层的练习。

`marked` 选型:零运行时依赖、内置 GFM 表格与删除线、久经考验。我们**只用它的 `lexer`,不用它的 HTML renderer**。

## 3. 架构与文件划分

新增子目录 `packages/tui/src/components/markdown/`:

| 文件 | 职责 |
|---|---|
| `Markdown.tsx` | 入口组件。`<Markdown source={string} />`:调 `marked.lexer(source, {gfm:true})`,把块级 token 数组分派给 `blocks.tsx`。整体 try/catch 兜底回退纯文本。 |
| `blocks.tsx` | 块级 token → 组件:heading / paragraph / list / blockquote / code / hr / table / space。 |
| `inline.tsx` | 行内 token → 嵌套 `<Text>`:strong / em / del / codespan / link / text,递归。 |
| `table.tsx` | 表格组件(最硬)。消费 `layout.ts` 的纯函数算出的列宽,绘制 box-drawing 网格。 |
| `layout.ts` | **纯函数**:列宽计算、CJK 宽度度量、单元格折行/填充对齐、列宽超限压缩、列表前缀。无 React、无副作用。 |
| `layout.test.ts` | `layout.ts` 的单测(vitest)。 |
| `Markdown.test.ts` | 端到端渲染快照(ink-testing-library)。 |

### 接线点

唯一改动既有文件的地方:[StreamRenderer.tsx](../../../packages/tui/src/components/StreamRenderer.tsx) 的助手分支。当前:

```tsx
<Text>{message.text}</Text>
```

改为按 `isStreaming` 分支:

```tsx
{message.isStreaming
  ? <Text>{message.text}</Text>
  : <Markdown source={message.text} />}
```

其余分支(user / tool / system)、`usage` 行、`Spinner`/`●` 前缀**不动**。`useConversation` hook **完全不改**(见 §6)。

### 新增依赖

`packages/tui/package.json` 增加:

- `marked`(词法器)——dependencies。
- `string-width`(CJK/全角字符显示宽度度量,表格列宽必需)——dependencies。
- `ink-testing-library`(渲染快照测试)——devDependencies。

## 4. 解析:token 模型

`marked.lexer(source, { gfm: true, breaks: false })` 返回块级 token 数组。每个块 token 自带 `tokens`(行内子 token)或 `items`(列表项)。开 `gfm` 拿表格与删除线;关 `breaks`(遵循标准「单换行不成行」)。

块级 token 映射:

| marked token | 渲染 |
|---|---|
| `heading`(`depth` 1–6) | 加粗 + 按层级着色;段后空行 |
| `paragraph` | 行内渲染 + 段后空行 |
| `list`(`ordered` 真/假) | 逐 `item` 渲染,前缀 `• ` 或 `N. `;嵌套递归并缩进 |
| `code`(围栏) | 暗色带框块,顶部可选语言标签,**不高亮** |
| `blockquote` | 左侧 `│ ` 引导 + 递归渲染内部块 |
| `table` | 见 §5 |
| `hr` | 一行 `─` 占满可用宽度 |
| `space` | 吃掉,间距交给段后空行 |
| 未知类型 | 回退渲染其 `.raw` 纯文本(健壮性兜底,绝不抛) |

行内 token 递归映射到嵌套 Ink `<Text>`(`<Text>` 可嵌套并继承样式):

- `strong` → `<Text bold>`
- `em` → `<Text italic>`
- `del` → `<Text strikethrough>`
- `codespan` → `<Text backgroundColor="gray" color="white">`,前后留空格,视觉接近行内码底色
- `link` → `<Text underline color="blue">{文字}</Text>` 后跟 `<Text dimColor>(url)</Text>`;**不做 OSC 8 终端超链接**
- `text` → 裸 `<Text>`

强调可嵌套(`**粗 *斜* **`):靠递归自然解决,子 `<Text>` 套在父 `<Text>` 内,样式叠加。

## 5. 表格与 CJK 宽度(最硬的一块)

终端表格不能靠 Ink flexbox 自动画网格线(相邻单元格边框不合并,会出现双线)。走经典手绘法,全部算术在 `layout.ts` 纯函数里:

1. **测宽**:每个单元格显示宽度用 `string-width` 计算。**关键**:中文/全角字符占 2 列,`String.length` 会算错导致列错位。
2. **列宽**:每列取该列所有单元格(含表头)显示宽度的最大值。
3. **总宽约束**:若各列宽之和 + 分隔线超过终端可用宽度(`process.stdout.columns` 取不到时默认 80),按比例压缩最宽的列,并对超长单元格折行;折行也用 `string-width` 度量,避免在全角字符中间断裂。
4. **绘制**:用 box-drawing 字符拼 `┌─┬─┐` / `├─┼─┤` / `└─┴─┘`,数据行 `│ cell │ cell │`,按 marked 给的 `align`(left/center/right)填充空格;表头行加粗。
5. 整张表渲染为一组 `<Text>` 行(每行一个 `<Text>`,内容已是定宽对齐字符串)。

`layout.ts` 导出(纯函数,全部单测):

- `displayWidth(text): number` —— 包 `string-width`。
- `computeColumnWidths(rows, maxWidth): number[]` —— 列宽计算 + 超限压缩。
- `padCell(text, width, align): string` —— 按对齐填充到定宽。
- `wrapCell(text, width): string[]` —— 不破全角字的折行。
- `listPrefix(ordered, index): string` —— `• ` 或 `N. `。

## 6. 流式双态(本子项核心)

文本由 `text-delta` 逐段拼接,某一刻 `source` 可能只有半个代码围栏或半张表格,边解析边渲染会闪烁、抖动、画出错乱的半截结构。策略(对齐 CC):

- **流式期**(`message.isStreaming === true`):**不解析 Markdown**,直接 `<Text>{message.text}</Text>` 出原始字符——快、稳、不抖。
- **定稿期**(`isStreaming === false`):整段已完整,`<Markdown>` 一次性解析渲染成富文本。

这天然契合现有数据流:[useConversation.ts](../../../packages/tui/src/hooks/useConversation.ts) 已在 `message-stop` 与 `tool-use` 时把对应气泡 `isStreaming` 置 `false`,**无需改 hook**,只在 `StreamRenderer` 读这个现成字段分支。

一条助手回合被工具调用切成多个文本气泡时,每个定稿气泡独立解析——代码块/表格不跨工具调用,故分段解析安全。

## 7. 错误处理与回退

- `marked.lexer` 抛错(理论极罕见)→ `Markdown` 整体回退 `<Text>{source}</Text>`,绝不让渲染崩溃整个 TUI。
- 未知 token 类型 → 渲染其 `.raw`。
- `process.stdout.columns` 取不到(管道/重定向)→ 默认按 80 列算。
- 空 `source` → 渲染 `null`(与现有「空助手气泡不渲染」一致)。

## 8. 测试策略

- **`layout.test.ts`**(纯函数,vitest):
  - `displayWidth` 对全角/半角/混合字符串的宽度。
  - `computeColumnWidths` 含 CJK 列的列宽;超总宽时按比例压缩。
  - `wrapCell` 折行不破全角字。
  - `padCell` left/center/right 对齐填充到定宽。
- **`Markdown.test.ts`**(ink-testing-library 快照):
  - 每类元素(标题/段落/无序+有序列表/嵌套列表/代码块/引用/表格/行内组合)渲染,断言关键字符出现(边框线 `┌│└`、`•`、加粗 ANSI、删除线)。
  - `marked.lexer` 抛错时回退纯文本。
  - 空 source 渲染 null。

## 9. 范围外 / 后续

- **语法高亮**:明确不做。
- **TUI 文案全中文化**:本子项只动助手富文本渲染,不碰 footer/输入框/`Tokens:` 那些英文串;留给 Phase 7「文案全中文化」子项一起做。
- 其余 4 个 Phase 7 子项各自独立 spec→plan。
