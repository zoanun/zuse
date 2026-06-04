# 待办点子

开发过程中冒出来、但不属于当前 phase 范围的想法。
每个 phase 结束时回顾一遍，决定是否要拉进下一阶段。

## 点子

- **Markdown 富渲染（挂 Phase 7 · UI 打磨）。** 现状：助手回复走 `StreamRenderer.tsx` 的 `<Text>{text}</Text>`，Ink 不解析 markdown，所以 `## 标题`、`**加粗**`、代码块都显示成字面量符号。设计文档 §Phase 7（7.1-7.6）和 phase-roadmap 都漏了这一项，但它天然属于 UI 打磨。
  - 选型 A：`marked` + `marked-terminal` 或 `ink-markdown`，省事。
  - 选型 B（更贴合"手搓"学习目标）：自渲染。关键难点是流式——文本由 `text-delta` 逐段拼接，某一刻可能只拿到半个代码围栏，边解析边渲染会闪烁。参考 Claude Code 的双态策略：流式期间按纯文本走，`message-stop` 定稿后再重渲染成富文本。这个"流式 vs 定稿"双态值得专门学。

- **~~Glob 与 CC 的两处行为差异~~（已完成）。** Grep 已改用 ripgrep（见 `grep.ts`），默认跳过隐藏文件——这正是 CC 的 Grep 行为，算对齐而非 bug。Glob 也已从 `fs.glob` 重写为自写 `readdir` 递归遍历 + `path.matchesGlob`（见 `glob.ts`），原先两处差异均已修复：
  - (1) ~~**dotfile 全盲**~~ → 已含 dotfile，`Glob("**/.env*")` 现可命中 `.env` 等隐藏文件。
  - (2) ~~**排序口径**（字母序）~~ → 已改为按**修改时间倒序**，与 CC 的 Glob 一致。
  - 注：只硬剪 `.git`/`node_modules` 不下钻（性能取舍），其余隐藏文件照常包含；这是相对 CC「默认不应用 gitignore」的一处刻意取舍，非 bug。本条无遗留工作。
