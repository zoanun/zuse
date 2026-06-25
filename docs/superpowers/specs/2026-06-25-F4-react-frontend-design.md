# F4：React 前端(packages/web)— 设计文档

> **日期**: 2026-06-25
> **所属程序**: Web UI 路线图(`docs/superpowers/specs/2026-06-22-web-ui-roadmap.md`),地基 spec F4
> **依赖**: F1(server+传输+鉴权)、F2(SessionManager)、F3(WS 协议 + 接线)均已合并 master
> **产出**: 新增 `packages/web`——真正的 React SPA(Vite),通过 WS 连后端,达到当前 dev 页的功能对等,并由 node 服务器托管打包产物

---

## 1. 背景与目标

F3 把 SessionManager 焊进 `/ws`,并配了一个**自包含的 vanilla dev 测试页**(`packages/server/src/http/devPage.ts`)用于实测——它已相当完整:聊天流、流式 Markdown(手写渲染器)、light/dark 主题、侧栏抽屉、按钮式权限审批、TodoWrite 任务面板、ctx/usage 状态 chip。

F4 用一个**真正的 React SPA** 替换这个一次性 dev 页。相比 dev 页的两个本质区别:
1. **可以用 npm 库**:dev 页因为是内联单文件、零外部依赖,Markdown 是手写的;React SPA 由 Vite 打包,可直接用 `react-markdown`、代码高亮等成熟库。
2. **可维护的组件结构 + 纯函数状态归约**:dev 页是一大坨命令式 DOM 操作;React 版按组件拆分,事件流用纯函数 reducer 归约成 UI 状态,可单测。

dev 页的**视觉语言**(暖色纸感 light / 暖黑 dark、侧栏+主区外壳、头像消失只留正文、任务面板)已定,F4 沿用,不重新设计观感。

## 2. 解耦边界(继续守)

- `packages/web` 是**浏览器 SPA**,只通过 WS/HTTP 与 server 通信。**只 type-only 依赖 `@zuse/protocol`** 拿线缆类型;**绝不 value-import `@zuse/core`/`@zuse/server`/`@zuse/tui`**(core 是 Node 引擎,进不了浏览器 bundle;tui 是另一条线)。
- web 与后端**零运行时代码共享**,唯一共享物是 `@zuse/protocol` 的类型(F3 已建)。

## 3. 包与构建(`packages/web`)

### 3.1 技术栈
- **Vite + React 19 + TypeScript**。
- 运行时依赖:`react`、`react-dom`、`react-markdown`、`remark-gfm`(表格 / 任务列表 / 删除线 / 自动链接)、`rehype-highlight`(基于 highlight.js 的代码高亮)。
- 开发依赖:`vite`、`@vitejs/plugin-react`、`@testing-library/react`、`@testing-library/jest-dom`、`jsdom`、`@types/react`、`@types/react-dom`。
- `@zuse/protocol`:`workspace:*`,仅 `import type`。
- `package.json`:`private: true`、`type: module`、脚本 `dev`(vite)、`build`(`tsc -b` 可选 + `vite build`)、`preview`、`typecheck`(`tsc --noEmit`)、`test`(vitest)。

### 3.2 开发工作流
- `pnpm -F @zuse/web dev` 起 Vite dev server(:5173),`vite.config.ts` 配 proxy:
  - `/ws` → `ws://127.0.0.1:4180`(`ws: true`)
  - `/api`、`/healthz` → `http://127.0.0.1:4180`
- 同时另起 node 服务 `npx tsx packages/server/src/bin.ts`(:4180)。浏览器开 :5173,热更新。

### 3.3 生产 / 托管
- `pnpm -F @zuse/web build` → `packages/web/dist`(index.html + 带 hash 的 assets)。
- **node 服务器新增静态托管 + SPA fallback**(见 §6),让 :4180 直接服打包后的 SPA(此时不需要 Vite)。
- **不**用 tsup 打包 web(web 是独立 Vite 构建,与现有库的 tsup 流程隔离)。

## 4. 协议小扩展(为 ctx 已用/窗口/百分比)

当前 `SessionSnapshot`/`context-update` 只有 `contextTokens`(已用),没有窗口大小,前端算不出百分比。F4 扩展:

- `@zuse/protocol`:
  - `SessionSnapshot` 加 `contextWindow: number | undefined`。
  - `context-update` 事件由 `{ type: 'context-update'; contextTokens: number | undefined }` 改为 `{ type: 'context-update'; contextTokens: number | undefined; contextWindow: number | undefined }`。
- `SessionManager`:`getState()` 与发 `context-update` 处,用 `resolveContextWindow(this.settings, this.currentProviderId, this.client.getModel())` 计算窗口,一并带上。
- dev 页(`devPage.ts`)的 `context-update`/snapshot 处理**同步跟一下字段**(否则 fallback 页会缺字段;改动极小),前端 chip 显示 `ctx 4.7k / 200k · 2%`。
- 既有 server 测试若断言 `context-update` 形状,需同步更新。

## 5. 前端架构

### 5.1 目录(`packages/web/src`)
```
main.tsx            挂载 React
App.tsx             外壳(AuthGate → Shell)
ws/client.ts        WSClient:连接/解析 ServerMessage/重连/发送 ClientMessage
state/reducer.ts    纯函数:SessionEvent/ServerMessage → AppState(重点单测)
state/types.ts      Message/Part/AppState 等前端模型
state/store.tsx     Context + useReducer + WSClient 接线
theme.ts            主题读取/切换(localStorage + data-theme)
components/
  Shell.tsx         sidebar + main 布局
  Sidebar.tsx       品牌(Z)/New chat/状态足
  Header.tsx        chips(model / ctx 已用·窗口·% / conn)+ 主题切换 + 抽屉按钮
  MessageList.tsx   消息流容器(自动滚动)
  Message.tsx       按 part.type 分发渲染
  Markdown.tsx      react-markdown 封装(remark-gfm + rehype-highlight)
  ToolCall.tsx      工具调用卡(名 + 入参 + 结果)
  PermissionCard.tsx allow/always/deny 按钮 → permission-reply
  TodosPanel.tsx    TodoWrite 三态面板(○/●/✓)
  Composer.tsx      输入框 + 发送/停止;Enter 发送、Shift+Enter 换行
  AuthGate.tsx      setup/login,复用 /api/auth/*
styles.css          CSS 变量(暖色 light/dark token,沿用 dev 页)+ 组件样式
```

### 5.2 状态模型(parts 消息模型,§5.2)
```ts
type Part =
  | { kind: 'text'; text: string }
  | { kind: 'tool-use'; id: string; name: string; input: unknown }
  | { kind: 'tool-result'; id: string; output: string; isError: boolean }
  // 图片/音频 part 先留空间(I2/V 再填)
type Message = { id: string; role: 'user' | 'assistant'; parts: Part[] }
interface AppState {
  messages: Message[]
  todos: TodoItemLite[]            // 来自 @zuse/protocol
  pendingPermissions: PendingPermissionLite[]
  model?: string
  contextTokens?: number
  contextWindow?: number
  totalUsage?: Usage
  thinking: boolean
  connection: 'connecting' | 'live' | 'down'
  notices: { id: string; text: string; kind: 'info' | 'warn' | 'error' }[]
}
```
- **reducer** 把每个 `ServerMessage`/`SessionEvent` 归约进 `AppState`(纯函数、无副作用 → 易单测):
  - `snapshot` → 初始化 model/ctx/window/usage/todos/pendingPermissions/thinking。
  - `message-start` → push 空 assistant message;`text-delta` → 追加到当前 assistant 的末尾 text part;`message-stop` → 收尾。
  - `tool-use`/`tool-result` → 作为 part 进当前 assistant message(按 id 关联)。
  - `turn-start/turn-end` → thinking;`usage-update`/`context-update` → 统计;`todos-update` → todos;`permission-request`/`permission-resolved` → pendingPermissions;`failover`/`memory-notice`/`warning`/`error`/`aborted`/`compaction-*`/`cwd-change` → notices。
- 用户发送时,本地先 push 一条 user message(乐观),再 `ws.send({type:'send',text})`。

### 5.3 富媒体渲染管线(§5.4)
- `Message` 按 `part.kind` 选渲染组件(text→`Markdown`,tool-use/result→`ToolCall`);这是"可注册的 part 渲染器"的最小形态。
- Markdown 内代码块由 `rehype-highlight` 高亮。mermaid/diff/image **留接口位**,F4 不实现。

## 6. 服务器静态托管(server 改动)

- `RequestHandlerDeps` 加 `webDir?: string`。`makeRequestHandler`:
  - 路由优先级不变:`/healthz`、`/api/*`、(WS 在 upgrade 层)先于静态。
  - 新增静态服务:`GET` 命中 `webDir` 下的真实文件(index.html / assets/*,带正确 content-type)→ 返回。
  - **SPA fallback**:其余非 API 的 `GET`(如 `/`、未知前端路由)→ 返回 `webDir/index.html`。
  - `webDir` 未配置或不存在时,回退现有 `DEV_PAGE_HTML`(保证无 build 也能用、且做对照)。
- `startServer`/`ServerConfig` 加可选 `webDir`(缺省解析到 `packages/web/dist`,解析不到则 undefined → dev 页 fallback)。
- 安全:静态文件读取要防目录穿越(规范化路径、限制在 webDir 内)。
- **不在 F4**:把 web/dist 打进 `@zuse/server` 的 npm 发布产物(发布集成留后续);F4 只保证本地 `build` 后 :4180 能托管。

## 7. 鉴权

`AuthGate` 复用现有 `/api/auth/status|setup|login`(F1):
- `status.configured=false` → setup 表单;`authenticated=false` → login 表单;否则挂主应用并开 WS。
- 登录走同源 POST(dev 时经 Vite proxy 到 :4180,cookie 同源)。

## 8. 错误处理

| 场景 | 行为 |
|------|------|
| WS 断开 | connection='down';客户端退避重连;重连后 server 发新 snapshot 重建状态 |
| `error` 帧 / `warning`/`failover`/`aborted` 事件 | 进 notices,在流里以系统提示样式展示 |
| 鉴权失效(WS 401) | 回到 AuthGate 登录 |
| 后端不可达 | AuthGate 显示"server unreachable" |
| 模型/工具错误 | SessionManager 已发对应事件,前端原样展示 |

## 9. 测试策略

- **reducer 单测(重点)**:构造各类 `SessionEvent` 序列,断言 `AppState`(流式累加成一条消息、todos 三态、permission 增删、ctx/window/usage、thinking 翻转)。纯函数,无需 DOM。
- **WSClient 单测**:用内存/fake WebSocket,断言解析与 send 编码、重连。
- **组件测**(RTL + jsdom):Composer 发送(Enter/Shift+Enter)、PermissionCard 点击发 `permission-reply`、TodosPanel 三态、Markdown 渲染(标题/表格/代码/任务列表)、Header 显示 ctx 百分比。
- **server 测**:静态路由命中真实文件、SPA fallback 回 index.html、无 webDir 时回退 dev 页、防目录穿越;既有 76 测试不回归(注意 `context-update` 字段扩展的同步)。
- **解耦守护**:`packages/web` 对 `@zuse/core`/`@zuse/server`/`@zuse/tui` 零 import(只 `import type` protocol)。

## 10. 验收

1. 开发态:`pnpm -F @zuse/web dev` + node 服务,浏览器 :5173 登录后真聊——流式 **Markdown**、light/dark 主题、侧栏抽屉、按钮权限、任务面板、`ctx 已用 / 窗口 · 百分比` 全部工作。
2. 生产态:`pnpm -F @zuse/web build` 后,仅起 node 服务(:4180,配 `webDir`),浏览器直接用打包 SPA。
3. 全 workspace 测试绿;`packages/web` typecheck 干净;零 web→core/server/tui 依赖。

## 11. Follow-ups(不阻断 F4)

- I2 图片上传(多模态 parts 上行)、V1/V2 语音、mermaid/diff 渲染器、S1 多会话+持久化+断线事件补发、M 系列管理面板。
- npm 发布时把 `web/dist` 随 `@zuse/server` 一起发(构建编排 + `files`)。
- 中途 steer(turn 进行中再发消息)在前端的交互(F4 先沿用 dev 页的"思考中禁用发送")。
