# 待办点子

开发过程中冒出来、但不属于当前 phase 范围的想法。
每个 phase 结束时回顾一遍，决定是否要拉进下一阶段。

## 点子

- **Markdown 富渲染（挂 Phase 7 · UI 打磨）。** 现状：助手回复走 `StreamRenderer.tsx` 的 `<Text>{text}</Text>`，Ink 不解析 markdown，所以 `## 标题`、`**加粗**`、代码块都显示成字面量符号。设计文档 §Phase 7（7.1-7.6）和 phase-roadmap 都漏了这一项，但它天然属于 UI 打磨。
  - 选型 A：`marked` + `marked-terminal` 或 `ink-markdown`，省事。
  - 选型 B（更贴合"手搓"学习目标）：自渲染。关键难点是流式——文本由 `text-delta` 逐段拼接，某一刻可能只拿到半个代码围栏，边解析边渲染会闪烁。参考 Claude Code 的双态策略：流式期间按纯文本走，`message-stop` 定稿后再重渲染成富文本。这个"流式 vs 定稿"双态值得专门学。

- **Glob/Grep 对 dotfile 全盲（挂 Phase 5/6 · 文件树遍历硬化）。** Phase 4 实测发现的真 bug：Glob 和 Grep 都基于 Node 内置 `fs.glob` 枚举文件，而 `fs.glob` 默认 `dot:false` 且**没有开启 dotfile 的选项**（`{dot:true}` 被无视）。后果：`Glob("**/.env*")`、`Grep` 搜内容时全都跳过 `.env`/`.gitignore`/`.prettierrc.json` 等隐藏文件，只有写死的字面量名 `Glob(".env")` 才命中。模型据此会误判"项目里没有 .env"。LS 走 `readdir` 不受影响。
  - 修法：Glob/Grep 改用自写的 `readdir` 递归遍历（像 ripgrep 那样默认含 dotfile，再靠 `.gitignore` 规则排除 `node_modules`/`.git` 等）。这跟 Phase 5/6 要做的"尊重 .gitignore 的文件树遍历"是同一件事，合并做更省。
