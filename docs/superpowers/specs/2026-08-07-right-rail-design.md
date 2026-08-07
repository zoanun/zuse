# 右侧工作栏 设计

> 目标：把**预览**和**待办列表**从聊天消息流里搬出来，放进右侧独立分栏。
> 这个栏同时是后续 **dev server 预览** 和 **Python/Java 运行输出** 的落点 ——
> 所以它不是「预览的容器」，是**工作状态栏**：左边是对话，右边是"正在发生什么"。

## 0. 现状（实读）

```
.shell   { height:100vh; display:flex }          styles.css:38
  .sidebar { width:256px; flex:none }            styles.css:39
  .main    { flex:1; min-width:0;
             display:flex; flex-direction:column } styles.css:70
    .main-header                                  Shell.tsx:262
    main.chat { flex:1; display:flex;
                flex-direction:column }           styles.css:99 / Shell.tsx:264
      .messages { flex:1; overflow-y:auto }       styles.css:101
      …composer
```

预览目前渲染在 `Markdown` 的 CodeBlock 内部，属于 `.messages` 滚动流的一部分。

## 1. 核心障碍：`activePreview` 只存 id，不存内容

`preview/activePreview.ts` 现在的状态只有 `activeId: string | null`，
代码内容留在 `CodeBlock` 的作用域里（它拿自己的 `id` 去问 `useIsPreviewOpen(id)`）。

右侧面板与 CodeBlock **不在同一棵子树**，拿不到内容。所以 store 必须升级为携带载荷：

```ts
export interface ActiveRun {
  id: string                 // 来源代码块 id，用于按钮态与「再点一次关闭」
  kind: PreviewKind          // 'html' | 'js' | 'jsx' | 'vue' | …（未来 'python' | 'java' | 'devserver'）
  code: string
  /** 来源标签，面板标题显示用（例如「消息 3 · vue」） */
  label?: string
}
```

`openPreview(id)` → `openRun(run: ActiveRun)`。

**必须保留的既有设计约束**（`activePreview.ts` 里已写明理由，别改掉）：
- 做成**模块级 store 而不是 context** —— 用 context 会迫使 `Markdown` 的 `components`
  表随状态重建，那正是它被 hoist 出来要避免的（每个流式 delta 重新处理一遍 markdown）。
  升级后**仍然**要用 `useSyncExternalStore`，不要顺手改成 context。
- **同一时刻只有一个活预览** —— 每个活预览 = 一个 iframe + 一份懒加载编译器。

**新增的坑**：store 里现在有 `code` 字符串。`useSyncExternalStore` 的 `getSnapshot`
**必须返回稳定引用**，不能每次返回新对象，否则无限重渲染。用「存整个 ActiveRun 对象、
整体替换」的写法，`getSnapshot = () => activeRun`。

## 2. 布局

`.main` 从「纵向单列」改成「header + 横向 body」：

```
.shell
  .sidebar
  .main (column)
    .main-header                       ← 仍然横跨全宽
    .main-body (row)                   ← 新增
      main.chat  (flex:1, min-width:0)
      .run-pane  (width:可拖拽, flex:none)   ← 新增
```

header 保持全宽（模型选择器、cwd 这些是全局的，不该被分栏切开）。

**为什么不放进 `.shell` 做第三栏**：那样 header 会被挤在左半边，
且 `.sidebar` 的折叠逻辑（`menu-open` / `.backdrop`）要跟着改，收益为零。

### 1.1 分栏宽度
- 默认 `min(50%, 720px)`；可拖拽，范围 `[320px, 70%]`
- 宽度写 `localStorage`（键名带前缀，与既有 `zuse-theme` 同风格）。
  **不进服务端设置** —— 这是每台机器的显示偏好，不是会话状态。

### 1.2 窄屏
`.main-body` 宽度 < 900px 时：面板改为**覆盖式**（绝对定位盖住聊天区，带关闭按钮），
而不是继续压缩聊天列。理由：聊天正文本来就是限宽居中的排版，压到 300px 会烂。

## 3. 面板结构：右栏装三样东西

右栏不只放预览。**待办列表也搬过去**，它和预览是同一类东西 ——
「正在发生什么」，而不是「说过什么」。顺带把子代理面板一起搬（它和待办是同一种状态信息，
留一个在左边、搬一个到右边只会更乱）。

```
.rail                          右栏容器（可拖宽）
  .rail-run      ← 预览 / 运行输出（flex:1，抢占剩余高度）
    .rail-run-head     标题（来源 + 类型）+「新标签打开」+ 关闭
    .rail-run-body     <PreviewFrame> / 未来的 <DevServerFrame> / <ProcessOutput>
    .rail-run-console  <ConsolePanel>（可折叠、高度可拖）
  .rail-todos    ← <TodosPanel>（flex:none，可折叠）
  .rail-agents   ← <AgentsPanel>（flex:none，可折叠）
```

**为什么是堆叠而不是标签页**：待办是**环境感知**信息（余光扫一眼"它做到哪了"），
预览是**主动查看**的对象。做成标签页会强迫二选一，恰好抹掉待办的用处。
堆叠 + 各自可折叠既能同时看见，又能在跑大预览时把待办收起来。

**空态**：三块都没内容时，整个右栏**不占位**（`.main-body` 退回单列）。
不要留一个空框在那儿——那正是这套界面「去框化」重做时要拆掉的东西。
只有待办有内容 → 右栏出现，但宽度收窄到 `320px`（待办不需要 720px）。

`TodosPanel` / `AgentsPanel` 现在的 CSS 用了聊天列的限宽变量
（`styles.css:305` 的 `margin-inline: max(20px, calc((100% - var(--col)) / 2))`），
搬进右栏后这条**必须去掉**，否则会在窄栏里被挤成一条线。

`ConsolePanel` 从 CodeBlock 内部搬到这里，**高度要能拖** ——
嵌在消息流里时固定高度尚可，独立成栏后固定高度会很别扭。

## 4. 代码块那一侧留什么

- 「运行」按钮**留在代码块右上角**（发起点不变，符合直觉）
- 按钮态：正在右侧运行的那个代码块，按钮显示为「运行中 / 停止」并高亮
- 代码块**下方不再内嵌任何东西**

## 5. 建立在 A1 评审修复之上（已合入 `73e5a5f`）

那三条已经修完并入 master，本设计**建立在修复后的代码上**。它们直接决定右栏能不能做对：

- **P0-1 切主题预览永久空白（已修）** —— `srcdoc` 不再依赖 `theme`（初值取 `initialThemeRef`，
  实时变化走既有 postMessage 通道）；单槽 `pendingRef` 换成了 `lastEvalRef` + `lastThemeRef`，
  由 `ready` 分支重放。**这个重放机制是右栏的前提**：右栏面板挂载/卸载/宽度变化的次数比内嵌时多得多，
  没有它，每次重建 document 都会丢掉待下发的代码。
- **P0-2 已摘掉 `allow-same-origin`** —— 与布局无关，但改的是同一个文件；
  搬家时**不要**顺手把 `SANDBOX_TOKENS` 改回去（有测试断言它不存在）。
- **P1-1 重渲染即重跑（已修，且根因比评审说的深一层）** —— 除了 effect 依赖收敛到
  `[spec.kind, spec.code, ...]`，真根因是 `Markdown.tsx` 里内联的 `<pre>` ref 回调每次渲染
  都是新身份，React 先 `ref(null)` 再 `ref(el)`，那次 null 读到 `textContent` 为空就 `setCode('')`，
  于是 `code` 每次重渲染都在 `TEXT → '' → TEXT` 抖。已加 `if (!el) return` 守卫，并补上防抖
  （`COMPILE_DEBOUNCE_MS = 120`）。

  **搬到右栏后这个风险会被放大**：拖拽分栏宽度会高频触发父组件重渲染。
  所以拖拽**必须用 CSS 变量/transform 驱动**，
  **不要**把宽度作为 React state 逐帧下发给 `PreviewFrame`。
  这条要用真浏览器锁死（见 §6）。

## 6. 测试

**逻辑层**
- store 升级：`getSnapshot` 引用稳定（连续调用 `===`）；打开新预览替换旧的；关闭清空
- 面板不挂载时不编译（不该因为 store 有值就预编译）
- 窄屏切覆盖式的断点行为
- 宽度持久化读写；异常值（负数、超范围、非数字）回落默认
- **空态不占位**：三块都空 → 右栏不渲染；只有待办有内容 → 右栏出现且宽度收窄
- `TodosPanel` / `AgentsPanel` 搬家后**行为不变**（原有测试应当原样通过；
  如果它们的测试依赖了聊天列的限宽 class，那是测试耦合了布局，要一并解耦）

**真跑层（必须，测试绿 ≠ 能用）**
- 真浏览器：跑一个 React 计数器 → 点到 3 → **拖动分栏宽度** → 计数**必须还是 3**
  （这条直接锁住 §5 的 P1-1 放大风险，是本次最该做的断言）
- 切换主题 → 预览仍在、仍可交互（锁 P0-1）
- 窄屏（resize 到 800px）→ 面板转覆盖式且能关掉

## 7. 明确不做

- 不做多标签页/多预览并存（与「同一时刻一个」的既有决策一致）
- 不做面板与聊天左右互换
- 不把面板宽度同步到服务端
