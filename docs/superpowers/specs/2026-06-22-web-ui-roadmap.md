# Zuse Web UI 路线图总纲

> **日期**: 2026-06-22
> **性质**: 程序级分解文档（Program decomposition），不是单个 spec
> **作用**: 列全 Web UI 这一整个程序的所有细粒度 spec、依赖关系、跨切面扩展点约定，作为后续每个 spec 各自详细设计的组织总纲。

---

## 1. 背景与目标

Zuse 当前只有 TUI（`packages/tui`）。需要新增一个 **Web UI**，要求：

- **与 TUI 解耦**：TUI 做 TUI，Web 做 Web，互不依赖，各自直接建在 `packages/core` 上。
- **本机为主，可远程访问**：跑 `zuse --web`（或独立 `zuse-server`）在本机起常驻服务，浏览器开 localhost；也能从另一台设备（手机/平板）经网络 + token 鉴权连入。单用户。
- **后端常驻持有会话**：服务器是会话的主人，agent 回合在后端跑，关浏览器/锁屏不中断，重连能看到期间进展，多设备可同时看同一会话。
- **Web 专属能力**：富媒体展示、多会话/多项目管理、可视化面板、交互增强，以及一大批管理功能（memory、system prompt 多套切换、skill、MCP、usage、检查点、文件树）、图片上传、语音交互、定时任务管理、外部频道接入（飞书/Telegram）。

## 2. 核心原则：解耦与传输无关

```
                      packages/core   ← 纯引擎库（agent 循环 / 工具 / 模型客户端 /
                     /       |      \    压缩 / MCP / 记忆 / 检查点），框架无关
                    /        |       \
          packages/tui   packages/server   packages/web
          (完全不动)      (常驻后端 daemon)  (React 前端)
                              |
                  ┌───────────┴───────────────┐
                  │   SessionManager (传输无关) │   ← F2：整个程序的大脑
                  └───────────┬───────────────┘
            ┌───────┬─────────┼─────────┬──────────┐
          WS 前端  Telegram   飞书      Cron 触发   (未来更多驱动源)
          (Web UI) 适配器     适配器
```

两条不可动摇的边界：

1. **`packages/core` 是引擎，不是 TUI。** TUI 和 Web 都是它的消费者，二者**互不依赖**。复用 core 是引用库，不构成耦合；复用 TUI 内部代码才是耦合，禁止。
2. **`SessionManager`（F2）必须传输无关。** WS、Telegram、飞书、Cron 都只是"驱动源"，平级地调同一套 SessionManager API。任何把 WS / HTTP 概念泄漏进 SessionManager 的设计都是错的。

> **解耦决策（最高优先，已定）**：TUI 的会话编排（failover 接线、自动压缩触发、权限队列、检查点管理、TodoWrite 状态）锁在 `useConversation.ts` 这个 1116 行 React hook 里。
> - **Web 不复用它、也不把它抽出来共用**：Web 在 `packages/server` 内写一份**完全独立**的 `SessionManager`（见 F2）。TUI 与 Web 各有各的编排大脑，独立演进，互不牵制。**不做"统一大脑"，不迁移 TUI** —— 解耦的价值高于消除重复。
> - **只共享 core 里的纯原语**：二者共享的仅限 `packages/core` 中**已是纯函数/无状态**的底层件（`runAgent`、`Conversation`、`compaction` 的摘要与切点算法、`memory-consolidation`、检查点存储）。共享这些不构成 TUI↔Web 耦合。
> - **解耦必做的小修正**：当前在 **TUI 包内**的纯模块（如 `packages/tui/src/hooks/failoverCore.ts`）若要被 Web 共用，**必须先移到 `packages/core`**——否则 Web 依赖 TUI 包就是耦合。此类提炼下沉单独成小 spec（见 F0）。
> - **明确接受的代价**：failover/自动压缩的**触发时机与编排序列**会有两份实现、可能漂移。缓解：把可提炼的**纯判定**（"是否该压缩"谓词、failover 序列规划）下沉 core 做成纯函数两边共用，把重复压到最薄；但**编排状态机本身保持各自独立**。

## 3. 包结构（新增）

| 包 | 类型 | 依赖 | 说明 |
|----|------|------|------|
| `packages/server` | Node 服务 | `@zuse/core`、`@zuse/tools` | 常驻 daemon：SessionManager 宿主、WS 端点、鉴权、资源 API、频道适配器、cron 调度 |
| `packages/web` | React SPA | 仅通过 WS/HTTP 与 server 通信，**不** import core | 前端：聊天流、面板、富媒体渲染 |

- 沿用现有约定：`type: module`、Node ≥22、pnpm workspace `packages/*`、vitest 测试、tsup 构建。
- `packages/web` 与后端**零代码共享**，只共享一份 TypeScript 协议类型定义（WS 消息 + 资源 DTO），放在 server 包导出或独立 `packages/protocol`（F3 时定）。

## 4. Spec 清单（细粒度）

### 4.1 地基（顺序依赖，必须先做）

| # | spec | 产出 | 依赖 |
|---|------|------|------|
| **F0** | 纯模块下沉 core（解耦前置） | 把 Web 要共用、但当前锁在 TUI 包内的纯模块迁到 `packages/core`（首批：`failoverCore.ts` 及其测试；后续按需提炼"是否该压缩"谓词、failover 序列规划等纯判定）。TUI 改 import 路径，行为不变，测试守护 | core |
| **F1** | server 骨架 + 传输 + 鉴权 | `packages/server` daemon、WS 端点、**可插拔鉴权接口 + 本地密码门禁**（首次设口令 → 哈希存本地 → 登录发会话 cookie/JWT → 免登）、网络绑定、健康检查；先不接 agent（echo 级） | — |
| **F2** | headless 会话编排核心 | **`packages/server` 内**一份完全独立的 `SessionManager`（传输无关的内部模块，与 WS/HTTP 模块隔离）：回合循环、中断、failover、自动压缩、权限请求外发、检查点、TodoWrite/usage 状态；事件发射器风格；纯单测，不碰 HTTP。复用 core 纯原语（含 F0 下沉的） | F0,F1（需 server 包已搭）|
| **F3** | WS 协议 + 接线 | 定义 WS 消息协议（上行 send/interrupt/steer/permission-reply，下行 stream 事件 + 状态快照）+ 协议类型包；把 F2 接进 F1 的 WS 端点；单会话内存态 | F1,F2 |
| **F4** | React 骨架 + 聊天流 | `packages/web` 应用骨架、WS 客户端、**多模态 parts 消息模型**、聊天流视图 + 富媒体渲染（markdown/代码高亮/Edit diff/mermaid/表格/图片） | F3 |

> 建议构建顺序：**F0 → F1 → F2 → F3 → F4**。F0 先把共享纯件下沉（否则 Web 共用会反向依赖 TUI 包 = 耦合）；F1 搭 `packages/server` 骨架（几乎是 echo 服务器，且 F2 的 `SessionManager` 要落在这个包里，故先于 F2）；F2 是大脑、风险最高、可独立单测；F3 把二者焊起来；F4 渲染。F0 与 F1 互不依赖，可并行起。
>
> **解耦边界重申**：`SessionManager` 落在 `packages/server` 而非 `packages/core`，是为了不诱导"TUI 也来消费它"的统一大脑回潮——它是 **Web 专属**的编排大脑。TUI 的 `useConversation` 不动、不迁移。

#### 鉴权与安全决策（已定）

- **需求收敛**：单用户，只需"一个登录检查"，不做多租户。
- **F1 内做可插拔鉴权接口 + 本地密码门禁**：首次设口令、哈希存本地、登录发会话凭证、之后免登。零外部依赖、离线可用。OAuth 经评估为单人场景的过度设计（引入外部 IdP 依赖、与 local-first 冲突），暂不做；将来如需，按 provider 插到鉴权接口上，不动地基。

| # | spec | 说明 | 依赖 |
|---|------|------|------|
| **A2** | TLS / 隧道（远程访问前置） | 远程访问必须加密，否则明文 HTTP 下凭证与对话内容可被同网段嗅探。自签证书，或文档化经 Cloudflare Tunnel / tailscale（隧道方案顺带免掉 TLS 配置与公网回调） | F1 |

### 4.2 多会话 / 多项目

| # | spec | 说明 | 依赖 |
|---|------|------|------|
| S1 | 会话持久化 + 列表 | 后端会话存储、列表/读取 API | F2,F3 |
| S2 | 会话侧边栏 + 切换 | 前端侧边栏、新建/切换/删除 | S1,F4 |
| S3 | 项目（工作目录）切换 | 多 cwd/项目维度组织会话 | S2 |
| S4 | 历史搜索 | 跨会话全文检索（复用 core 记忆的 FTS 思路或独立） | S1 |

### 4.3 管理面板（多数可并行，每个独立小 spec）

| # | spec | 说明 | 依赖 |
|---|------|------|------|
| M1 | memory 增删改查 | 对 core 记忆库完整 CRUD：列表/搜索、查看、新增、编辑、删除 | F3 |
| M2 | 角色/人设提示词 CRUD + 切换（两层模型）| **核心约束层**（`DEFAULT_SYSTEM_PROMPT` + 非 Claude 强制约束）只读、不参与切换，仅展示以保护系统性约束；**角色/人设层**：管理一组命名人设的完整 CRUD（新增/编辑/删除/列表），"切换"=选择激活哪个人设，作为附加层叠加在核心层之上（复用 `buildSystemPrompt` 现有 `## section` 追加机制，不改引擎）；另提供"查看当前生效完整 prompt"只读视图（拼全各层 + 标来源） | F3 |
| M3 | skill 管理 | 列出已加载 skill、查看内容/触发条件、启用/禁用、**手动编辑已有 skill**（改 SKILL.md 正文/description/触发条件，保存即生效）。不做新增/删除；插件来源的 skill 只读 + 启停（归插件管） | F3 |
| M4 | MCP 管理 | server 列表/健康/启停、查看其工具、增删配置 | F3 |
| M5 | usage 仪表盘 | 实时 token/成本、按会话/模型聚合 | F3 |
| M6 | 检查点时间线 | 影子 git 快照可视化 + 一键 revert | F3 |
| M7 | 文件树浏览器 | 项目文件树、点击预览 | F3 |

> 这些共享同一套"资源 API 约定"（见 §5.1），F3 阶段把约定立好，每个 M-spec 只是新增一类资源端点 + 一个前端面板。

### 4.4 交互增强

| # | spec | 说明 | 依赖 |
|---|------|------|------|
| I1 | 按钮式权限审批 | 权限请求经 WS 推到前端，按钮 allow/deny/always | F3,F4 |
| I2 | 图片上传 | 拖拽/粘贴上传，进入多模态 parts | F4（多模态模型）|
| I3 | 文件预览/编辑 | 页面内预览，受控编辑落盘 | M7 |

### 4.5 语音交互

| # | spec | 说明 | 依赖 |
|---|------|------|------|
| V1 | STT 语音输入 | 录音 → 转写 → 进入输入；WS 二进制帧传音频 | F3（WS 二进制）,F4 |
| V2 | TTS 朗读回复 | 回复转语音播放 | F4 |

### 4.6 定时任务

| # | spec | 说明 | 依赖 |
|---|------|------|------|
| C1 | cron 调度引擎（后端） | 常驻调度器，定时驱动 SessionManager 发起回合 | F2 |
| C2 | 定时任务管理面板 | 增删改查 cron 任务、查看执行历史 | C1,F3 |

### 4.7 外部频道接入

| # | spec | 说明 | 依赖 |
|---|------|------|------|
| G1 | 频道网关抽象 | 统一 inbound/outbound 适配器接口；频道消息 ↔ SessionManager 会话映射 | F2 |
| G2 | Telegram 适配器 | bot token、webhook/long-poll、消息收发 | G1 |
| G3 | 飞书适配器 | 应用凭证、事件订阅、消息收发 | G1 |
| G4 | 频道连接管理面板 | 增删频道、查看连接状态/健康 | G1,F3 |

### 4.8 服务端工具补齐（F3 遗留 follow-up）

F3 地基为快速跑通基础聊天，**故意只在服务端注册了工具子集**（Read/Write/Edit/Glob/Grep/Bash/WebFetch/Memory/WebSearch/TodoWrite）。以下工具当时显式留作 follow-up（见 `createSession.ts` 注释）：

| # | 工具 | 状态 | 说明 / 解锁的能力 | 依赖 |
|---|------|------|------|------|
| **B1** | Agent（子代理） | ✅ 已接（2026-06-26） | 在 `SessionManager` 构造里注册，闭包复用 live client（failover 热替换）/权限流/`sessionAllow`。`onBackground` 暂未接 → 后台子代理目前同步 `await`（仍能跑，只是不真后台）；真后台完成通知需先有"消息注入接口" | F2 |
| **B2** | ScheduleWakeup | 待接 | 定时唤醒；需一个把唤醒消息注入会话的回调（类似 TUI 的 `sendMessage`）。与 C1（cron 引擎）天然同源，建议并入 C1 一起设计 | F2,(C1) |
| **B3** | Lsp / LspInstall | 待接 | 语言服务器查询/安装；需各自的进程池与连接生命周期管理 | F2 |
| **B4** | MCP 工具（`mcp__*`）+ McpSearch | ✅ 已接（2026-06-27） | daemon 启动时 `McpManager.connectAll(settings.mcpServers)` 连一次,经通用 `registerExtraTools(registry)` 接缝把工具注册进每个会话的 registry,`close()` 时 `disconnectAll`。createSession/SessionService 加 `registerExtraTools` 透传。**解锁 M4**。配 `settings.mcpServers` 后重启即生效 | F2 |

> 注：前端工具卡片已对**全部**工具（含未接的）做了结构化渲染（含 MCP 名解析 `mcp__server__tool` + 来源徽章），所以 B2–B4 接好后**前端无需改动**。Web 里子代理的运行/返回/失败状态由 Sub-agents 面板呈现。
> 接缝 `registerExtraTools` 是通用的（不只 MCP）：B2/B3 接入时也可复用它把 ScheduleWakeup/Lsp 工具注册进会话。

## 5. 跨切面扩展点约定（地基阶段必须锁死）

这些是地基 F1–F4 必须提前留好的"接口契约"，否则后续功能会很痛。

### 5.1 统一资源 API 约定
后端为每类可管理资源（memory/prompt/skill/mcp/usage/checkpoint/file/cron/channel/session）暴露一致的端点形态（list/get/create/update/delete + 可选 subscribe 实时推送）。前端面板按同一模式消费。F3 落约定，每个 M/C/G-spec 只填充具体资源。

### 5.2 多模态 parts 消息模型
消息从"纯文本字段"升级为 `parts: Array<TextPart | ImagePart | AudioPart | ...>`。F4 就要建好，否则图片上传（I2）、语音（V1/V2）、富媒体会被迫返工。

### 5.3 WS 协议 + 二进制帧
WS 既走 JSON 控制/事件帧，也要保留二进制帧通道（音频/文件流）。F3 定协议时一并预留，给语音（V1）留口子。

### 5.4 富媒体渲染管线
F4 的渲染层按"可注册的 part 渲染器"组织（markdown / 代码 / diff / mermaid / 图片 / 表格 / 自定义），新增媒体类型 = 注册新渲染器，不改主干。

### 5.5 SessionManager 驱动源中立
F2 的 API 不得出现 WS/HTTP/Telegram 等具体传输概念。所有驱动源（WS、Cron C1、频道 G1）通过同一组方法（如 `startTurn`、`interrupt`、`onEvent`）驱动会话。

## 6. 非目标（Non-goals）

- **多租户/多用户**：明确单用户。不做用户隔离、不做沙箱化文件/shell 收口。后端信任本机用户，远程访问仅靠 token 闸门。
- **不改 TUI**：本程序不重构 `useConversation.ts`，不让 TUI 依赖 server/web。
- **不共用 UI 编排**：Web 不复用 TUI 的 React 编排代码（见 §2 取舍）。

## 7. 推进方式

1. 本总纲提交后，**逐个 spec 各自 brainstorm → 设计文档 → 实现计划**。
2. 构建顺序 **F0 → F1 → F2 → F3 → F4**；F0（纯件下沉）、F1（server 骨架）较机械/轻量，轻 spec 即可。
3. **首个详细设计 spec：F2（headless 会话编排核心）**——设计最重、风险最高，先设计透。
4. 地基完成、主干跑通后，§4.2–4.7 各功能多数可并行推进，按需排期。

---

## 附：spec 依赖速查

```
F0(纯件下沉) ─┐
F1(server骨架)─┴─ F2 ──┬── F3 ── F4 ── S2,S3 / I1 / I2,I3 / V1,V2
                       │         └── M1..M7 / S1(→S4) / C2 / G4
                       ├── C1 ── C2
                       └── G1 ──┬── G2 / G3 / G4
```

---

## 8. 附加调研计划：Agent 记忆框架横向对比（mem0 / Zep / Letta vs Zuse）

> **性质**：调研 + 评估计划（**不是**实现 spec，也不属于 Web UI 程序主干）。
> **目标**：把 Zuse 现有自研记忆与主流开源 agent 记忆框架做受控对比，得出结论——**继续自研增强 / 集成其中之一 / 抽一层适配接口**，并给出依据。
> **触发**：M1（memory CRUD）已落地，记忆是 Zuse 长期能力的核心之一，值得在投入更多前先做一次外部对标。

### 8.1 Zuse 现状基线（对比的"我方"）

- **存储**：`better-sqlite3` + **FTS5**（trigram 分词 + LIKE 兜底），库在 `~/.zuse/memory.db`；纯本地、零外部服务、离线可用。
- **结构**：四类记忆 `user / project / insight / reference`；`project` 列 = cwd-slug（`''` = 全局）做项目隔离；可选 `hook`（一句话索引摘要）。
- **检索**：关键词/全文检索（**非向量**）；`MEMORY.md` 索引在会话启动注入 system prompt。
- **写入/巩固**：模型经 `Memory` 工具显式 save；`applyMemoryConsolidation` 做去重/合并。
- **契合点**：与 `packages/core` 解耦良好、local-first、无网络依赖、可审计（M1 面板直接 CRUD）。

### 8.2 对比候选

| 框架 | 记忆范式（一句话） | 关注点 |
|------|------|------|
| **mem0** | 向量检索 + 可选图谱，LLM 自动抽取"事实"并增量更新 | 自动抽取/更新、托管或自托管、多后端向量库 |
| **Zep**（Graphiti） | **时间知识图谱**：实体/关系带时间有效区间，会话记忆时间感知 | 时间衰减/失效、关系推理、会话级记忆 |
| **Letta**（原 MemGPT） | **分层记忆 + 自编辑**：core/recall/archival，agent 自己管理 context 窗口 | agent 自管理记忆、长上下文分页、记忆即工具 |

### 8.3 评估维度（打分表）

1. 存储与检索范式（向量 vs FTS vs 图）与召回质量
2. 记忆类型/结构表达力（能否表达 user/project/insight/reference 这类分型）
3. 自动抽取 / 巩固 / 去重能力（vs Zuse 的显式 save + consolidation）
4. **时间感知**（失效、衰减、版本化）—— Zuse 当前缺失
5. 多会话 / 多项目隔离能力
6. **local-first / 离线 / 无外部依赖**（Zuse 的硬约束，权重最高）
7. 运维与依赖成本（要不要起向量库/图库/外部服务）
8. 与 `packages/core` 的**解耦契合度**（能否做成可替换的 store 接口，不污染引擎）
9. 可扩展性与可审计性（能否像 M1 那样直接 CRUD/检视）
10. License 与项目活跃度

### 8.4 方法

1. 三个框架各自跑通最小 demo，喂同一组 Zuse 真实用例：① 跨会话事实召回 ② 项目隔离 ③ 标题/上下文补全 ④ 长期偏好记忆。
2. 用 8.3 维度逐项打分（1–5），权重向"local-first / 解耦 / 召回质量"倾斜。
3. 记录每个框架接入 Zuse 的**最小改造面**（是否需要 server 起额外进程、是否破坏离线、是否需抽象 store 接口）。

### 8.5 产出与决策标准

- **产出**：一份对比文档（打分表 + 利弊 + 接入改造面估算）+ 明确推荐。
- **决策标准**：
  - 若没有框架能在**不破坏 local-first / 不引入外部服务**的前提下显著超过现状 → **继续自研**，按需吸收单点能力（最可能先补**时间感知**与**自动抽取**）。
  - 若某框架可作为**可替换 store** 干净接入（core 仅依赖一个 `MemoryStore` 接口）→ 评估抽象出该接口、把现有 SQLite 实现与候选并列为两个 provider。
  - 不为"功能更多"牺牲解耦与离线这两条硬约束。

> 排期：独立于 Web UI 主干，可在任意 M-spec 间隙穿插；建议在 M1 稳定、有真实记忆数据后再做，对比才有真实负载。
