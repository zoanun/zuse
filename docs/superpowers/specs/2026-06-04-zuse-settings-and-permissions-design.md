# Zuse 设置系统与权限模型设计（Phase 5）

- **日期**：2026-06-04
- **上游**：[phase-roadmap.md](../plans/phase-roadmap.md) Phase 5（已实现，roadmap 处留状态摘要 + 本链接）
- **状态**：设计待评审
- **范围**：Phase 5 —— 一个对齐 Claude Code 的 `settings.json` 配置系统，以及基于它的 CC 式权限模型（allow / ask / deny + defaultMode + 规则匹配器），含 `ask` 交互式批准流程。

---

## 1. 背景与动机

当前 zuse 的所有配置都挤在 `.env` 里（见 `packages/core/src/env.ts`）：API key、baseURL、model、max_tokens 混在一起。同时**完全没有权限系统**——Agent 循环（`packages/core/src/agent.ts` 的 `runOneTool`）拿到模型请求的工具就直接执行，对应故障模式⑥"任意工具可执行"。`tool.ts:41` 和 `useConversation.ts:39` 都留有"Phase 5 加 PermissionManager / abort 接线"的占位注释。

本设计引入一个分层的 `settings.json` 作为**非机密配置的统一入口**，并在其上构建权限模型。结构与字段名刻意对齐 Claude Code，便于迁移与复用习惯。

## 2. 目标与非目标

**目标**
- 三层 `settings.json`（用户 / 项目 / 本地），带优先级合并。
- CC 式 `permissions`：`allow` / `ask` / `deny` 规则数组 + `defaultMode`，配一个规则匹配器（Bash 命令前缀、文件路径 glob）。
- `ask` 交互式批准：Agent 循环可暂停、等用户决定后继续（方案 A：`canUseTool` 回调）。批准时区分"本会话总是允许"（内存覆盖层）与"总是允许并写盘"（落到 `settings.local.json`）两档。
- 工具暴露开关：配置决定哪些工具发给模型。
- 把 model / maxTokens / baseURL / apiKey 从 `.env` 迁入 settings；`.env` 文件取消。这四个都是 settings 的**根级字段**，对齐 Claude Code 的可配置项（url、key、model）。

**非目标（本期不做）**
- CC 的 `plan` 权限模式。
- 完整的 23 项 Bash 安全检查（可后续硬化；本期匹配器只做前缀 + `*` 通配）。
- 企业层 / 命令行层配置（只做三层）。
- hooks。

## 3. 三层配置

| 层 | 文件 | 进 git | 语义 |
|---|---|---|---|
| 用户层 | `~/.zuse/settings.json` | 否 | "我"在所有项目里的偏好 |
| 项目层 | `<repo>/.zuse/settings.json` | 是 | "这个仓库"对所有人的规矩（共享护栏、项目专属放行） |
| 本地层 | `<repo>/.zuse/settings.local.json` | 否（.gitignore） | "这个仓库 + 只有我这份 checkout"的私密/临时覆盖 |

**优先级（低 → 高）**：用户 < 项目 < 本地。

**加载代码**：三层 loader **全部实现**（含项目层）—— loader 始终会去找这三个文件并按优先级合并，项目层不是"以后再写的代码"。

**开发期约定**：当前阶段只**创建并使用**用户层和本地层两个**文件**；**项目层文件先不创建**（loader 找不到就贡献为空，零成本）。这样做的目的纯粹是**避免把真实 key 写进会提交的项目层文件、误传到 git**。等 zuse 要发布/共享时再创建项目层文件。
- 用户层 `~/.zuse/settings.json`：放个人偏好（如 model、个人放行习惯）。
- 本地层 `<repo>/.zuse/settings.local.json`：放 API key 与本仓库私密/临时覆盖。它被 gitignore，既安全又就在仓库目录里方便。

这两层文件的合并与优先级（本地覆盖用户）是本期测试的重点（见 §10）。

## 4. settings.json schema

```jsonc
{
  // —— 模型与请求（从 .env 迁出的配置）——
  // 这三个 + apiKey 都是根级字段，对齐 CC 的「可配 url / key / model」。
  "model": "qwen3-coder-plus",
  "maxTokens": 4096,
  "baseURL": "https://coding.dashscope.aliyuncs.com/apps/anthropic",

  // —— API key（secret）。独立根级字段，直观好校验。 ——
  // 只允许放在 gitignored 的本地层 / 用户层文件，绝不写进会提交的项目层。
  "apiKey": "sk-...",

  // —— 出站代理（可选）。配置后所有联网请求（大模型 API / WebFetch / WebSearch）都经此代理。——
  // 实现见 packages/core/src/proxy.ts 的 installProxy：在 bin 入口装 undici 全局 dispatcher。
  // 之所以需要：Node 自带 fetch 既不读系统代理也不读 HTTP_PROXY，只认 undici 全局 dispatcher。
  // 缺省（不填）= 直连。可被环境变量 ZUSE_PROXY 覆盖（同 apiKey 的 ZUSE_API_KEY 机制）。
  "proxy": "http://127.0.0.1:7890",

  // —— 工具暴露开关（两个字段都可选）——
  // enabled 存在 → 只暴露交集；disabled → 黑名单。都不填 → 全部暴露。
  "tools": {
    "enabled": ["Read", "Grep", "Glob", "LS", "Bash", "Edit", "Write"],
    "disabled": []
  },

  // —— 权限（对齐 CC）——
  "permissions": {
    "defaultMode": "default",   // default | acceptEdits | bypassPermissions
    "allow": ["Read(./**)", "Grep", "Glob", "LS", "Bash(git status)", "Bash(git diff *)"],
    "ask":   ["Bash(*)", "Write(./**)", "Edit(./**)"],
    "deny":  ["Read(./.env)", "Read(./**/.env)", "Bash(rm -rf *)"]
  }
}
```

字段名（`permissions.allow/ask/deny`、`defaultMode`、`model`）照搬 CC。url / key 在 CC 里走 `env` 块，这里按你的选择改成根级 `baseURL` / `apiKey` 两个独立字段。

### 4.1 secret 处理

- `.env` 文件**取消**，`env.ts` 中的 dotenv 加载逻辑删除。
- API key 用 settings 的**顶层 `apiKey` 字段**，只放在 gitignored 的本地层 / 用户层，绝不进项目层。
- `getClientConfig()` 重构为接收已解析的 `ResolvedSettings`，直接读 `apiKey` / `baseURL` / `model`；不再需要 DashScope/Anthropic 的环境变量分支判断。
- CI 覆盖：`process.env.ZUSE_API_KEY`（若设置）优先于 `settings.apiKey`，便于在不写文件的环境里注入 key。

## 5. 加载与合并（新文件 `packages/core/src/settings.ts`）

- 定位项目根：复用并从 `env.ts` 抽出 `findProjectRoot()`（找 `pnpm-workspace.yaml`）。
- 读取三个文件（缺失则跳过）。每个文件单独 `JSON.parse`；解析失败 → 抛错并指明是哪个文件。
- 合并规则：
  - 标量字段（`model` / `maxTokens` / `baseURL` / `permissions.defaultMode`）：**高层覆盖低层**。
  - `permissions.allow` / `ask` / `deny`：三个数组**跨层拼接**（累加规则）。
  - `tools`：高层覆盖（对象浅合并）。
  - `apiKey`：标量，高层覆盖；`process.env.ZUSE_API_KEY` 再覆盖在最上层。
  - `proxy`：标量，高层覆盖；`process.env.ZUSE_PROXY` 再覆盖在最上层（同 `apiKey`）。生效见 `installProxy`。
- 校验：未知顶层字段 → 警告（不致命）；类型不符 → 抛错。
- 产出带类型的 `ResolvedSettings`，导出供 TUI 与 agent 使用。
- **写回（settings writer）**：导出 `appendAllowRule(rule: string): void`（或等价 API），把一条 allow 规则追加进**本地层** `settings.local.json` 的 `permissions.allow` 数组并落盘（文件不存在则创建、目录不存在则建目录；已存在同规则则跳过去重）。只写本地层，绝不动用户层 / 项目层。供 `allow_persist` 调用。

## 6. 权限模型（新文件 `packages/core/src/permission.ts`）

### 6.1 规则文法

- `工具名` —— 匹配该工具的任意调用。
- `工具名(限定符)` —— 按工具类型解释限定符：
  - **Bash**：命令**前缀** + `*` 尾通配。`Bash(git diff *)` 匹配以 `git diff ` 开头的命令；`Bash(git status)` 精确匹配；`Bash(*)` 匹配任意。
  - **文件类工具**（Read / Write / Edit / Glob / Grep / LS）：对工具输入里的路径（解析为相对 `cwd`）做 glob。如 `Read(./src/**)`、`Read(./.env)`。

### 6.2 Tool 接口扩展（`packages/core/src/tool.ts`）

为让匹配器通用、不在 core 里硬编码各工具的输入形状，`Tool` 增加两个可选字段：

```ts
export interface Tool {
  name: string
  description: string
  inputSchema: JSONSchema
  run(input: unknown, ctx: ToolContext): Promise<ToolResult>
  /** 只读工具（Read/Glob/Grep/LS 为 true），供 defaultMode 分类。 */
  readOnly?: boolean
  /** 返回用于规则限定符匹配的字符串：Bash 返回命令，文件工具返回路径；无则 null。 */
  specifierFor?(input: unknown): string | null
}
```

`packages/tools/src/*` 各工具补上这两个字段。

### 6.3 判定算法

`decide(toolName, input, settings, cwd): { decision: 'allow' | 'deny' | 'ask', rule?: string }`

顺序：
1. 若工具被 `tools` 配置禁用 → `deny`（不只是隐藏，调用也兜底拦截）。
2. 命中任一 **deny** 规则 → `deny`（deny 永远最高优先）。
3. `defaultMode === 'bypassPermissions'` → `allow`。
4. 命中任一 **allow** 规则 → `allow`。
5. 命中任一 **ask** 规则 → `ask`。
6. 落到 `defaultMode`：
   - `default`：`readOnly` 工具 → `allow`；其余 → `ask`。
   - `acceptEdits`：`readOnly` + `Edit` / `Write` → `allow`；其余（如 Bash）→ `ask`。

## 7. Agent 循环集成（`packages/core/src/agent.ts`）

- `RunAgentOptions` 增加：
  - `settings: ResolvedSettings`
  - `canUseTool?: (req: PermissionRequest) => Promise<PermissionVerdict>`（方案 A），其中
    `type PermissionVerdict = 'allow' | 'deny' | 'allow_session' | 'allow_persist'`。
- 工具暴露：`registry.getDefinitions()` 改为 `registry.getDefinitions(settings.tools)`，被禁工具不发给模型。
- 执行每个工具前 `decide`：
  - `allow` → 照常 `runOneTool`。
  - `deny` → **不执行**，合成 `is_error` 的 `tool_result`（`Permission denied by settings (<rule>)`）回喂模型，并 yield 一个 `tool-result` 事件供 UI 显示。
  - `ask` → `await canUseTool(req)`：
    - 无 `canUseTool`（无头 / 测试）→ 默认 `deny`（安全优先）。
    - `allow` → 仅本次执行，不记规则。
    - `allow_session` → 执行，并在**会话内**的 settings 覆盖层追加一条对应 allow 规则（同名调用本会话不再追问；**不落盘**，重启即失效）。
    - `allow_persist` → 执行；除会话覆盖层外，**还把这条 allow 规则写入 `settings.local.json`**（持久，跨重启生效）。写盘走 §5 的 settings writer。
    - `deny` → 同上合成拒绝结果。
- 由 `req`（工具名 + 限定符）生成要追加的规则字符串：Bash 用精确命令 `Bash(<cmd>)`，文件工具用具体路径 `Tool(<path>)`。会话覆盖与写盘用同一条规则，保证"本会话"和"持久"语义一致。

## 8. 工具暴露开关（`packages/core/src/tool.ts`）

`ToolRegistry.getDefinitions(toolsConfig?)` 按 `enabled`（交集）与 `disabled`（黑名单）过滤。禁用工具既不发给模型，又在 `decide` 里兜底为 deny。

## 9. TUI 批准对话框

- 新组件 `packages/tui/src/components/PermissionDialog.tsx`：显示工具名 + 限定符（命令 / 路径），四个按键：
  - `[y]` 本次允许（`allow`）
  - `[a]` 本会话总是允许（`allow_session`，仅内存）
  - `[A]`（Shift+A）总是允许并写入 `settings.local.json`（`allow_persist`，持久）
  - `[n]` / `Esc` 拒绝（`deny`）
- `packages/tui/src/hooks/useConversation.ts`：
  - 新状态 `pendingPermission: { req, resolve } | null`。
  - 提供给 `runAgent` 的 `canUseTool` 返回 `new Promise(resolve => setPending({ req, resolve }))`。
  - 用户按键 → `resolve(verdict)`（四档之一）并清空 `pendingPermission`。
  - 等待期间渲染对话框、禁用 `InputBox`。
- `packages/tui/src/App.tsx`：pending 时在 `InputBox` 上方渲染对话框；启动时加载 settings 并传给 `useConversation`。
- 机制成立：循环 `await` 在 `canUseTool` 的 promise 上 → setState 触发渲染弹框 → 用户按键 resolve → 循环继续，与现有 `for await` 流式消费完全兼容。

## 10. 测试

- `settings.test.ts`：**重点覆盖用户层 + 本地层两层**的合并与优先级（本地覆盖用户、permission 数组跨层拼接）、坏 JSON 报错、缺文件、`apiKey` 解析与 `process.env.ZUSE_API_KEY` 覆盖。项目层 loader 代码已实现，但本期不专门构造/测试项目层文件。还测 `appendAllowRule` 写回：写进本地层、去重、文件/目录不存在时创建。
- `permission.test.ts`：规则解析、Bash 前缀匹配、文件路径 glob、`deny > allow > ask` 优先级、各 `defaultMode` 兜底、`bypassPermissions`。
- `agent.test.ts`（增补）：`deny` → 合成 error 结果且不执行、`ask` → 回调 allow/deny、`allow_session` 抑制本会话再问（不写盘）、`allow_persist` 抑制再问且触发写盘、禁用工具被拒、无 `canUseTool` 时 `ask` 默认 deny。
- TUI：hook 层测 `pendingPermission` 的 resolve 流程。

## 11. 文件改动清单

**新增**
- `packages/core/src/settings.ts`（+ `settings.test.ts`）—— loader、合并、`ResolvedSettings`，以及写回 `appendAllowRule`。
- `packages/core/src/permission.ts`（+ `permission.test.ts`）
- `packages/tui/src/components/PermissionDialog.tsx`
- `<repo>/.zuse/settings.local.json`（开发期配置 + key；gitignored）

**改动**
- `packages/core/src/tool.ts`：`Tool` 加 `readOnly?` / `specifierFor?`；`getDefinitions(toolsConfig?)` 过滤。
- `packages/core/src/agent.ts`：`RunAgentOptions` 加 `settings` / `canUseTool`；判定与暂停逻辑。
- `packages/core/src/types.ts`：新增 `ResolvedSettings`、`PermissionRule`、`PermissionDecision`、`PermissionRequest`、`PermissionVerdict`（`'allow' | 'deny' | 'allow_session' | 'allow_persist'`）等类型。
- `packages/core/src/env.ts`：删除 dotenv 文件加载；抽出 `findProjectRoot`；`getClientConfig` 改为基于 settings + `process.env`。
- `packages/core/src/index.ts`：导出新 API。
- `packages/tools/src/*`：各工具补 `readOnly` / `specifierFor`。
- `packages/tui/src/App.tsx`、`packages/tui/src/hooks/useConversation.ts`：加载 settings、接 `canUseTool`、渲染对话框。
- `.gitignore`：加入 `.zuse/settings.local.json`（以及历史遗留的 `.env`）。
- `.env` 文件删除；`.env.example` 由 `.zuse/settings.local.json` 示例替代。
- `docs/superpowers/plans/phase-roadmap.md` / `BACKLOG.md`：标注 settings.json 为 Phase 5 配置入口。

## 12. 延后项

- `plan` 权限模式。
- 完整 23 项 Bash 安全检查（命令解析、危险操作识别）——**作为 Phase 5 的第二步增量**后续补；本期仅前缀 + `*` 通配。
- 企业层 / 命令行层。
- hooks。
