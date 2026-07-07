# I4 — Web UI 输入框 UX 增强 设计

> **日期**: 2026-07-07
> **归属**: Web UI 程序（见 `2026-06-22-web-ui-roadmap.md` §4.4 交互增强），新增子项 **I4**
> **范围**: 纯前端（`packages/web`），不动 server / core / protocol
> **依赖**: F4（已落地）

---

## 1. 背景与目标

当前 web 输入框（`packages/web/src/components/Composer.tsx`）功能最小：

- 无输入历史，发过的消息翻不回来。
- 只有一个硬编码 slash 命令 `/compact`（`Shell.tsx` 的 `SLASH_COMMANDS`），且无自动完成菜单，用户不知道有哪些命令、要手打全名。
- thinking 时停止是一个文字按钮「停止」；发送按钮是一个字符 `↑`。

本 spec 把输入框补齐到"能用、可发现、顺手"：

1. **输入历史**：`↑/↓` 翻本会话发过的消息。
2. **`/` 命令菜单**：输入 `/` 弹出可过滤的命令列表，键盘/鼠标可选。
3. **Esc 停止 + 图标化**：`Esc` 停止当前回合；停止/发送按钮换成 SVG 图标，不再用文字/字符。

**非目标**：不做跨会话/持久化历史（本版内存态）；不做命令参数补全（命令均为无参动作）；不改 server 端命令处理。

---

## 2. 关键架构决策：命令模型统一

现有 `SLASH_COMMANDS: Record<string, ClientMessage>` 只能表达"发给服务器的 uplink"。要对齐 TUI，命令需要覆盖两类动作：发 uplink（如 `/compact`）**和**触发纯前端动作（开面板、建会话、聚焦搜索框）。因此把命令描述符统一为：

```ts
interface SlashCommand {
  name: string                    // 如 '/compact'
  desc: string                    // 菜单中显示的一句话说明
  run: (ctx: CommandContext) => void
}

interface CommandContext {
  send: (msg: ClientMessage) => void
  newSession: () => void
  openPanel: (panel: ManagePanel) => void   // 打开抽屉并切到该面板
  focusHistorySearch: () => void             // 打开侧栏并聚焦历史搜索框
  showHelp: () => void                       // 弹出命令清单 notice
  openDirPicker: () => void                  // 打开 S3 工作目录选择器
}
```

- 命令表集中在一处（延续现有 table-driven 注释的意图）；加命令 = 加一条 + 在需要时给 `ctx` 补一个能力方法。
- `Shell` 组装 `ctx`（它已持有 `send / newSession`，并已管理 `activePanel / drawerOpen`；`focusHistorySearch / openDirPicker` 复用其既有 state setter），传给 Composer 的命令层。

### 命令集（web 原生映射）

| 命令 | 动作 | 类型 |
|---|---|---|
| `/compact` | `send({ type: 'compact' })` | server |
| `/clear` | `newSession()`（web 里"清空上下文"= 新会话）| 前端 |
| `/help` | `showHelp()` — 列出全部命令（notice）| 前端 |
| `/memory` | `openPanel('memory')` | 前端 |
| `/prompts` | `openPanel('prompts')` | 前端 |
| `/skills` | `openPanel('skills')` | 前端 |
| `/mcp` | `openPanel('mcp')` | 前端 |
| `/usage` | `openPanel('usage')` | 前端 |
| `/files` | `openPanel('files')` | 前端 |
| `/history` | `focusHistorySearch()` | 前端 |
| `/work` | `openDirPicker()` | 前端 |

**不收**：`/tools`（web 无工具面板）、`/revert`（web 用 per-message 图标）、`/save`（web 用 share 选择流）——无干净落点，收进来只会是死命令。

---

## 3. 组件设计

### 3.1 输入历史（每会话 + 内存态）

- **存储**：`Shell` 持有 `historyBySession: Map<string, string[]>`（`useRef` 或 state，内存态，刷新即清）。`onSend` 里，在成功派发用户消息后把 `text` 追加到当前会话的数组（slash 命令**不**入历史）。
- **传参**：`Shell` 把当前会话的历史数组 `history: string[]` 传给 `Composer`。
- **游标**：`Composer` 内部维护 `histIndex`（`null` = 未在浏览历史 / 停在当前草稿）。进入历史时先把当前草稿暂存，翻到比最新更后一格时恢复草稿。
- **触发条件**（shell 惯例）：
  - `value` 无换行（单行）：`↑` = 上一条（更旧），`↓` = 下一条（更新）。
  - 多行：仅当光标在**首行**按 `↑`、在**末行**按 `↓` 才翻历史；否则放行让光标正常移动。
  - 命令菜单打开时 `↑/↓` 归菜单（见 3.2），不翻历史。
- **编辑后失效**：一旦用户在某条历史项上再输入（`onChange`），`histIndex` 归位为草稿态，避免"改了一半又被上翻覆盖"。

### 3.2 `/` 命令菜单（自动完成弹层）

- **触发**：`value` 以 `/` 开头时显示浮层，浮在 composer 上方（复用现有 `.composer-wrap` 上方定位，类似 queued-steer 预览的定位约定）。
- **过滤**：按 `/` 后已输入前缀实时过滤命令 `name`（大小写不敏感，前缀匹配）。无匹配则不显示浮层。
- **键盘**：`↑/↓` 移动高亮项（循环）；`Enter` 或 `Tab` 执行高亮项的 `run(ctx)` 并清空输入；`Esc` 关菜单（不清输入）。
- **鼠标**：点击项执行。
- **执行后**：清空输入框、关闭菜单、复位高亮。

### 3.3 按钮图标化

- **发送按钮**：移除字符 `↑`，改为内联 SVG 的回车/换行拐角箭头（`↵` 形，即从上向下再向左的折线箭头）。空输入（`value.trim() === ''`）时 `disabled`、变灰；hover/active 轻微反馈；填充 accent 色。保留 `aria-label="发送消息"`。
- **停止按钮**：thinking 时仍显示，但从文字「停止」改为内联 SVG 停止图标（实心方/圆停止符）。保留 `aria-label="停止"`，沿用 `.ghost` 视觉基调（或新增专用类）。

### 3.4 键盘事件优先级（Composer `onKeyDown` 单一裁决顺序）

自上而下，命中即 return：

1. **IME 组字中**（`e.nativeEvent.isComposing`）→ 完全放行，不拦截任何键。
2. **命令菜单开**：`ArrowUp/ArrowDown` → 移动高亮（`preventDefault`）；`Enter`/`Tab` → 执行高亮项；`Escape` → 关菜单。
3. **命令菜单关**：
   - `Enter` 且非 `shiftKey` → 发送（现有逻辑）。
   - `ArrowUp/ArrowDown` 且满足 3.1 触发条件 → 翻历史（`preventDefault`）。
   - `Escape` → 若 `thinking` 则 `onStop()`，否则不处理。

---

## 4. 数据流

```
用户输入
  ├─ 以 '/' 开头 → 命令菜单过滤显示 → 选中 → run(ctx)
  │                                        ├─ server 命令: ctx.send(uplink)
  │                                        └─ 前端命令: newSession / openPanel / focusHistorySearch / ...
  ├─ Enter 发送 → onSend(text) → Shell: 入 historyBySession[当前会话] + 原有派发
  ├─ ↑/↓ (菜单关, 满足条件) → 在 history 数组里移动 histIndex → 回填 value
  └─ Esc → 菜单开则关菜单; 否则 thinking 则 onStop()
```

`Composer` 新增 props：`history: string[]`、`commands: SlashCommand[]`、`ctx: CommandContext`（或把 `run` 收敛为单个 `onRunCommand(cmd)` 回调，由 Shell 持 ctx 执行——实现时择一，接口对 Composer 而言只需"给我命令列表 + 一个执行入口"）。

---

## 5. 边界与错误处理

- **空历史**：`↑` 无反应（不报错）。
- **命令前缀无匹配**：不显示浮层；此时 `↑/↓` 不被菜单拦截，回落到历史逻辑（但 value 以 `/` 开头且是单行，会翻历史——可接受，或按"以 `/` 开头即视为命令输入态、不翻历史"处理，实现时取后者更不易混淆）。
- **IME**：所有拦截前先判 `isComposing`，中文/日文组字期间不误触发送、翻历史或命令选中。
- **slash 命令不入历史**：避免 `/clear` 之类污染历史回溯。

---

## 6. 测试（vitest + @testing-library/react，沿用 `Composer.test.tsx`）

1. 发送后消息进入历史；`↑` 回填最近一条，连按继续上翻；`↓` 回到草稿。
2. 多行文本：光标非首行按 `↑` 不翻历史（光标移动）；首行按 `↑` 翻历史。
3. 编辑历史项后 `↑` 从最新开始（游标已复位）。
4. 输入 `/` 弹菜单；输入 `/co` 只剩 `/compact`；`Enter` 执行并清空。
5. 菜单开时 `↑/↓` 移动高亮而非翻历史；`Esc` 关菜单不清输入。
6. 菜单关 + thinking 时 `Esc` 触发 `onStop`；非 thinking 时 `Esc` 无副作用。
7. 空输入时发送按钮 `disabled`。
8. IME 组字中的 `Enter` 不发送。
9. slash 命令不写入历史。

---

## 7. 涉及文件

- `packages/web/src/components/Composer.tsx` — 主体改造（历史游标、命令菜单、键盘裁决、按钮图标）。
- `packages/web/src/components/Shell.tsx` — 命令表升级为 `SlashCommand[]`、组装 `CommandContext`、`historyBySession` 管理、`onSend` 入历史。
- `packages/web/src/styles.css` — 命令菜单浮层样式、发送/停止按钮图标态（禁用/hover/active）。
- `packages/web/src/components/Composer.test.tsx` — 补测试。
- 可能新增：`packages/web/src/components/commands.ts`（命令表 + 类型），把命令定义从 Shell 抽出，保持 Shell 精简。
- 图标：内联 SVG（发送=回车拐角箭头，停止=停止符），无外部资源。

---

## 8. 非目标（重申）

- 不做持久化/跨会话历史（内存态足够；将来换 localStorage 只是换存储层，不影响本设计接口）。
- 不做命令参数/子命令补全。
- 不改 server 端命令处理与 protocol。
