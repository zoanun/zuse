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

> **关于 `useConversation.ts`**：TUI 的会话编排（failover 接线、自动压缩触发、权限队列、检查点管理、TodoWrite 状态）锁在这个 1116 行的 React hook 里。Web **不复用它**，而是在 F2 写一份框架无关的等价编排。已经是纯函数的小模块（如 `packages/tui/.../failoverCore.ts`、`packages/core/.../compaction.ts`）可直接 import。这是刻意的解耦取舍：Web 功能会大幅发散，强行共用编排反而会互相掣肘。代价是 failover/压缩等核心策略存在两份实现，需要靠各自的单测守护，发现策略级 bug 时两边都要查。

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
| **F2** | headless 会话编排核心 | `SessionManager`：传输无关的会话状态机——回合循环、中断、failover、自动压缩、权限请求外发、检查点、TodoWrite/usage 状态；事件发射器风格；纯单测，不碰 HTTP | core |
| **F1** | server 骨架 + 传输 + 鉴权 | `packages/server` daemon、WS 端点、**可插拔鉴权接口 + 本地密码门禁**（首次设口令 → 哈希存本地 → 登录发会话 cookie/JWT → 免登）、网络绑定、健康检查；先不接 agent（echo 级） | — |
| **F3** | WS 协议 + 接线 | 定义 WS 消息协议（上行 send/interrupt/steer/permission-reply，下行 stream 事件 + 状态快照）+ 协议类型包；把 F2 接进 F1；单会话内存态 | F1,F2 |
| **F4** | React 骨架 + 聊天流 | `packages/web` 应用骨架、WS 客户端、**多模态 parts 消息模型**、聊天流视图 + 富媒体渲染（markdown/代码高亮/Edit diff/mermaid/表格/图片） | F3 |

> 建议构建顺序：**F2 → F1 → F3 → F4**。F2 是大脑、风险最高、可独立单测，先设计透；F1 几乎是 echo 服务器；F3 把二者焊起来；F4 渲染。F1 与 F2 无相互依赖，若并行开发可同时起。

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
| M3 | skill 查看 | 列出已加载 skill、查看内容/触发条件 | F3 |
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
2. 首个详细 spec：**F2（headless 会话编排核心）**。
3. 地基 F1–F4 完成、主干跑通后，§4.2–4.7 各功能多数可并行推进，按需排期。

---

## 附：spec 依赖速查

```
F2 ──┬── F1 ── F3 ── F4 ── S2,S3 / I1 / I2,I3 / V1,V2
     │         └── M1..M7 / S1(→S4) / C2 / G4
     ├── C1 ── C2
     └── G1 ──┬── G2 / G3 / G4
```
