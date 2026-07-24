# C1/C2 定时任务（cron 调度 + 管理面板）设计

> **日期**: 2026-07-24
> **性质**: 单个功能 spec（Web UI 路线图 §4.6 C1+C2 的详细设计）
> **依赖**: F2（SessionManager）✓、F3（协议+WS）✓、F4（React 前端）✓、S1/S2（会话持久化+侧边栏）✓
> **范围**: C1（后端 cron 调度引擎）+ C2（前端管理面板）。**B2（ScheduleWakeup 模型自我唤醒）本版不做，只留接缝。**

---

## 1. 目标与动机

给 zuse 加"定时任务":用户配一条 cron 规则 + 一段执行内容（prompt），到点后 daemon 自动开一个**全新会话**跑一轮 agent，把每次执行**留档**，并在前端面板里管理任务、回看历次执行的完整过程。

对齐路线图 §4.6：C1 = "常驻调度器，定时驱动 SessionManager 发起回合"；C2 = "增删改查 cron 任务、查看执行历史"。遵 §5.5 驱动源中立：cron 与 WS 平级，只调 SessionManager API，不把传输概念泄漏进去。

## 2. 关键决策（brainstorm 已定）

| 决策 | 结论 | 依据 |
|---|---|---|
| **会话模型** | 每次触发开**全新一次性会话**跑，跑完留档；不复用、不续上一次 | 用户选定 |
| **执行留档** | 每次执行记一条 `CronRun`；那次会话按普通 session 持久化但打 `kind:'cron'` 标记，`CronRun.sessionId` 指向它，钻取回看复用现有快照/消息渲染 | 复用最大化 |
| **cron 会话可见性** | **不进普通会话侧边栏**（按 `kind:'cron'` 从 `list()` 过滤），只在定时任务的执行列表里看 | 用户确认 |
| **调度格式** | 标准 5 段 cron 表达式（`分 时 日 月 周`，完整 crontab 语义含 day-of-month）；面板给友好预设生成表达式 + 高级用户可直填 | 用户选"cron 表达式引擎+面板预设"，并要求支持"每月第几天" |
| **调度引擎** | `croner`（零依赖，解析+调度+防重叠+时区一把梭） | 见 §7 选型 |
| **重叠触发** | 同任务上次没跑完就跳过本次（croner `protect:true`） | 避免堆叠并发会话 |
| **漏触发** | daemon 宕机期间错过的**不重放**（croner 从"现在"排下次） | 避免重启涌一堆陈旧运行 |
| **时区** | 本机系统时区（**不传** croner 的 timezone 选项即默认本机） | 单用户本机 |
| **权限（无人看管）** | 每任务带 `permissionMode`（复用 zuse 现有三档），cron 会话 `interactive:false`；**默认 `bypassPermissions`**（全自主，除全局 deny 表外全放行）；全局 `deny` 表在任何档位恒拦作硬底线 | 见 §5，用户选定默认全自主 |
| **B2 ScheduleWakeup** | 本版不做，引擎做成通用原语留接缝 | 用户选定 |

**v1 有意从简（YAGNI）**：模型用默认（不做每任务选模型/人设）、不做嵌套/依赖任务、不做失败重试、不做执行完通知推送、不做 cron 会话磁盘清理/TTL（都留后续 follow-up）。

## 3. 架构总览

```
                        daemon 启动
                            │
                 ┌──────────▼───────────┐
                 │     CronScheduler     │  C1：常驻调度器（croner）
                 │  每 enabled 任务 1 个  │
                 │  Cron 实例 + protect   │
                 └──────────┬───────────┘
              到点 fire()    │  只调 SessionManager API（驱动源中立 §5.5）
                            ▼
         建全新 cron 会话（interactive:false, kind:'cron', cwd, defaultMode）
                            │  submit(task.prompt)
                            ▼
                 turn-end → 记 CronRun(success + 摘要)
                 error    → 记 CronRun(failed + error)
                            │
        ┌───────────────────┴────────────────────┐
        ▼                                         ▼
   CronStore（持久化）                      SessionService（复用）
   ~/.zuse/cron/tasks.json                 会话快照/消息/持久化/autosave
   ~/.zuse/cron/runs/<taskId>.jsonl

   ── REST /api/cron ──►  CronService  ──►  前端 CronPanel（C2）
```

**新增文件**：
- `packages/protocol/src/index.ts`（增）：`CronTask` / `CronRun` / `CronRunStatus` DTO + REST 载荷类型。
- `packages/server/src/cron/cronStore.ts`：持久化——tasks.json（原子读写）+ 每任务 runs jsonl（append/读，坏行跳过）。
- `packages/server/src/cron/CronScheduler.ts`：croner 引擎——调度 enabled 任务、fire→建 cron 会话→submit→记 run、CRUD 重排、防重叠、本机时区、漏触发不补。
- `packages/server/src/cron/CronService.ts`：REST 面向服务——任务 CRUD、列 runs、取某 run（→会话快照）；镜像 `SessionService`/`McpService` 模式。
- `packages/web/src/components/CronPanel.tsx`（+ 子视图 `CronTasksView` / `CronTaskForm` / `CronRunsView` / `CronRunDetail`）：面板。
- `packages/web/src/state/cronApi.ts`（或并入 manageApi）：cron API 客户端函数。

**修改文件**：
- `packages/server/src/session/createSession.ts`：`CreateSessionOptions` 增可选 `permissionPolicy` 覆盖（默认仍 `{interactive:true, config:settings.permissions}`）+ 可选 `kind`。
- `packages/server/src/session/sessionStore.ts`：`SessionRecord` 增 `kind?: 'cron'`。
- `packages/server/src/session/SessionService.ts`：`list()` 过滤掉 `kind:'cron'`；`create()`/持久化透传 kind。
- `packages/server/src/http/*`（REST 路由所在）：挂 `/api/cron`。
- `packages/server/src/*`（daemon 启动，startServer/bin）：实例化并启动 `CronScheduler`，`close()` 时停掉所有 Cron。
- `packages/web/src/components/Shell.tsx` + 状态：主区视图模式 `mainView: 'chat' | 'cron'`，侧边栏"新会话"下方加"⏰ 定时任务"入口切换。
- `packages/web/src/components/Sidebar.tsx`：加 cron 入口。

## 4. 数据模型

### 4.1 `CronTask`（持久化于 `~/.zuse/cron/tasks.json`）

> `CronPermissionMode` 是 core `PermissionMode`（`types.ts:98`）的镜像。protocol 是 type-only、web 安全包，不能 value-import core，故在此以同名字符串联合复述（与 F3 对 core 类型的处理一致）。

```ts
export type CronPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions'

export interface CronTask {
  id: string                       // 时间可排序 id（复用 sessionStore 的 genId 风格）
  name: string                     // 显示名
  cron: string                     // 标准 5 段 cron 表达式（croner 解析）
  prompt: string                   // 执行内容：到点注入全新会话的用户消息
  cwd: string                      // 工作目录（该次会话的 root）
  permissionMode: CronPermissionMode  // 默认 'bypassPermissions'
  enabled: boolean                 // 启用/暂停
  createdAt: string                // ISO
  updatedAt: string                // ISO
}
```

`GET /api/cron` 返回的任务额外带一个**计算字段** `nextRun?: string`（croner `nextRun()`，ISO，非持久化）供面板显示"下次执行"。

### 4.2 `CronRun`（每任务 append 于 `~/.zuse/cron/runs/<taskId>.jsonl`）

```ts
export type CronRunStatus = 'running' | 'success' | 'failed'

export interface CronRun {
  id: string                       // 时间可排序 id
  taskId: string
  startedAt: string                // ISO
  finishedAt?: string              // ISO（结束时写）
  status: CronRunStatus
  sessionId: string                // 那次全新会话 id（钻取回看）
  summary?: string                 // 结果摘要（末条助手文本截断），列表 label 用
  error?: string                   // 失败原因
}
```

> **为何 jsonl**：每次执行一行 append，天然按时间追加、崩溃不毁旧记录、无需读改写整文件。读取时逐行 parse、坏行跳过（镜像 sessionStore 的坏文件跳过）。

### 4.3 cron 会话的持久化

cron 会话是**普通 session**，走现有 `SessionService` 持久化（`~/.zuse/web-sessions/<id>.json`），只多打一个 `kind: 'cron'` 标记：
- `SessionRecord.kind?: 'cron'`（缺省=普通会话）。
- `SessionService.list()`（侧边栏数据源）**过滤掉** `kind:'cron'`，故 cron 会话不刷屏。
- 钻取某次执行 = 按 `CronRun.sessionId` 走现有会话快照路径渲染（复用 Message/MessageList，零新渲染代码）。

## 5. 权限（无人看管的核心问题）

**背景**：cron 会话无人看管，权限 "ask" 不能卡死、也不该盲目放行。调研四个参考实现（cc-haha / hermes / openclaw / opencode，详见 brainstorm 记录）得共识：①绝不卡死，无人看管的 ask 必须确定性落地；②默认倾向 fail-closed 或用户显式授权；③无论如何都要有 deny 硬底线；④做成可配、给每任务逃生舱。

**zuse 已具备全部机器**（`SessionManager.canUseTool`，非交互分支）：
```
if (!this.policy.interactive) {
  const { decision } = decide(tool, req.specifier, settings, [], this.cwd)
  return decision === 'allow' ? 'allow' : 'deny'   // 立即返回，绝不卡死；ask→deny
}
```
core 的 `decide()` 判定顺序为 **禁用 → deny → bypass → allow → ask → defaultMode 兜底**，故 `deny` 表恒在 `bypass` 之前生效 = 硬底线。

**设计**：每个 `CronTask` 带 `permissionMode`，cron 会话按
`{ interactive: false, config: { ...settings.permissions, defaultMode: task.permissionMode } }`
创建（经 §3 的 createSession `permissionPolicy` 覆盖）。三档：

| 档位 | 行为 | 对标 |
|---|---|---|
| `default` | fail-closed：ask→拒，只跑 allow 表+只读工具；deny 表恒拦 | openclaw/opencode/cc-haha 后台默认 |
| `acceptEdits` | 额外自动放行本任务 cwd 内文件编辑，bash 仍 ask→拒 | CC acceptEdits |
| `bypassPermissions`（**默认**） | 除全局 deny 表外全放行（真自主） | cc-haha cron / hermes approve |

- **默认 `bypassPermissions`**（用户选定）：单用户本机、每任务用户亲手写，视为可信自主；全局 `DEFAULT_DENY_RULES` + 用户 deny 规则仍恒拦作硬底线。
- 面板表单把该档位显式列出，`bypassPermissions` 档带警示文案（无人看管下 prompt 写错可能 rm/推代码）。
- **无需任何新权限机器**——纯复用 `interactive:false` + `defaultMode`。

## 6. C1：CronScheduler（后端引擎）

### 6.1 生命周期
- **daemon 启动**：读 `tasks.json`，对每个 `enabled` 任务 `schedule(task)`。
- **`schedule(task)`**：`new Cron(task.cron, { protect: true }, () => this.fire(task.id))`（不传 timezone → 用本机时区），存进 `Map<taskId, Cron>`。croner 从"现在"排下次触发（漏触发不补）。
- **CRUD**：`add/update` → 先停旧 `Cron`（`.stop()`）再按新表达式建；`remove` → 停并删；`enabled:false` → 停且不建。
- **`close()`**（daemon 关停）：停掉所有 `Cron` 实例。

### 6.2 `fire(taskId)`（到点回调）
1. 读最新 task（可能已被改/禁用——禁用则跳过）。
2. 生成新 sessionId；写 `CronRun{ status:'running', startedAt, sessionId }` append 到该任务 jsonl。
3. 建 cron 会话（`createSession` + 经 SessionService 走持久化/autosave 接线），`permissionPolicy` 非交互 + task.permissionMode，`cwd: task.cwd`，`kind:'cron'`，`registerExtraTools`（复用 daemon 的 MCP/LSP 接缝）。
4. `await sessionManager.submit(task.prompt)`。
5. 回合正常结束 → 更新该 run 为 `status:'success'`, `finishedAt`, `summary`（末条助手文本截断到 ~200 字）。
6. 抛错/回合 error → `status:'failed'`, `finishedAt`, `error`。
7. `protect:true` 保证同任务上次 `fire` 未 resolve 时本次被 croner 静默跳过（不堆叠并发）。

### 6.3 驱动源中立（§5.5）
CronScheduler 只依赖 SessionManager/会话创建 API + CronStore，**不 import 任何 HTTP/WS**。它是与 WS 平级的驱动源。

### 6.4 B2 接缝（本版不实现，仅设计到位）
`fire()` 的"到点→注入消息→发起回合"就是通用原语。将来 B2（ScheduleWakeup）接入时，走同一 croner 原语做**一次性**定时（croner 支持 `new Cron(date, ...)` 一次触发），但注入目标是**当前 live 会话**（模型自我唤醒续自己的活），与 C1 的"全新会话"分支并列。本版不写该分支，但引擎结构（一个统一的 schedule/fire 原语）为它留好位置。

## 7. 引擎选型：croner（新依赖）

`croner`（`/hexagon/croner`，零依赖，High 声誉）：
- 解析标准 5/6 段 cron（含 day-of-month）；`nextRun()` 算下次时间。
- `protect: true` 原生防重叠运行（正是 §6.2 步骤7 所需）。
- `timezone` 选项（默认本机）；`paused` 态；`.stop()`。
- 还支持一次性定点 `new Cron(date, ...)`（B2 将来用）。
- Node/Deno/Bun/浏览器 + TS 友好。

加入 `packages/server` 的 deps。构建时经 tsup bundle 进 dist（零依赖，干净）。

**备选**（不选）：`cron-parser`（只解析，要自己写定时器/防重叠/时区）；`node-cron`（无内置防重叠、TS 弱、依赖多）。

## 8. C2：资源 API（`/api/cron`，遵 §5.1 约定）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/cron` | 列所有任务（每条含计算字段 `nextRun`） |
| POST | `/api/cron` | 建任务（校验 cron 表达式——croner 构造抛错则 400；prompt/name 非空；cwd 默认 daemon 默认 cwd） |
| PATCH | `/api/cron/<id>` | 改任务（name/cron/prompt/cwd/permissionMode/enabled）→ 触发 scheduler 重排 |
| DELETE | `/api/cron/<id>` | 删任务 + 清其 runs（jsonl 文件）+ 停 Cron |
| GET | `/api/cron/<id>/runs` | 该任务历次执行（jsonl 读，按时间倒序） |
| POST | `/api/cron/<id>/run` | **立即手动跑一次**（复用 `fire()`）——既是 UX（"立即执行"按钮）也是 E2E 测试触发钩子 |
| GET | `/api/cron/runs/<runId>` | 取某次执行详情：返回其会话快照（钻取回看，复用会话快照投影） |

- 全部经**鉴权门禁**（§5.1，与 `/api/sessions`、`/api/mcp` 同）。
- 畸形 id → try/catch → 400（镜像 S2/M4）。
- `POST /api/cron/<id>/run` 提升为 v1 功能：既满足"手动立即跑"UX，又让 Playwright 无需等真实 cron 时钟即可端到端验证。

## 9. C2：前端面板

### 9.1 主区视图模式
新增顶层视图状态 `mainView: 'chat' | 'cron'`（store）。侧边栏"新会话"按钮**下方**加入口"⏰ 定时任务"：点击 → `mainView='cron'`，中间聊天区替换为 `CronPanel`；点其它会话/新会话 → 回 `mainView='chat'`。

> 注：与 memory/persona/mcp 的右侧 `ManageDrawer` 不同——用户明确要"中间聊天窗口改成定时任务列表",故 cron 是**主区视图切换**而非抽屉。

### 9.2 视图层级
```
CronPanel (mainView==='cron')
├─ CronTasksView         所有任务列表：名称 / 人读调度 / 下次执行 / 启停开关 / 编辑 / 删除 / 立即执行 / [+ 新建]
│    └─ CronTaskForm     新建/编辑：名称、执行内容(prompt)、调度(预设+裸cron)、cwd(DirPicker 复用)、permissionMode、enabled
└─ 点某任务 → CronRunsView    历次执行：每行 label = 执行内容摘要 + 结果摘要；状态图标（进行中转圈 / ✓成功 / ✕失败）
       └─ 点某次执行 → CronRunDetail   复用 Message/MessageList 渲染那次会话快照（完整运行过程）
```

### 9.3 调度预设 → cron 表达式
`CronTaskForm` 提供预设，本地编译成 5 段表达式（也可切"自定义"直填裸 cron）：
- 每小时（`0 * * * *`）
- 每天 HH:MM（`M H * * *`）
- 每周 <周几> HH:MM（`M H * * D`）
- 每月 <第几天> HH:MM（`M H D * *`）——用户点名要的 day-of-month
- 自定义：直填裸 cron，前端可选做基本形状校验，权威校验在后端（croner）

面板把存储的表达式**反显为人读描述**（简单映射；无法映射的原样显示表达式）。

### 9.4 状态图标
- `running` → 转圈/脉冲；`success` → ✓（绿）；`failed` → ✕（红）。对齐用户描述的"进行中 / 已结束、成功 / 失败"。

### 9.5 API 客户端
`cronApi.ts` 复用现有 `request()`（同 session.ts/manageApi.ts）：`listTasks / createTask / updateTask / deleteTask / listRuns / runNow / getRun`。

## 10. 分期（供 writing-plans 展开）

1. **协议 + CronStore**：protocol DTO；`cronStore.ts`（tasks.json 原子读写 + runs jsonl append/读 + 坏行跳过）；单测。
2. **会话接缝**：`createSession` 加 `permissionPolicy`/`kind` opts；`SessionRecord.kind`；`SessionService.list()` 过滤 cron；单测。
3. **CronScheduler**：croner 引擎 + `schedule`/`fire`/CRUD 重排/`close`；`fire()` 建 cron 会话→submit→记 run（成功/失败/摘要）；防重叠。**headless 单测**：直接调 `fire()`（不等真实时钟）验证建会话+记 run+成败；禁用任务不调度；CRUD 重排。
4. **CronService + REST**：`/api/cron` 全部端点 + 鉴权门禁 + 畸形 id 400 + cron 表达式校验 400；单测。
5. **前端面板**：`mainView` 切换 + 侧边栏入口；`CronTasksView`/`CronTaskForm`（预设编译）/`CronRunsView`/`CronRunDetail`；`cronApi`；样式；web 单测。
6. **/ship**：typecheck（protocol/server/web——本设计不改 core，权限纯复用现有 core）+ 单测 + Playwright（经"立即执行"建任务→跑→执行列表出现→钻取看过程）。

## 11. 测试策略

- **cronStore**：tasks round-trip、runs append+读倒序、坏行跳过、原子写。
- **CronScheduler**：不依赖真实时钟——直接调 `fire(taskId)` 断言（建 cron 会话、submit prompt、记 running→success/failed、摘要取末条助手文本）；`protect` 重叠跳过（第二次 fire 在第一次未结束时被拒）；`enabled:false` 不 schedule；`update` 后旧 Cron 停、新表达式生效（可断言 `nextRun()`）。croner 本身的解析/时钟不重测。
- **CronService/REST**：CRUD、runs、runNow、getRun→快照；无效 cron→400；畸形 id→400；鉴权。
- **web**：CronTasksView 列表渲染、CronTaskForm 预设→表达式编译正确、CronRunsView 状态图标、CronRunDetail 复用消息渲染。
- **Playwright**（web 改动，密码 zuonaok）：新建任务（permissionMode 默认档）→点"立即执行"→执行列表出现一条→状态转 success→点进去看到完整对话；cron 会话不出现在普通会话侧边栏。
- **CLAUDE.md 测试环境**：server 无 test 脚本用根 vitest；web 测试在包内跑；`SessionService.test` 并行 flaky 失败则隔离重跑取证。

## 12. 非目标 / YAGNI（本版明确不做）

- B2 ScheduleWakeup（留接缝，下一个小 spec）。
- 每任务选模型/人设（用默认）。
- 嵌套/依赖任务、失败重试、执行完通知推送（Telegram/邮件）。
- cron 会话磁盘清理 / TTL（会累积在 web-sessions，但已从视图过滤；清理留 follow-up）。
- 分布式/多机调度（单 daemon）。
- 多用户（全程单用户，承 §6 非目标）。

## 13. 已知 follow-up（记录，不在本版）

- cron 会话累积清理策略（保留最近 N 次 / TTL）。
- B2 ScheduleWakeup 接入（复用 §6.4 接缝）。
- 执行失败/成功的对外通知（依赖 G 频道接入）。
- 每任务模型/人设选择。
