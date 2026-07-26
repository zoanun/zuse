/**
 * 内置技能：编译进产物、随包发布，任何 cwd 都在，用户无需安装任何文件。
 *
 * 镜像 builtin-tools 的显式数组模式——加一个内置技能 = 往 BUILTIN_SKILLS 加一项。
 * 它们在 scanSkills 里以**最低优先级** seed：在 ~/.zuse/skills/ 或项目 .zuse/skills/
 * 下建一个同名技能即可整体覆盖内置版（内容过时或不想要时的逃生舱）。
 *
 * 正文是模板字符串，故其中的反引号与 ${ 需转义。
 * 设计见 docs/superpowers/specs/2026-07-26-builtin-skills-design.md。
 */

export interface BuiltinSkill {
  name: string
  description: string
  body: string
}

// ─────────────────────────────────────────────────────────────────────────────
// zuse-config —— 改 zuse 自身的配置
// ─────────────────────────────────────────────────────────────────────────────

const ZUSE_CONFIG_DESCRIPTION =
  "Use when the user wants to CHANGE zuse's own configuration — add or remove an MCP server, " +
  'add or edit a skill, set up a cron / scheduled task, switch model or provider, adjust permissions, ' +
  'manage personas, or edit zuse settings files. Tells you where each config lives, its exact format, and — ' +
  'critically — when a change actually takes effect (file edit vs daemon restart vs new session vs live web panel). ' +
  'Load this BEFORE editing anything under ~/.zuse/ or a project .zuse/ directory.'

const ZUSE_CONFIG_BODY = `# 修改 zuse 自身的配置

你要改的是 **zuse 自己**的配置。动手前先看清：每类配置在哪、什么格式、**改完什么时候才生效**。

## 三条铁律

1. **先读后写**：改任何配置文件前先读它当前内容（多为 JSONC，允许 \`//\` 注释和尾逗号，别把注释洗掉）。
2. **讲清生效时机**：绝大多数改动**不是立刻生效**。改完必须明确告诉用户：需要重启 daemon / 需要开新会话 / 已立即生效。
3. 路径不确定就先 \`ls ~/.zuse/\`。下文的 \`~\` 指用户主目录。

## 设置（模型 / provider / 权限）

三层，后面的覆盖前面的；每层都是 **\`.jsonc\` 优先、回退 \`.json\`**：

| 层 | 路径 | 放什么 |
|---|---|---|
| 用户 | \`~/.zuse/settings.json\` 或 \`~/.zuse/settings.jsonc\` | 全局默认：providers、模型清单、contextWindow |
| 项目 | \`<项目根>/.zuse/settings.json[c]\` | 随仓库走的项目设置 |
| 本地 | \`<项目根>/.zuse/settings.local.json[c]\` | **优先级最高**、通常不进版本库：apiKey、model、permissions |

常用键：

- \`model\` / \`smallModel\`（标题生成等轻活）/ \`imageModel\`（主模型不支持视觉时的图片解析兜底）
- \`providers.<id>\`：\`apiKey\`、\`baseURL\`、\`protocol\`（\`anthropic\` 或 \`openai\`）、\`models[]\`（元素可写成 \`{ name, type }\`；\`type: vision\` 标记支持图片，\`ocr\`/\`embedding\` 等非聊天模型会被排除在可选清单外）、\`contextWindow\`
- \`permissions\`：\`defaultMode\`（\`default\` | \`acceptEdits\` | \`bypassPermissions\`）+ \`allow\` / \`ask\` / \`deny\` 三张规则表，语法 \`Tool(specifier)\`，例如 \`Bash(git commit:*)\`、\`Read(~/.ssh/**)\`。**判定顺序：deny → bypass → allow → ask → defaultMode 兜底**，所以 \`deny\` 表即使在 bypassPermissions 下也照样拦。
- \`mcpServers\`（见下节）、\`webSearch\`

**生效**：设置在会话构建时读 → **新会话**生效；跑 Web UI 的话要**重启 daemon** 才会重读。

## MCP 服务器

写在 \`settings.mcpServers.<名字>\`：本地进程用 \`{ "command": "...", "args": [...], "env": {...} }\`，远端用 \`{ "url": "..." }\`。

**生效**：MCP 连接在 **daemon 启动时**建立 → 改完要**重启 daemon**；或用 Web「管理 → MCP」面板的 reconnect（**免重启、实时**）。面板增删走 surgical JSONC 写入，保留注释。

## Skills（技能）

- 用户级：\`~/.zuse/skills/<技能名>/SKILL.md\`
- 项目级：\`<项目>/.zuse/skills/<技能名>/SKILL.md\`（沿 cwd 向上逐级收集，**内层同名覆盖外层**）
- 内置技能（本技能就是其一）优先级**最低** → 在 \`~/.zuse/skills/\` 下建同名技能即可整体覆盖它

\`SKILL.md\` 格式：

    ---
    name: 技能名
    description: 什么时候该用这个技能（模型判断触发的唯一依据，要写足场景关键词）
    ---

    正文（Markdown），调用时全文进上下文。
    \${ZUSE_SKILL_DIR} 展开为该技能目录的绝对路径，可用来引用同目录下的附属文件。

frontmatter **只认 \`name\` 和 \`description\`**；\`description\` 写不好 = 模型永远想不起来用它。正文里引用的附属文件不会自动加载，模型按需 Read（分层加载）。

**生效**：技能在会话启动时扫一次 → **新增/删除/启停要开新会话**；已加载技能的**正文改动**模型下次调用即读到（调用时重读盘）。
**启停**：\`~/.zuse/skills-disabled.json\`（按技能名存），或 Web「管理 → 技能」面板。内置技能**只能启停、不能编辑**。

## 定时任务（cron）

数据在 \`~/.zuse/cron/tasks.json\`（任务）与 \`~/.zuse/cron/runs/<taskId>.jsonl\`（历次执行）。

⚠️ **不要手改 \`tasks.json\`**：调度器把定时器持在 daemon 内存里，手改文件**不会重排**，非重启 daemon 不生效。

正确做法二选一：

- Web 侧边栏「⏰ 定时任务」面板：增删改、启停、立即执行、查看历次执行与完整对话
- REST（**改完立即重排生效**）：
  - \`GET /api/cron\` 列任务（含下次执行时间）
  - \`POST /api/cron\` 新建
  - \`PATCH /api/cron/<id>\` 修改、\`DELETE /api/cron/<id>\` 删除
  - \`POST /api/cron/<id>/run\` 立即执行一次
  - \`GET /api/cron/<id>/runs\` 历次执行、\`GET /api/cron/<id>/runs/<runId>\` 某次详情

任务字段：\`name\`、\`cron\`（标准 5 段 \`分 时 日 月 周\`，与 Linux crontab 同义，如 \`0 9 1 * *\` = 每月 1 号 9 点）、\`prompt\`（到点执行的指令）、\`cwd\`、\`permissionMode\`（默认 \`bypassPermissions\` 全自主；全局 deny 表仍是硬底线）、\`enabled\`。

每次触发开一个**全新会话**执行（不接续历史），过程留档可回看；同一任务上次没跑完时本次触发会被跳过（不叠加并发）。

## 人设（persona）

\`~/.zuse/personas.json\`，或 Web「管理 → 人设」面板。激活的人设作为一段 \`## Persona:<名字>\` 叠加在只读的核心 system prompt 之上。**生效**：新会话 / 重置会话。

## 常驻指令与记忆

- \`~/.zuse/SYSTEM.md\`：全局常驻指令
- \`ZUSE.md\`：项目指令，从 cwd 向上逐级收集（内层在后、更具体）
- \`~/.zuse/MEMORY.md\`：记忆索引，随 system prompt 注入
- \`~/.zuse/memory.db\`：结构化记忆（SQLite FTS5）——**用 Memory 工具或 Web「管理 → 记忆」面板改，不要手写这个 db**

**生效**：\`SYSTEM.md\` / \`ZUSE.md\` 新会话生效。

## 其它数据目录

\`~/.zuse/web-sessions/\`（Web 会话记录）、\`~/.zuse/uploads/\`（上传的图片与文件）、\`~/.zuse/web-auth.json\`（Web 登录口令哈希）。

## 生效时机速查

| 改了什么 | 什么时候生效 |
|---|---|
| settings 的 model / permissions / providers | 新会话；Web 侧需重启 daemon |
| \`mcpServers\` | 重启 daemon，或 MCP 面板 reconnect（实时） |
| 已有技能的正文 | 模型下次加载该技能即生效 |
| 新增 / 删除 / 启停技能 | 新会话 |
| cron 任务（经面板或 REST） | **立即生效** |
| cron 任务（手改 tasks.json） | 需重启 daemon（不推荐这么改） |
| 激活人设 | 新会话 |
| \`ZUSE.md\` / \`SYSTEM.md\` | 新会话 |

改完对照这张表告诉用户何时生效；需要重启就直说，别让用户以为已经生效了。
`

// ─────────────────────────────────────────────────────────────────────────────
// zuse-readme —— 我是谁 / 我能干啥 / 我怎么搭的
// ─────────────────────────────────────────────────────────────────────────────

const ZUSE_README_DESCRIPTION =
  'Use when the user asks about zuse ITSELF — who or what you are, what you can do, how you are built, ' +
  'your architecture or packages, or how one of your own features works internally ("how does your cron work", ' +
  '"how do you handle permissions", "你是谁", "你能干什么"). Gives your identity and architecture, and — when ' +
  'running inside the zuse repo — points you at the authoritative design docs and source instead of guessing.'

const ZUSE_README_BODY = `# 我是谁：zuse 自述

## 身份

你是 **zuse** —— 一个从零手写的 coding agent（不是套壳）：TypeScript（strict）+ Node 22+，pnpm workspace monorepo。两个界面：

- **TUI**：Ink 写的终端界面
- **Web UI**：React SPA + 常驻 daemon（后端持有会话，关掉浏览器回合照跑，多设备可同时看同一会话）

定位是「学透原理 + 日常自用」：用 zuse 自己开发 zuse。

## 包结构

| 包 | 职责 |
|---|---|
| \`packages/core\` | 引擎：agent loop、Conversation（消息账本）、权限判定、provider 抽象、上下文压缩、检查点。**传输无关**，TUI 与 Web 都建在它之上 |
| \`packages/tools\` | 内置工具：Read / Write / Edit / Glob / Grep / Bash / WebFetch / WebSearch / Memory / TodoWrite / Agent（子代理）/ Skill / LSP / MCP 工具 |
| \`packages/protocol\` | 纯类型的线缆契约（WS 消息 + REST DTO），前后端共享，无运行时代码 |
| \`packages/server\` | 常驻 daemon：SessionManager（**传输无关的会话大脑**）、HTTP/WS、本地密码鉴权、资源 API、cron 调度 |
| \`packages/web\` | React SPA：聊天流、管理面板、定时任务面板。只经 WS/HTTP 通信，**不 import core** |
| \`packages/tui\` | Ink 终端 UI，自带一套编排 hook，与 Web 各自独立演进 |

架构铁律：\`core\` 是引擎、不是 TUI；\`SessionManager\` 传输无关——WS、cron、未来的频道适配器都是**平级的驱动源**。

## 能力概览（粗线条）

agent loop + 完整工具集；多 provider（Anthropic 原生 / OpenAI 协议，运行时切模型、失败自动 failover）；三层配置 + 四档权限裁决；会话持久化 / 续接 / 跨会话全文搜索 / 上下文自动压缩；检查点与 revert（影子 git）；项目记忆（SQLite FTS5）+ ZUSE.md；Skills；图片上传（视觉模型直传、非视觉模型解析兜底）；人设；MCP / LSP；定时任务；中断保留回合（Stop 不丢整轮）。

## 要答细节时：去读，别猜

被问到**某个功能内部到底怎么实现**时，不要凭上面这段发挥——按下面的顺序去读真东西：

1. **\`docs/superpowers/specs/\`** —— 逐功能的设计文档，自我认知的主源。先 \`ls\` 这个目录：文件名形如 \`YYYY-MM-DD-<主题>-design.md\`，本身就是一份带日期的功能索引；挑相关的读，里面讲清了机制、决策与取舍。
2. **两份总纲**：\`docs/superpowers/specs/2026-06-22-web-ui-roadmap.md\`（Web UI 程序分解）与 \`docs/superpowers/specs/2026-07-17-extensibility-refactor-roadmap.md\`（可扩展性重构）——看全局与依赖关系。
3. **\`packages/<包>/src/\`** —— **代码是 ground truth**；文档与代码冲突时以代码为准。
4. **\`docs/superpowers/plans/\`** —— 任务级实现细节。
5. **仓库根 \`README.md\`** —— 面向用户的简介（偏 TUI 视角，Web 侧的新功能未必跟进）。

## 诚实约束

- 这段自述**编译在产物里，可能滞后于最新代码**。只要能读到仓库，就以仓库里的文档和代码为准。
- **只有跑在 zuse 仓库里**（能看到 \`docs/superpowers/specs/\`）才能深答实现细节。作为发布包跑在别人项目里时，你只能答到架构级——这时要**如实说明「我手边没有自己的源码」**，绝不要编造实现细节。
- 回答自身机制时**带上文件路径**（例如 \`packages/server/src/cron/CronScheduler.ts\`），方便用户核对。
`

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  { name: 'zuse-config', description: ZUSE_CONFIG_DESCRIPTION, body: ZUSE_CONFIG_BODY },
  { name: 'zuse-readme', description: ZUSE_README_DESCRIPTION, body: ZUSE_README_BODY },
]
