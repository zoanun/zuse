# Zuse Phase Roadmap

> **用途**: 开发每个Phase前，参考此文档找到对应的补充内容、课程具体文件和知识点位置。

**补充文档位置**: `docs/superpowers/specs/2026-05-23-zuse-design-supplement.md`
**课程根目录**: `E:\Harness Engineering 强化班_大模型Agent智能体开发实战\【2026正课】Harness Engineering 强化班\`

---

## Phase总览

| Phase | 主题        | 补充文档章节                                | 课程文件路径                                                   | Claude Code源码   |
| ----- | ----------- | ------------------------------------------- | -------------------------------------------------------------- | ----------------- |
| 0     | Scaffolding | 一（故障模式概览）                          | 【专题课】Harness Engineering驾驭工程实战/Part 1/              | —                 |
| 1     | 单轮对话    | 一（故障模式⑧成本）+ 三（Cache雏形）        | 【专题课】Harness Engineering驾驭工程实战/Part 2/              | query.ts框架      |
| 2     | 多轮+上下文 | 四（Token Budget雏形）                      | 【Part 7】智能体长短期记忆管理/Part 1/                         | context/          |
| 3     | Tool系统    | 二（Agent Loop）+ 三（Cache）+ 一（①④故障） | 【专题课】Harness Engineering驾驭工程实战/Part 1+2/            | tools/ + query.ts |
| 4     | 工具集补全  | 一（④工具错误吞）                           | 【专题课】Harness Engineering驾驭工程实战/Part 2/              | BashTool/         |
| 5     | 权限模型    | 一（⑥缺权限闸）+ 11.3（23项安全检查）       | 【专题课】Harness Engineering驾驭工程实战/Part 1/              | bashSecurity.ts   |
| 6     | 多Provider  | 三（Cache优化）                             | 【专题课】Harness Engineering驾驭工程实战/Part 4/              | —                 |
| 6.5   | 联网工具    | —                                           | —                                                              | WebFetch✅/WebSearch待定|
| 6.6   | 代码智能LSP | —                                           | —                                                              | tools/LSP         |
| 7     | UI打磨      | —                                           | —                                                              | ink/ components/  |
| 8     | 会话管理    | 四（Token Budget）+ 11.6（压缩策略）        | 【Part 7】+【Part 8】+【专题课】Claude Code架构/Part 3/        | services/compact/ |
| 9     | 项目记忆    | 五（记忆系统SQLite）+ 11.2（四种记忆类型）  | 【专题课】Harness Engineering驾驭工程实战/Part 4/ + 【Part 7】 | memdir/           |
| 10+   | Skills系统  | 六（SKILL.md格式）+ 11.7（Skills实现）      | 【Part 6】Agent Skills/                                        | skills/           |
| 11    | 多Agent编排 | 11.4（多Agent架构）                         | Claude Code专题课Part 3 + LangGraph Part 7                     | Agent/Team/Workflow|
| 12    | 调度与自动化| —                                           | —                                                              | Cron/ScheduleWakeup|

---

## Phase 0: Scaffolding

### 补充文档参考

第一章（故障模式防御矩阵概览）— 了解8个故障模式框架

### 课程知识点

| 知识点                      | 课程文件                                                                                                                                  | 具体位置                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Agent = Model + Harness公式 | `【专题课】Harness Engineering驾驭工程实战\Part 1. Harness Engineering 驾驭工程-原理与概念\Harness_Engineering_第一节课_原理与概念.ipynb` | 开篇"三层次能力对比表"                     |
| 8个故障模式概览             | 同上                                                                                                                                      | "naive agent ~50行代码展示8个故障模式"章节 |
| 8大机制概览                 | 同上                                                                                                                                      | "8大机制示意代码片段"章节                  |
| 3支柱框架                   | 同上                                                                                                                                      | "三支柱：CE/AC/GC"章节                     |

### Claude Code源码参考

—（Phase 0纯脚手架，无源码参考）

### 开发要点

- 脚手架搭建，暂不涉及具体机制
- Phase 0完成后，将故障模式矩阵引用加入主设计文档

---

## Phase 1: 单轮对话

### 补充文档参考

- 第一章（故障模式⑧成本失控 → token统计）
- 第三章（Cache优化雏形）

### 课程知识点

| 知识点             | 课程文件                                                                                                                                           | 具体位置                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Agent Loop基础框架 | `【专题课】Harness Engineering驾驭工程实战\Part 2. Harness Engineering 驾驭工程-手搓 Mini Harness\Harness_Engineering_第二节课_mini-Harness.ipynb` | "mini-Harness核心循环代码"章节 |
| 流式响应处理       | 同上                                                                                                                                               | "切流式返回AsyncIterable"章节  |
| Token计数基础      | 同上                                                                                                                                               | "usage统计"章节                |
| 故障模式⑧成本失控  | Part 1笔记本                                                                                                                                       | "故障模式⑧：API调用无限制"章节 |

### Claude Code源码参考

`query.ts` 框架结构（1729行）— AsyncGenerator驱动模式

### 开发要点

- core: 非流式 → 流式 sendMessages
- tui: 输入框 + 流式渲染
- token计数（故障模式⑧防御）

---

## Phase 2: 多轮+上下文

### 补充文档参考

第四章（Token Budget雏形）

### 课程知识点

| 知识点           | 课程文件                                                                                                                                           | 具体位置                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 记忆系统基础认知 | `【Part 7】智能体长短期记忆管理\Part 1. 大模型 Agent 长短期记忆管理基础入门\大模型Agent长短期记忆管理基础入门.ipynb`                               | "第50轮对话时失忆"章节                |
| 热记忆vs冷记忆   | 同上                                                                                                                                               | "记忆分层模型"章节                    |
| Token Budget概念 | 同上                                                                                                                                               | "token配额管理"章节                   |
| 会话状态管理     | `【专题课】Harness Engineering驾驭工程实战\Part 2. Harness Engineering 驾驭工程-手搓 Mini Harness\Harness_Engineering_第二节课_mini-Harness.ipynb` | "ConversationState持有messages[]"章节 |

### Claude Code源码参考

`context/` 目录（1004行）— 上下文组装与管理

### 开发要点

- ConversationState 持有 messages[]
- token预算雏形
- slash command框架: /clear, /save, /load

---

## Phase 3: Tool系统 ⭐ 核心阶段

### 补充文档参考

- 第二章（Agent Loop完整伪代码 + max_turns限制）
- 第三章（Cache优化策略）
- 第一章（故障模式①循环失控 + ④工具错误吞）

### 课程知识点

| 知识点              | 课程文件                                                                                                                                           | 具体位置                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Tool接口定义        | `【专题课】Harness Engineering驾驭工程实战\Part 2. Harness Engineering 驾驭工程-手搓 Mini Harness\Harness_Engineering_第二节课_mini-Harness.ipynb` | "Tool接口 + ToolRegistry"章节               |
| Agent Loop完整实现  | 同上                                                                                                                                               | "tool_use循环（执行→tool_result→回填）"章节 |
| 故障模式①循环失控   | `【专题课】Harness Engineering驾驭工程实战\Part 1. Harness Engineering 驾驭工程-原理与概念\Harness_Engineering_第一节课_原理与概念.ipynb`          | "故障模式①：tool_use无限循环"章节           |
| 故障模式④工具错误吞 | 同上                                                                                                                                               | "故障模式④：工具失败但agent继续"章节        |
| Tool错误处理        | Part 2笔记本                                                                                                                                       | "工具错误处理 + is_error标记"章节           |

### Claude Code源码参考

| 源码文件              | 行数  | 参考内容                     |
| --------------------- | ----- | ---------------------------- |
| `query.ts`            | 1,729 | AsyncGenerator驱动的核心循环 |
| `tools/FileReadTool/` | —     | Read工具实现参考             |
| `utils/messages.ts`   | 5,512 | 消息处理                     |

### 开发要点

- Tool接口定义
- ToolRegistry
- Read工具实现
- Agent Loop: tool_use → tool_result循环
- max_turns=50限制（故障模式①）
- try-except错误捕获（故障模式④）

---

## Phase 4: 工具集补全

### 补充文档参考

第一章（故障模式④工具错误吞）

### 课程知识点

| 知识点        | 课程文件                                                                                                                                           | 具体位置                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Write工具实现 | `【专题课】Harness Engineering驾驭工程实战\Part 2. Harness Engineering 驾驭工程-手搓 Mini Harness\Harness_Engineering_第二节课_mini-Harness.ipynb` | "Write工具"章节                         |
| Edit工具实现  | 同上                                                                                                                                               | "Edit工具 + read-before-edit校验"章节   |
| Bash工具spawn | 同上                                                                                                                                               | "Bash工具（spawn / cwd / timeout）"章节 |
| Glob/Grep工具 | 同上                                                                                                                                               | "Glob + Grep工具"章节                   |
| 长输出截断    | 同上                                                                                                                                               | "长输出截断、行号等体验优化"章节        |

### Claude Code源码参考

| 源码文件               | 参考内容       |
| ---------------------- | -------------- |
| `tools/FileEditTool/`  | Edit工具实现   |
| `tools/FileWriteTool/` | Write工具实现  |
| `tools/BashTool/`      | Bash spawn实现 |
| `tools/GlobTool/`      | 文件搜索       |
| `tools/GrepTool/`      | 内容搜索       |

### 开发要点

- Write/Edit/Bash/Glob/Grep/LS工具
- read-before-edit校验
- spawn + cwd + timeout
- 长输出截断

### ✅ 已实现增强（2026-06-06）—— 与 CC 工具能力对齐

逐一比对 zuse 的 Read/Write/Edit/Glob/Grep 与 CC 同名工具后，按「能力差距 + 高频 + 确定性收益」筛出该补的项（沿用 WebFetch §8.2 的准入思路，不照搬全部 CC API）。结论：Write/Edit 机制已比 CC 更严（指纹乐观锁 vs 时间戳），Glob 已对齐；差距集中在 Grep，外加 Read 一处兜底。本次落地：

- **Grep `output_mode`**：新增 `files_with_matches`（**设为默认**，最省 token）/ `content`（`path:line:text`）/ `count`（`path:count`）三模式，对齐 CC。此前只有 content 一种，模型问「哪些文件含 X / 命中几次」只能拉回全部命中行自己数，白烧 token。
- **Grep 上下文行**：content 模式新增 `before_context` / `after_context` / `context`（= rg `-B`/`-A`/`-C`，`context` 覆盖前两者），定位代码时不必命中后再 Read 一跳。
- **Grep `type` 过滤**：透传 rg `--type`（如 `ts`/`py`/`go`），比手写 glob 省事。
- **Grep `head_limit` + `offset` 分页**：缺省 250 防上下文膨胀、`0` 解除（仍受 1 万行安全上限约束）；`offset` 跳过前 N 条。取代此前写死的 200 条硬截。
- **命名取舍**：新参数沿用 zuse 既有可读 snake_case（`ignore_case`/`replace_all` 一脉），**不照搬** CC 的 `-A`/`-B`/`-C` 字面 JSON key——对齐的是能力，键名服从本仓库一致性（模型只见 zuse schema，无外部兼容需求）。
- **Read 输出字符上限**：新增 `MAX_OUTPUT_CHARS = 100_000`（≈CC 的 25k token 上限，按 ~4 字符/token 粗估）。原「行数 2000 + 单行 2000 字符」挡不住「行少但每行极宽」的文件，这道上限在**行边界**处兜底并提示用 `offset` 续读。
- 覆盖范围：TDD，grep 16（原 9，+7）、read 8（原 6，+2）；全量 174 个用例全绿，三包 typecheck 零错误。

**推迟到后续 phase 的项**：Read 多模态（图片/PDF/Jupyter）——见 Phase 6.6 开发要点。当前 provider 多为文本模型，YAGNI，留待需要视觉模型时再做。

---

## Phase 5: 权限模型

### 补充文档参考

- 第一章（故障模式⑥缺权限闸）
- 11.3（Claude Code 23项Bash安全检查）

### 课程知识点

| 知识点                | 课程文件                                                                                                                                           | 具体位置                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 故障模式⑥缺权限闸     | `【专题课】Harness Engineering驾驭工程实战\Part 1. Harness Engineering 驾驭工程-原理与概念\Harness_Engineering_第一节课_原理与概念.ipynb`          | "故障模式⑥：任意工具可执行"章节              |
| PermissionManager设计 | 同上                                                                                                                                               | "pre-tool hook + 权限决策接口"章节           |
| 权限模式设计          | `【专题课】Harness Engineering驾驭工程实战\Part 2. Harness Engineering 驾驭工程-手搓 Mini Harness\Harness_Engineering_第二节课_mini-Harness.ipynb` | "权限模式（default/acceptEdits/bypass）"章节 |
| Bash安全检查          | `【专题课】Claude Code架构与源码深度解析\Part 2. Claude Code 浓缩版第 1 节·能力与安全边界\ClaudeCode专题课第2节-架构解析.ipynb`                    | "23项Bash安全检查"章节                       |

### Claude Code源码参考

| 源码文件               | 行数  | 参考内容             |
| ---------------------- | ----- | -------------------- |
| `bashSecurity.ts`      | 2,592 | 23项安全检查完整实现 |
| `bashPermissions.ts`   | —     | 权限管理             |
| `shouldUseSandbox.ts`  | —     | 沙箱判断逻辑         |
| `types/permissions.ts` | —     | 权限类型定义         |

### 开发要点

- PermissionManager接口
- pre-tool hook
- 权限对话框UI
- 权限模式: default / acceptEdits / bypassPermissions
- Bash安全检查（参考23项清单）

### ✅ 已实现（2026-06-04）

实现计划见 [`2026-06-04-phase-5-settings-and-permissions.md`](2026-06-04-phase-5-settings-and-permissions.md)。落地内容：

- **三层 `settings.json` 配置系统**：用户层 `~/.zuse/settings.json` < 项目层 `<repo>/.zuse/settings.json`（入 git）< 本地层 `.zuse/settings.local.json`（gitignore，放 secret）。标量高层覆盖、permission 三数组跨层拼接、`ZUSE_API_KEY` 环境变量兜底覆盖 apiKey。
- **配置入口收敛到 `settings.json`，`.env` 退役**：`getClientConfig`/`getDefaultModel`/`getDefaultMaxTokens` 改为接收 `ResolvedSettings`；client 工厂改名 `createAnthropicClient(settings)`。
- **权限模型**：`Tool(specifier)` 规则文法（`Bash(git*)`、`Write(src/**)`）+ `decide()` 判定（禁用 → deny → bypass → allow(+会话覆盖层) → ask → defaultMode 兜底）；**deny 是硬护栏，压过 bypassPermissions**。
- **`ask` 交互式批准**：TUI 弹框，四档裁决——`y` 本次 / `a` 本会话（内存）/ `A` 写盘持久（追加进本地层 `appendAllowRule`）/ `n`·Esc 拒绝。
- **工具暴露开关**：`tools.enabled`/`disabled` 在 `getDefinitions` 过滤暴露，并在 `decide` 兜底 deny。
- 覆盖范围：core 侧全程 TDD（settings / permission / agent 闸门，95 个用例全绿）；TUI 接线按本仓库惯例手工验证。
- **未做（留待后续）**：CC 的 23 项 Bash 安全检查（`bashSecurity.ts`）本期未实现，v1 只用 `deny` 规则（如 `Bash(rm -rf *)`）做粗粒度护栏。

---

## Phase 6: 多Provider

### 补充文档参考

第三章（Cache优化）

### 课程知识点

| 知识点                  | 课程文件                                                                                                                                                           | 具体位置                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| Provider抽象层          | `【专题课】Harness Engineering驾驭工程实战\Part 4. Harness Engineering 驾驭工程 · Hermes Agent 智能体拆解实战\HarnessEngineering第四节-Hermes基础与记忆系统.ipynb` | "ModelClient接口抽象"章节      |
| Anthropic vs OpenAI差异 | 同上                                                                                                                                                               | "tool_use格式差异"章节         |
| Prompt Caching          | 同上                                                                                                                                                               | "Anthropic Prompt Caching"章节 |

### Claude Code源码参考

—（Provider抽象层自研）

### 开发要点

- ModelClient接口抽象
- AnthropicClient + OpenAIClient实现
- Provider无关事件类型
- /model切换
- Cache: cache_control参数

### ✅ 已实现（2026-06-05）

实现计划见 [`2026-06-05-phase-6-multi-provider.md`](2026-06-05-phase-6-multi-provider.md)，设计规格见 [`../specs/2026-06-05-zuse-multi-provider-design.md`](../specs/2026-06-05-zuse-multi-provider-design.md)。落地内容：

- **数据驱动的 `providers` registry**：`settings.json` 中 `providers` 对象，加 provider = 一条配置（`protocol` / `baseURL` / `apiKey` / `models`）+ 一个 env var（`ZUSE_API_KEY_<ID>`）；零业务逻辑改动。
- **`AnthropicClient`**：Anthropic 原生协议 + DashScope 等兼容端点；prompt 缓存 `cache_control` 三断点（system / 最后一个 tool 定义 / 最后一条消息最后一个块滚动）；手写流式事件解析。
- **`OpenAIClient`**：OpenAI 协议（DeepSeek / 本地 Ollama / vLLM）；手写 `tool_call` 分片按 index 累积 + `usage` 抽取；统一映射到 `ModelClient` 事件流。
- **`createModelClient(provider, model)` 工厂**：按 `protocol` 字段分发到对应 client 实现；`createClientFromSettings(settings)` 作为统一入口。
- **`/model` 运行时切换**：session 内生效，`--save` 写盘到本地层，切换不清空历史。
- **footer 显示缓存命中**：`cache_read_input_tokens` 非零时在 UsageFooter 显示缓存命中信息。
- 覆盖范围：全程 TDD，126 个用例全绿；typecheck / lint 零错误。

---

## Phase 6.5: 联网工具（WebFetch / WebSearch）

### 补充文档参考

—（设计文档 §2 把"文件上传/多模态"列为 out-of-scope，但联网读取/检索是 coding agent
的常用能力，单列一个轻量 Phase；放在 Phase 6 之后是因为它依赖多 Provider 抽象做抽取，
依赖 Phase 5 权限闸做授权。）

### 课程知识点

无直接对应课程，参考 Claude Code 的 WebFetch/WebSearch 行为对齐。

### Claude Code 行为参考

| 工具         | CC 行为                                                                       |
| ------------ | ----------------------------------------------------------------------------- |
| **WebFetch** | 抓 URL → HTML 转 Markdown → 用**小/快模型**按 prompt 抽取答案；约 15 分钟缓存 |
| **WebSearch**| 走 Anthropic 后端搜索，只回 标题/URL，**不抓正文**；正文再交给 WebFetch       |

### 选型（开源免费优先）

| 环节                | OSS/免费方案                                                                    |
| ------------------- | ------------------------------------------------------------------------------- |
| HTML→Markdown       | `turndown`(MIT) 或 `node-html-markdown`；正文抽取可加 `@mozilla/readability`     |
| 抽取用的小模型      | 复用 Phase 6 的 ModelClient，配一个便宜模型（如各家的 mini/flash 档）            |
| 搜索 provider       | **无现成 OSS 二进制**——需接一个搜索 API。OSS 自托管首选 **SearXNG**（元搜索，   |
|                     | 全开源）；托管免费档可选 Tavily / Brave Search API。**这是个 provider 决策，待定** |

### 开发要点

- WebFetch：fetch → 转 Markdown → 小模型抽取；带短期缓存（防重复抓取）
- WebSearch：封装搜索 provider，返回 标题/URL 列表；正文按需交给 WebFetch
- 两者都走 Phase 5 权限闸（CC 中均为需授权工具）
- provider 配置沿用数据驱动思路：加搜索源 = 一条配置 + 一个 env var
- **阻塞项**：先定搜索 provider（SearXNG 自托管 vs Tavily/Brave 托管）再动 WebSearch

### ✅ 已实现（2026-06-06）—— 仅 WebFetch

实现计划见 [`2026-06-06-webfetch.md`](2026-06-06-webfetch.md)，设计规格见 [`../specs/2026-06-06-zuse-webfetch-design.md`](../specs/2026-06-06-zuse-webfetch-design.md)。落地内容：

- **`WebFetchTool`**：抓 URL → jsdom + `@mozilla/readability` 抽正文 → turndown（挂 GFM）转 Markdown，交主模型自行阅读。**不在工具内调 LLM**（方案 B，区别于 CC 的小模型抽取）——`ToolContext` 无需 ModelClient。
- **流水线**：url 校验（仅 http/https）→ 去 fragment 的缓存 key → `fetch` + 拟真 UA + 30s 超时（`AbortSignal.any([ctx.signal, timeout])`，兼顾 Ctrl+C）→ 非 2xx/content-type 分流（html 抽取 / text·json·md 原样 / 其余报错）→ **Cloudflare 邮箱混淆还原** → readability 抽取（失败回退 body）→ SPA 空正文提示 → 50000 字符截断 → 写缓存。
- **缓存**：进程内 15 分钟 TTL 内存缓存，惰性过期。
- **权限**：非 `readOnly`（网络出口有副作用），`specifierFor` 返回 hostname，支持 `WebFetch(github.com)` / `WebFetch(*.dev)` 规则收窄。
- **Cloudflare 邮箱混淆还原**（2026-06-06 增）：`deobfuscateCfEmails` 在 turndown 前把 `data-cfemail` 属性与 `email-protection#hex` 片段 XOR 解码回明文（CF 每次轮换 key，按首字节取，免疫轮换）。否则形如 `python@3.12` 的文本被 CF 抹成占位符 `[email protected]`，**实测连 deepseek 旗舰也只能幻觉**——信息不在模型可见文本里，只能确定性解码。准入依据见 spec §8.2「三条件准入线」。
- **已知限制**：不执行 JS，抓不到 SPA 客户端渲染正文（与 `curl` 同短板），此时返回提示而非空白。其余网页混淆（非 CF）按 spec §8.2 准入原则一律记为已知限制、不追。
- 覆盖范围：TDD，webfetch 20（含 cf-email 3）+ 注册 1 共 21 个新用例全绿；typecheck 零错误。

**WebSearch 仍未实现**，阻塞于搜索 provider 决策（SearXNG 自托管 vs Tavily/Brave 托管），见上文阻塞项。

---

## Phase 6.6: 代码智能（LSP）

### 补充文档参考

—（CC 的 LSP 工具：跳转定义 / 找引用 / 类型查询，只读代码智能。归在工具扩展段，紧挨
联网工具；只读、无需授权，主要依赖 Phase 4 的进程 spawn 基建。）

### 课程知识点

无直接对应课程，参考 CC 的 LSP 工具行为。

### 选型（开源免费优先）

| 环节        | OSS/免费方案                                                                       |
| ----------- | ---------------------------------------------------------------------------------- |
| LSP 客户端  | 走标准 LSP（JSON-RPC over stdio），自写薄客户端                                     |
| 语言服务器  | TS/JS：`typescript-language-server`；其余语言按需挂对应 OSS language server         |

### 开发要点

- 薄 LSP 客户端：spawn language server，JSON-RPC 收发（复用 Phase 4 的 spawn 经验）
- 暴露 定义跳转 / 找引用 / 悬停类型 三个高频能力
- 按 cwd 探测项目语言，懒启动对应 server，复用同一进程
- 只读、无副作用 → 不进权限闸

#### ⏳ Read 多模态（从 Phase 4 对齐工作推迟过来）

CC 的 Read 能读图片（PNG/JPG，视觉呈现给多模态模型）、PDF（`pages` 参数）、Jupyter notebook（`.ipynb`，含 cell 输出）；zuse 当前的 Read 仅文本。推迟而非现做的理由：当前 provider 多为纯文本模型，多模态 Read 需要先有视觉模型接入才有意义（YAGNI）。真要做时的要点：

- 按扩展名/MIME 分流：图片 → base64 走多模态 content block；PDF → 取指定页转图或抽文本；`.ipynb` → 解析 cell + 输出。
- 依赖能力探测：仅当当前 provider/模型声明支持视觉时才启用图片路径，否则回退报错提示。
- 与现有文本 Read 同流水线（路径解析、tracker 登记、错误归一）共存，只是 content 形态不同。

---

## Phase 7: UI打磨

### 补充文档参考

—（UI层，课程略讲）

### 课程知识点

无直接对应课程，参考Claude Code源码

### Claude Code源码参考

| 源码目录      | 行数   | 参考内容                  |
| ------------- | ------ | ------------------------- |
| `ink/`        | 19,842 | 终端UI引擎（50x性能优化） |
| `components/` | 81,546 | UI组件库                  |
| `hooks/`      | 19,204 | React Hooks（87个）       |

### 开发要点

- Edit diff渲染
- /tools列表
- /history滚动
- Ctrl+C/Esc处理
- footer显示
- **`/model` 交互式选择器**（设计已定，2026-06-06）

#### `/model` 交互式选择器（已敲定的设计决策）

把现在 `/model` 无参时的 40+ 行纯文本 dump 换成一个交互式覆盖层。**形态：键盘驱动 + 输入即模糊过滤 + 滚动视口**：

- 方向键 / `j k` 移动，输入字符即时过滤候选（输 `mimo` → 直接筛到一条），`Enter` 选中切换，`Esc` 取消。
- 超出高度用滚动视口 + 位置指示（`↑更多 / ↓更多`）。
- 当前模型高亮（复用现有 `currentProviderId` + `currentModel` 配对判定）。

**明确不做鼠标点击**，理由（避免 Phase 7 时重新纠结）：

1. Ink 不原生支持鼠标，得手开终端鼠标追踪（SGR 1006）+ 自解析 stdin 原始事件，脆且重。
2. 一旦开 app 鼠标捕获，就抢了终端自身的拖选复制；且 tmux / SSH / 部分终端鼠标事件传不进来。
3. 非 TUI 惯用法（fzf / lazygit / gh / Claude Code 全是键盘驱动）。

**与已有校验逻辑的关系**：选择器从过滤后的列表里选，天然选不到不存在的模型，`mino→mimo` 那类拼错从源头消除。Phase 6 收尾时给 `/model <ref>` 直输路径加的「不在清单 → 警告 / 相近候选则拒绝切换 / 否则切换但不写盘」逻辑（见 [`packages/tui/src/commands/registry.ts`](../../../packages/tui/src/commands/registry.ts)）**保留**，退化为非交互直输路径与脚本/自动化的兜底。

**待定点**：用 `ink-select-input`（已在依赖友好范围）还是自写一个带 filter 的小组件——开发前再定。

---

## Phase 8: 会话管理

### 补充文档参考

- 第四章（Token Budget完整策略 + 压缩触发条件）
- 11.6（AutoCompact策略）

### 课程知识点

| 知识点                | 课程文件                                                                                                                                               | 具体位置                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| 记忆压缩策略          | `【Part 7】智能体长短期记忆管理\Part 1. 大模型 Agent 长短期记忆管理基础入门\大模型Agent长短期记忆管理基础入门.ipynb`                                   | "压缩策略"章节              |
| 上下文工程基础        | `【Part 8】智能体上下文工程\Part 1. AI Agent 上下文工程管理基础入门\大模型Agent上下文工程基础入门.ipynb`                                               | "Context Window Budget"章节 |
| 组合编排实战          | `【Part 8】智能体上下文工程\Part 2. 大模型 Agent 上下文工程进阶——组合编排实战\大模型 Agent 上下文工程进阶—组合编排实战.ipynb`                          | "system prompt拼接"章节     |
| Claude Code上下文工程 | `【专题课】Claude Code架构与源码深度解析\Part 3. Claude Code 浓缩版第 3 节·多智能体与上下文工程\Claude Code 专题课第 3 节：多智能体与上下文工程.ipynb` | "约束工作台"章节            |

### Claude Code源码参考

| 源码目录/文件       | 参考内容            |
| ------------------- | ------------------- |
| `services/compact/` | AutoCompact压缩服务 |
| `utils/messages.ts` | MicroCompact实现    |

### 开发要点

- session按cwd分组
- --continue / --resume参数
- 每轮自动保存
- Token Budget分配
- 压缩策略: keep_recent_n + summarize_middle

---

## Phase 9: 项目记忆

### 补充文档参考

- 第五章（记忆系统SQLite + FTS5 + 表结构）
- 11.2（四种记忆类型定义）

### 课程知识点

| 知识点              | 课程文件                                                                                                                                                           | 具体位置                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| Hermes记忆系统架构  | `【专题课】Harness Engineering驾驭工程实战\Part 4. Harness Engineering 驾驭工程 · Hermes Agent 智能体拆解实战\HarnessEngineering第四节-Hermes基础与记忆系统.ipynb` | "SQLite + FTS5全文搜索"章节     |
| Nudge机制           | 同上                                                                                                                                                               | "自动review并更新MEMORY.md"章节 |
| 四维评价尺          | 同上                                                                                                                                                               | "GC/AC/CE/入口治理"章节         |
| mem0集成实战        | `【Part 7】智能体长短期记忆管理\Part 2. Agent 记忆管理系统进阶——mem0+Claude Code 集成实战\大模型Agent长短期记忆管理进阶实战.ipynb`                                 | "mem0记忆管理"章节              |
| Claude Code记忆系统 | `【专题课】Claude Code架构与源码深度解析\Part 3. Claude Code 浓缩版第 3 节·多智能体与上下文工程\Claude Code 专题课第 3 节：多智能体与上下文工程.ipynb`             | "第四章：约束记忆"章节          |

### Claude Code源码参考

| 源码文件                         | 参考内容           |
| -------------------------------- | ------------------ |
| `memdir/memdir.ts`               | 记忆目录核心逻辑   |
| `memdir/memoryTypes.ts`          | 四种记忆类型定义   |
| `memdir/memoryScan.ts`           | 记忆扫描           |
| `memdir/findRelevantMemories.ts` | 相关记忆检索       |
| `services/autoDream/`            | Auto Dream记忆巩固 |

### 开发要点

- 加载 ~/.zuse/SYSTEM.md
- cwd向上找 ZUSE.md
- SQLite + FTS5存储
- Nudge机制（自动更新MEMORY.md）

---

## Phase 10+: Skills系统

### 补充文档参考

- 第六章（SKILL.md格式 + 目录结构）
- 11.4（多Agent架构）
- 11.7（Skills实现）

### 课程知识点

| 知识点               | 课程文件                                                                                                                                               | 具体位置                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| Agent Skills基础入门 | `【Part 6】Agent Skills\Part 1. 大模型 Agent Skills 基础入门\大模型Agent_Skills_基础入门.ipynb`                                                        | 全部内容                   |
| Skills设计实战       | `【Part 6】Agent Skills\Part 2. 大模型 Agent Skills 设计实战\大模型AgentSkills设计实战.ipynb`                                                          | 全部内容                   |
| SKILL.md格式详解     | 同上Part 1的"其他资料/other/skills/skill-creator-pro/SKILL.md"                                                                                         | frontmatter + workflow结构 |
| 多Agent架构          | `【专题课】Claude Code架构与源码深度解析\Part 3. Claude Code 浓缩版第 3 节·多智能体与上下文工程\Claude Code 专题课第 3 节：多智能体与上下文工程.ipynb` | "Coordinator Mode"章节     |
| LangGraph多Agent     | `【专题课】Agent框架 LangGraph应用实战\7. LangGraph Multi-Agent Systems 开发实战.ipynb`                                                                | "Multi-Agent Systems"章节  |

### Claude Code源码参考

| 源码目录/文件                    | 参考内容      |
| -------------------------------- | ------------- |
| `skills/` (4,066行)              | Skill系统实现 |
| `coordinator/coordinatorMode.ts` | 多Agent编排   |
| `tools/AgentTool/`               | 子Agent生成   |
| `tools/SendMessageTool/`         | Agent间通信   |

### 开发要点

- SKILL.md格式定义
- 技能加载机制
- 技能匹配触发
- 多Agent Coordinator模式 → 抽到 **Phase 11** 单独做

---

## Phase 11: 多Agent与编排

### 补充文档参考

11.4（多Agent架构）

### 课程知识点

| 知识点               | 课程文件                                                                                                                                               | 具体位置                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| 多Agent架构          | `【专题课】Claude Code架构与源码深度解析\Part 3. Claude Code 浓缩版第 3 节·多智能体与上下文工程\Claude Code 专题课第 3 节：多智能体与上下文工程.ipynb` | "Coordinator Mode"章节    |
| LangGraph多Agent     | `【专题课】Agent框架 LangGraph应用实战\7. LangGraph Multi-Agent Systems 开发实战.ipynb`                                                                | "Multi-Agent Systems"章节 |

### Claude Code 工具对照

| 工具                          | 作用                                       |
| ----------------------------- | ------------------------------------------ |
| **Agent**（= 老的 Task）      | 生成子 Agent 执行隔离的子任务，返回结果      |
| **TeamCreate / TeamDelete**   | 创建/销毁可寻址的 agent team                 |
| **SendMessage**               | 子 Agent 间 / 与子 Agent 通信                |
| **Workflow**                  | 确定性多 Agent 编排脚本（fan-out / pipeline）|

### Claude Code 源码参考

| 源码目录/文件                    | 参考内容      |
| -------------------------------- | ------------- |
| `coordinator/coordinatorMode.ts` | 多Agent编排   |
| `tools/AgentTool/`               | 子Agent生成   |
| `tools/SendMessageTool/`         | Agent间通信   |

### 开发要点

- Agent/Task 工具：子 Agent 隔离上下文跑子任务，结果回填父循环（max_turns、token 预算独立）
- team 注册表 + SendMessage 通信通道
- Workflow：确定性编排（parallel / pipeline 原语），子 Agent 并发上限 + 总数兜底
- 自研为主——无现成 OSS 二进制可换（与 CC 一致，多 Agent 编排是手搓）

---

## Phase 12: 调度与自动化（Cron / Wakeup）

### 补充文档参考

—（CC 的 Cron / ScheduleWakeup：定时触发与自唤醒。属于自动化能力，依赖会话管理
（Phase 8）能 resume，放在最后。）

### Claude Code 工具对照

| 工具                                | 作用                       |
| ----------------------------------- | -------------------------- |
| **CronCreate / CronDelete / CronList** | 注册/删除/列出定时任务      |
| **ScheduleWakeup**                  | 会话内自唤醒（延时再跑）    |

### 选型（开源免费优先）

| 环节       | OSS/免费方案                                                          |
| ---------- | -------------------------------------------------------------------- |
| 进程内调度 | `node-cron` / `croner`（轻量、MIT）                                   |
| 持久化触发 | 或委托 OS 调度器（Windows 任务计划 / cron），zuse 以 `--resume` 拉起 |

### 开发要点

- Cron 任务表：cron 表达式 + 目标会话 + 触发动作，持久化到 ~/.zuse/
- ScheduleWakeup：相对延时的一次性唤醒
- 触发时以 `--resume` 拉起对应会话（依赖 Phase 8 会话管理）
- 自动化跑务必走 Phase 5 权限闸，避免无人值守下的越权

---

## 快速查阅索引

### 按知识点查课程

| 知识点              | 课程文件                                                            |
| ------------------- | ------------------------------------------------------------------- |
| Agent Loop核心循环  | 【专题课】Harness Engineering驾驭工程实战/Part 2/mini-Harness.ipynb |
| 8个故障模式全览     | 【专题课】Harness Engineering驾驭工程实战/Part 1/原理与概念.ipynb   |
| 权限模型设计        | 【专题课】Harness Engineering驾驭工程实战/Part 1 + Part 2           |
| 23项Bash安全检查    | 【专题课】Claude Code架构与源码深度解析/Part 2/架构解析.ipynb       |
| Token Budget + 压缩 | 【Part 7】+【Part 8】+ Claude Code专题课Part 3                      |
| SQLite记忆系统      | 【专题课】Harness Engineering驾驭工程实战/Part 4/Hermes.ipynb       |
| 四种记忆类型        | Claude Code专题课Part 3 + Hermes Part 4                             |
| Skills SKILL.md格式 | 【Part 6】Agent Skills/Part 1/其他资料/skill-creator-pro/SKILL.md   |
| 多Agent Coordinator | Claude Code专题课Part 3 + LangGraph Part 7                          |

### 按源码查参考

| 源码文件                 | Zuse对应Phase |
| ------------------------ | ------------- |
| query.ts (1729行)        | Phase 1, 3    |
| bashSecurity.ts (2592行) | Phase 5       |
| context/ (1004行)        | Phase 2, 8    |
| services/compact/        | Phase 8       |
| memdir/ (1736行)         | Phase 9       |
| skills/ (4066行)         | Phase 10+     |
| coordinator/             | Phase 10+     |

---

## 课程文件完整路径索引

### Harness Engineering专题课

```
【专题课】Harness Engineering驾驭工程实战\
├── Part 1. Harness Engineering 驾驭工程-原理与概念\
│   └── Harness_Engineering_第一节课_原理与概念.ipynb
│       ├── 知识点: Agent=Model+Harness公式
│       ├── 知识点: 8个故障模式
│       ├── 知识点: 8大机制
│       └── 知识点: 3支柱(CE/AC/GC)
│
├── Part 2. Harness Engineering 驾驭工程-手搓 Mini Harness\
│   └── Harness_Engineering_第二节课_mini-Harness.ipynb
│       ├── 知识点: Agent Loop实现
│       ├── 知识点: Tool接口定义
│       ├── 知识点: 工具集(Read/Write/Edit/Bash/Glob/Grep)
│       └── 知识点: 权限模式框架
│
├── Part 4. Harness Engineering 驾驭工程 · Hermes Agent 智能体拆解实战\
│   └── HarnessEngineering第四节-Hermes基础与记忆系统.ipynb
│       ├── 知识点: SQLite+FTS5记忆系统
│       ├── 知识点: Nudge机制
│       ├── 知识点: Provider抽象层
│       └── 知识点: 四维评价尺
```

### Part 7 + Part 8 记忆与上下文

```
【Part 7】智能体长短期记忆管理\
├── Part 1. 大模型 Agent 长短期记忆管理基础入门\
│   └── 大模型Agent长短期记忆管理基础入门.ipynb
│       ├── 知识点: 热记忆vs冷记忆
│       ├── 知识点: 记忆分层模型
│       └── 知识点: 压缩策略
│
└── Part 2. Agent 记忆管理系统进阶——mem0+Claude Code 集成实战\
    └── 大模型Agent长短期记忆管理进阶实战.ipynb
        └── 知识点: mem0集成

【Part 8】智能体上下文工程\
├── Part 1. AI Agent 上下文工程管理基础入门\
│   └── 大模型Agent上下文工程基础入门.ipynb
│       ├── 知识点: Context Window Budget
│       └── 知识点: 压缩触发条件
│
└── Part 2. 大模型 Agent 上下文工程进阶——组合编排实战\
    └── 大模型 Agent 上下文工程进阶—组合编排实战.ipynb
        └── 知识点: system prompt拼接
```

### Part 6 Agent Skills

```
【Part 6】Agent Skills\
├── Part 1. 大模型 Agent Skills 基础入门\
│   ├── 大模型Agent_Skills_基础入门.ipynb
│   └── 其他资料/other/skills/skill-creator-pro/SKILL.md
│       ├── 知识点: SKILL.md格式(frontmatter+workflow)
│       ├── 知识点: 技能加载机制
│       └── 知识点: Progressive Disclosure
│
└── Part 2. 大模型 Agent Skills 设计实战\
    └── 大模型AgentSkills设计实战.ipynb
```

### Claude Code专题课

```
【专题课】Claude Code架构与源码深度解析\
├── Part 2. Claude Code 浓缩版第 1 节·能力与安全边界\
│   └── ClaudeCode专题课第2节-架构解析.ipynb
│       ├── 知识点: 23项Bash安全检查
│       └── 知识点: 权限类型定义
│
├── Part 3. Claude Code 浓缩版第 3 节·多智能体与上下文工程\
│   └── Claude Code 专题课第 3 节：多智能体与上下文工程.ipynb
│       ├── 知识点: 约束工作台(上下文管理)
│       ├── 知识点: 约束记忆(四种记忆类型)
│       ├── 知识点: Coordinator Mode多Agent
│       └── 知识点: AutoCompact压缩策略
```

---

_开发每个Phase前，先查阅对应课程文件的具体知识点章节，再写详细实现计划。_
