# 内置 skill（zuse-config / zuse-readme）设计

> **日期**: 2026-07-26
> **性质**: 单个功能 spec
> **动机**: zuse 对自己不熟——被问"你的定时任务怎么做的""你是谁/能干啥"时会瞎猜，而不是去读自己的资料。
> **依赖**: Phase 14 Skills 系统（`packages/tools/src/skills.ts`）✓、M3 skill 管理面板 ✓

---

## 1. 目标

给 zuse 两个**内置**（写死在代码里、随包发布、任何 cwd 都在、零安装）的 skill：

| skill | 何时触发 | 作用 |
|---|---|---|
| **`zuse-config`** | 用户要**改 zuse 自身**：MCP、skill、cron、模型/权限设置、人设 | 告诉 agent 配置在哪、什么格式、**改完何时生效**（文件 / 重启 / 新会话 / 面板） |
| **`zuse-readme`** | 用户问 **"你是谁 / 你能干啥 / 你怎么搭的"** | 给稳定的身份+架构自述；在 zuse 仓库里时进一步指向 README 与 59 篇设计文档 |

用户要求原文：**"我需要全局的，而且我希望是自带的，写死的。因为一旦我想给别人用，这个用不着让对方再去装一遍。"** → 必须编译进产物，不能是仓库里的项目 skill、也不能要求用户往 `~/.zuse/skills/` 拷文件。

## 2. 现状（已核实）

- `scanSkills(home, cwd)`（`packages/tools/src/skills.ts:112`）建一个 `Map<name, SkillEntry>`：先扫 `~/.zuse/skills`，再沿 cwd 祖先链扫 `<dir>/.zuse/skills`，**内层同名整体覆盖**。
- `SkillEntry = { name, description, dir, body }`；`dir` 是技能目录绝对路径。
- `createSkillTool(skills)`：清单拼进工具 description；`run()` **调用时重读盘**（`join(skill.dir,'SKILL.md')`，读失败回退缓存 body）、展开 `${ZUSE_SKILL_DIR}`、输出前缀 `Base directory: <dir>`。
- `toolModule.enabled: (o) => (o.skills?.length ?? 0) > 0` —— 没有技能时不注册 Skill 工具。
- 调用点：`packages/tui/src/App.tsx:61`、`packages/server/src/session/createSession.ts:117`（过滤 `skills-disabled.json`）、`SkillService.list/update`。
- `SkillItem.source: 'user' | 'project'`（protocol:120），由 `resolve(s.dir).startsWith(userRoot)` 判定。
- **打包**：`packages/server/tsup.config.ts` 与 `packages/tui/tsup.config.ts` 都 `noExternal: [/^@zuse\//]`——`@zuse/tools` 整个内联进 dist。**故 TS 字符串常量随包走，零打包工作。**

## 3. 机制设计

### 3.1 `BUILTIN_SKILLS`（新文件 `packages/tools/src/builtin-skills.ts`）

镜像 R3 的 `BUILTIN_TOOL_MODULES` 模式：一个显式数组，每项是 `{ name, description, body }` 三个字符串常量（body 用模板字符串写死）。加内置 skill = 往数组加一项。

```ts
export interface BuiltinSkill { name: string; description: string; body: string }
export const BUILTIN_SKILLS: BuiltinSkill[] = [ /* zuse-config, zuse-readme */ ]
```

### 3.2 `SkillEntry` 加 `builtin` 标记

```ts
export interface SkillEntry {
  name: string
  description: string
  /** 技能目录绝对路径；内置技能没有磁盘目录，为 ''。 */
  dir: string
  body: string
  /** true = 编译进产物的内置技能（无磁盘文件：不可编辑、不重读盘、无 Base directory）。 */
  builtin?: true
}
```

### 3.3 `scanSkills` 先 seed 内置（最低优先级）

```ts
export function scanSkills(home: string, cwd: string): SkillEntry[] {
  const map = new Map<string, SkillEntry>()
  for (const s of BUILTIN_SKILLS) map.set(s.name, { ...s, dir: '', builtin: true })  // 最低优先级
  scanRoot(join(home, '.zuse', 'skills'), map)
  for (const dir of ancestorChain(cwd)) scanRoot(join(dir, '.zuse', 'skills'), map)
  return [...map.values()]
}
```

**同名覆盖**：用户/项目建一个同名 skill 即可**完全替换**内置版（逃生舱：内容过时或不想要时，不必改代码）。

**副作用（有意）**：`skills.length` 恒 ≥2 → Skill 工具**总是注册**。这正是"自带"的含义；且它 `readOnly:true`、清单只多两行 description，成本可忽略。

### 3.4 `createSkillTool.run()` 对内置分支

- **不重读盘**（没有文件；现有 try/catch 虽能兜住，但显式跳过更清楚、免一次必失败的 syscall）。
- **不展开 `${ZUSE_SKILL_DIR}`**、**不输出 `Base directory:` 前缀**（内置 body 里不会用该占位符；给一个不存在的目录会误导模型去 Read 它）。
- 仍走 `SKILL_BODY_CAP` 截断。

### 3.5 服务端/前端表面（M3 面板）

- `protocol.SkillItem.source` 扩为 `'user' | 'project' | 'builtin'`。
- `SkillService.list()`：`s.builtin ? 'builtin' : (resolve(s.dir).startsWith(userRoot) ? 'user' : 'project')`。
  —— **必须显式判 builtin**：内置 `dir:''` 经 `resolve('')` 会得到进程 cwd，会被误判成 `project`。
- `SkillService.update()`：内置 skill **拒绝 description/body 编辑**（无磁盘文件，`rewriteSkillFile` 会往错路径写）→ 抛错，路由回 400；**允许 `enabled` 开关**（`skills-disabled.json` 按名字存，内置同样适用 → 用户可关掉内置 skill）。
- Web `SkillsPanel`：`source==='builtin'` 时**隐藏编辑 ✎ 按钮**、徽章显示 `builtin`（沿用 `skill-src-{source}` 类名 + 一条样式），启停开关照常。

## 4. skill 内容设计

### 4.1 内容原则

1. **`zuse-config` 全内嵌**：配置位置/格式/生效语义是**稳定知识**，跟仓库文档无关 → 整段写死，别人装的包里一样好用，几乎不漂移。
2. **`zuse-readme` 薄内嵌 + 指针**：只写死**变化慢的身份与架构**；功能细节指向 `README.md` 和 `docs/superpowers/specs/`（**在 zuse 仓库里才有**）。
3. **诚实声明**（写进正文）：内置自述可能滞后；**仓库文档/源码才是权威**；不在仓库时只能答架构级。
4. **不抄功能清单进 skill**——59 篇 spec 持续增加，抄了必漂移；改为教 agent `ls docs/superpowers/specs/`（文件名带日期，本身就是功能索引）。

### 4.2 `zuse-config` —— description

> Use when the user wants to CHANGE zuse's own configuration — add/remove an MCP server, add or edit a skill, set up a cron/scheduled task, switch model or provider, adjust permissions, manage personas, or edit zuse's settings files. Tells you where each config lives, its format, and — critically — when a change actually takes effect (file edit vs daemon restart vs new session vs live web panel). Load this before editing anything under `~/.zuse/` or `.zuse/`.

### 4.3 `zuse-config` —— 正文（要点，实现时逐字写入）

- **总原则**：改前先读现文件；多数改动**不是立即生效**——先讲清生效时机再动手；不确定路径就 `ls ~/.zuse/`。
- **设置三层**（`.jsonc` 优先于 `.json`，jsonc 容忍注释/尾逗号）：
  | 层 | 路径 | 用途 |
  |---|---|---|
  | 用户 | `~/.zuse/settings.json` 或 `.jsonc` | 全局默认：providers、模型清单、contextWindow |
  | 项目 | `<项目根>/.zuse/settings.json[c]` | 随仓库走的项目设置 |
  | 本地 | `<项目根>/.zuse/settings.local.json[c]` | **优先级最高**、不进版本库：apiKey、model、permissions |
  常用键：`model` / `smallModel` / `imageModel` / `providers{}`（含 `apiKey`、`baseURL`、`models[]`、`contextWindow`、`protocol: anthropic|openai`、模型 `type: vision|ocr|...`）/ `permissions{defaultMode,allow,ask,deny}` / `mcpServers{}` / `webSearch`。
  **生效**：会话构建时读 → **新会话**生效（改 daemon 的要重启 daemon）。
- **MCP**：写 `settings.mcpServers.<name> = {command,args,env}` 或 `{url}`；**连接在 daemon 启动时建** → 改完**重启 daemon**，或用 Web「管理 → MCP」面板的 reconnect（**免重启、实时**）。面板增删走 surgical JSONC 写入、保留注释。
- **Skill**：用户级 `~/.zuse/skills/<名>/SKILL.md`、项目级 `<项目>/.zuse/skills/<名>/SKILL.md`（沿 cwd 向上收集，内层同名覆盖外层，**内置 skill 优先级最低、可被同名覆盖**）。frontmatter 只认 `name` 与 `description`（description 是模型判断"何时用"的唯一依据，要写足触发场景）；正文全文在调用时进上下文，`${ZUSE_SKILL_DIR}` 展开为技能目录。**生效**：启动扫一次 → **新会话**生效；正文改动模型下次加载即读到（调用时重读盘）。启停 = `~/.zuse/skills-disabled.json`（按名字），也可在 Web「管理 → 技能」面板切。内置 skill 只能启停、不能编辑。
- **Cron 定时任务**：数据在 `~/.zuse/cron/tasks.json` 与 `~/.zuse/cron/runs/<taskId>.jsonl`。**不要手改 tasks.json**——调度器把 croner 定时器持在内存里，手改文件不会重排（要重启 daemon 才读）。正确做法：Web 侧边栏「⏰ 定时任务」面板，或 REST `/api/cron`（`GET|POST /api/cron`、`PATCH|DELETE /api/cron/<id>`、`POST /api/cron/<id>/run` 立即执行、`GET /api/cron/<id>/runs`）——**改完立刻重排、立即生效**。任务字段：`name`、`cron`（标准 5 段 `分 时 日 月 周`）、`prompt`、`cwd`、`permissionMode`、`enabled`。每次触发开**全新会话**跑（不复用历史），执行留档可在面板回看。
- **人设 personas**：`~/.zuse/personas.json` 或 Web「管理 → 人设」面板；激活的人设作为一段 `## Persona:<name>` 叠加在只读核心 prompt 上；**新会话/重置**才生效。
- **常驻指令与记忆**：`~/.zuse/SYSTEM.md`（全局）、`ZUSE.md`（cwd 向上逐级收集，内层在后）、`~/.zuse/MEMORY.md`（记忆索引）；结构化记忆在 `~/.zuse/memory.db`（SQLite FTS5）——**用 Memory 工具或 Web「管理 → 记忆」面板改，别手写 db**。
- **其它数据目录**：`~/.zuse/web-sessions/`（Web 会话记录）、`~/.zuse/uploads/`（上传文件）、`~/.zuse/web-auth.json`（Web 登录口令哈希）。
- **生效时机速查表**（skill 的核心价值）：
  | 改动 | 何时生效 |
  |---|---|
  | 设置里的 model / permissions / providers | 新会话（daemon 侧需重启 daemon） |
  | mcpServers | 重启 daemon，或 MCP 面板 reconnect（实时） |
  | 新增/编辑 skill 正文 | 正文：下次加载即读；新增/启停：新会话 |
  | cron 任务 | 走面板/REST 立即生效；手改 tasks.json 需重启 |
  | 人设激活 | 新会话 |
  | ZUSE.md / SYSTEM.md | 新会话 |
- **收尾**：改完**明确告诉用户何时生效**，需要重启就直说。

### 4.4 `zuse-readme` —— description

> Use when the user asks about zuse ITSELF — who/what you are, what you can do, how you're built, your architecture or packages, or how one of your own features works internally ("how does your cron work", "how do you handle permissions"). Gives your identity and architecture, and — when running inside the zuse repo — points you at the authoritative design docs and source instead of guessing.

### 4.5 `zuse-readme` —— 正文（要点，实现时逐字写入）

- **身份**：你是 **zuse**，一个从零手写的 coding agent（TypeScript / Node 22+ / pnpm monorepo），两个界面：**TUI**（Ink 终端）与 **Web UI**（React SPA + 常驻 daemon）。定位：学习项目 + 日常自用，用 zuse 自己开发 zuse。
- **包结构**（变化慢）：
  | 包 | 职责 |
  |---|---|
  | `packages/core` | 引擎：agent loop、Conversation/账本、权限判定、provider 抽象、上下文压缩、检查点 —— **传输无关** |
  | `packages/tools` | 内置工具：Read/Write/Edit/Glob/Grep/Bash/WebFetch/WebSearch/Memory/TodoWrite/Agent/Skill/LSP/MCP |
  | `packages/protocol` | 纯类型的线缆契约（WS 消息 + REST DTO），前后端共享，无运行时 |
  | `packages/server` | 常驻 daemon：SessionManager（**传输无关的会话大脑**）、HTTP/WS、鉴权、资源 API、cron 调度 |
  | `packages/web` | React SPA：聊天流、管理面板、定时任务面板（只经 WS/HTTP 通信，不 import core） |
  | `packages/tui` | Ink 终端 UI（有自己的编排 hook，与 Web 各自独立） |
- **能力概览（粗线条，细节以仓库为准）**：agent loop + 完整工具集；多 provider（Anthropic/OpenAI 协议，运行时切模型）；三层配置 + 四档权限裁决；会话持久化/续接/搜索/压缩；检查点与 revert（影子 git）；项目记忆（SQLite FTS5）+ ZUSE.md；Skills；图片上传（直传/解析）；人设；MCP/LSP；定时任务；中断保留回合。
- **要答细节时的权威来源顺序**（**别猜，去读**）：
  1. `docs/superpowers/specs/` —— 逐功能设计文档。先 `ls` 它（文件名 `YYYY-MM-DD-<主题>-design.md` 就是带日期的功能索引），再挑相关的读；讲清机制、决策与取舍。
  2. `docs/superpowers/specs/2026-06-22-web-ui-roadmap.md`（Web UI 总纲）与 `2026-07-17-extensibility-refactor-roadmap.md`（可扩展性总纲）—— 看全局与依赖关系。
  3. `packages/<包>/src/` —— **代码是 ground truth**；文档与代码冲突以代码为准。
  4. `docs/superpowers/plans/` —— 任务级实现细节。
  5. 仓库根 `README.md` —— 面向用户的简介（偏 TUI 视角，Web 侧新功能未必跟进）。
- **诚实约束**（正文明写）：
  - 上面这份自述**编译在产物里，可能滞后于最新代码**；能读到仓库时以仓库为准。
  - **只有跑在 zuse 仓库里（`docs/superpowers/specs/` 存在）才能深答**；作为发布包跑在别人项目里时，只能答到架构级——这时要**如实说明**，不要编造实现细节。
  - 回答自身机制时**带上文件路径**（如 `packages/server/src/cron/CronScheduler.ts`），便于用户核对。

## 5. 测试

- **tools**：`scanSkills` 默认含两个内置且 `builtin:true`/`dir:''`；同名用户 skill **完全覆盖**内置（body 取用户的、`builtin` 不再为 true）；`createSkillTool` 加载内置返回 body 且**不含 `Base directory:` 前缀**、不因无文件而报错；无任何磁盘 skill 时 Skill 工具仍注册（`enabled` 为真）。
- **server**：`SkillService.list()` 把内置标成 `source:'builtin'`（**不是 project**）；`update(内置, {body})` 抛错（路由 400）；`update(内置, {enabled:false})` 成功并落进 `skills-disabled.json`；createSession 过滤禁用后内置确实不进 registry。
- **web**：`SkillsPanel` 对 `source:'builtin'` 不渲染编辑按钮、渲染 builtin 徽章、仍渲染启停开关。
- **Playwright**：管理 → 技能面板出现 `zuse-config` / `zuse-readme`，带 builtin 徽章、无 ✎、可切换启停。
- **真实效果验证**（本特性的意义所在）：在 Web 里问「你的定时任务是怎么实现的？」→ 模型应**先调 Skill(zuse-readme)**，再按指引 `ls docs/superpowers/specs/` / 读 `CronScheduler.ts` 作答，而不是瞎猜。

## 6. 非目标（YAGNI）

- 不把 `docs/` 或 README 打包进发布包（体积与维护成本 > 收益；发布包答架构级即可）。
- 不做内置 skill 的面板内编辑（无磁盘文件；要改就用同名 skill 覆盖）。
- 不做第三个"操作手册"类内置 skill（先看这两个够不够用）。
- 不动 skill 扫描的热加载语义（仍是启动扫一次）。

## 7. 已知取舍

- `zuse-readme` 的能力概览与包结构会随开发缓慢漂移 —— 已压到最粗，且正文明写"以仓库为准"；重构包结构时需顺手更新这一段。
- 内置 skill 令 Skill 工具恒注册，工具描述恒多两行 —— 视为"自带"的必要成本。
