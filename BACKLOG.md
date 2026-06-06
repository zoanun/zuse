# 待办点子

开发过程中冒出来、但不属于当前 phase 范围的想法。
每个 phase 结束时回顾一遍，决定是否要拉进下一阶段。

## 点子

- **权限批准框改成 Claude Code 风格的可选列表（挂 Phase 7 · UI 打磨）。** 现状：`packages/tui/src/components/PermissionDialog.tsx` 用单键裁决（`y` 本次 / `a` 本会话 / `A` 写盘 / `n`·Esc 拒绝），靠用户记快捷键。期望：像 CC 那样弹一个可上下方向键移动、回车选中的下拉选项列表（默认单选；若以后有需要再扩展多选）。属纯交互呈现层打磨——**不动 Phase 5 的权限判定逻辑**（`permission.ts` 的 `decide` 与 `PermissionVerdict` 四档裁决不变），只把 TUI 的呈现从"按键提示"换成"选项列表"，文案保持全中文。

- **输入框多行编辑 + Alt+Enter 换行（挂 Phase 7 · UI 打磨）。** 现状：`packages/tui/src/components/InputBox.tsx` 用 `ink-text-input` 单行输入，回车即提交。期望：Alt+Enter 插入换行、输入框随行数增高（多占几行），回车仍提交。`ink-text-input` 是单行组件做不了，需换方案——自写 `useInput` 维护行缓冲，或换一个多行输入组件。纯 UI，不涉及 core。

- **工具执行展示对齐 Claude Code 风格（挂 Phase 7 · UI 打磨）。** 现状：`packages/tui/src/components/StreamRenderer.tsx` 的 `ToolBlock`——运行时一个 spinner、完成后 `✓`/`✗`，旁边一行青色 `Name(args)`，下面只有一行暗色输出首行预览（截 80 字符），看不到"为什么调"和完整 IN/OUT。期望对齐 CC，每次工具调用渲染成一个**带框**的块，含三段：
  - **为什么执行**：模型在该工具调用前后的意图说明（即助手文本里"我来读一下 X / 接着跑测试"那类前导句）。当前 `StreamRenderer` 把助手文本和工具块分开渲染，需要把工具调用和它的前导理由关联起来展示。
  - **IN**：本次调用的完整入参（不只是单行摘要）。
  - **OUT**：工具返回内容，带按工具类型定制的摘要——**`Read` 在标题旁直接显示文件名，参照 CC 去掉括号、只写工具名 + 参数**（如 `Read src/index.ts`，不要 `Read(src/index.ts)`，并配 `Read 120 lines`），`Glob` 报命中文件数（`Found 8 files`），**`Grep` 报输出行数（如 `49 lines of output`）**，**`Edit`/`Write` 显示行变更数（如 `Added 2 lines`、`Removed 3 lines` / `+2 -3`）**；多行折叠可展开，错误态明显标识。
  - 整块用边框（类似 CC 的 `●` 标题 + `⎿` 缩进引导）框起来。纯呈现层，不动工具执行逻辑；"为什么执行"那段可能要在 `useConversation` 里把前导文本与紧随的 tool_use 关联，记下这点依赖。

- **TUI 文案全中文化（挂 Phase 7 · UI 打磨）。** 现状散落英文：`App.tsx` 的 `Zuse Chat (Ctrl+C to exit)`、`Error:`；`InputBox.tsx` 的占位符 `Type your message...` / `Waiting for response...`；`UsageFooter.tsx` 的 `Model:` / `Total:` / `No tokens yet` / `Thinking...`；`StreamRenderer.tsx` 的 `Tokens: ... in / ... out` / `error:`。期望统一改成中文。纯文案、零逻辑改动，顺手在 Phase 7 一起做。

- **Markdown 富渲染（挂 Phase 7 · UI 打磨）。** 现状：助手回复走 `StreamRenderer.tsx` 的 `<Text>{text}</Text>`，Ink 不解析 markdown，所以 `## 标题`、`**加粗**`、代码块都显示成字面量符号。设计文档 §Phase 7（7.1-7.6）和 phase-roadmap 都漏了这一项，但它天然属于 UI 打磨。
  - 选型 A：`marked` + `marked-terminal` 或 `ink-markdown`，省事。
  - 选型 B（更贴合"手搓"学习目标）：自渲染。关键难点是流式——文本由 `text-delta` 逐段拼接，某一刻可能只拿到半个代码围栏，边解析边渲染会闪烁。参考 Claude Code 的双态策略：流式期间按纯文本走，`message-stop` 定稿后再重渲染成富文本。这个"流式 vs 定稿"双态值得专门学。

- **未来可换 Vercel AI SDK（挂 Phase 6 之后 · 可选）。** 现状：Phase 6 手搓 `AnthropicClient` / `OpenAIClient`，吃透两套 tool_use / 流式 / usage 差异（学习目标）。`ModelClient` 这个 seam 留好了——若日后 zuse 转向生产工具、想省维护，把两个 client 换成 `ai` + `@ai-sdk/*` 适配器是局部改动，接口 / agent loop / TUI 全不动。触发条件：要加的 provider 越来越多、边界 case 维护成本超过学习收益时。

- **~~Glob 与 CC 的两处行为差异~~（已完成）。** Grep 已改用 ripgrep（见 `grep.ts`），默认跳过隐藏文件——这正是 CC 的 Grep 行为，算对齐而非 bug。Glob 也已从 `fs.glob` 重写为自写 `readdir` 递归遍历 + `path.matchesGlob`（见 `glob.ts`），原先两处差异均已修复：
  - (1) ~~**dotfile 全盲**~~ → 已含 dotfile，`Glob("**/.env*")` 现可命中 `.env` 等隐藏文件。
  - (2) ~~**排序口径**（字母序）~~ → 已改为按**修改时间倒序**，与 CC 的 Glob 一致。
  - 注：只硬剪 `.git`/`node_modules` 不下钻（性能取舍），其余隐藏文件照常包含；这是相对 CC「默认不应用 gitignore」的一处刻意取舍，非 bug。本条无遗留工作。
