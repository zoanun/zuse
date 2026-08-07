# 右侧工作栏 设计 v2

> 目标：把**预览**和**待办列表**从聊天消息流里搬出来，放进右侧独立分栏。
> 这个栏同时是后续 **dev server 预览** 和 **Python/Java 运行输出** 的落点。
>
> v1 被独立评审判为「不能进入实现」，6 个 P0。**v2 按评审拆成三个 PR**，本文档主体描述 PR1。

## 0. v1 错在哪（先认账）

| v1 的说法 | 实际 |
|---|---|
| §0「现状（实读）」写了 `.messages { flex:1; overflow-y:auto } styles.css:101` | **仓库里没有 `.messages` 这个类**（全库 grep 无命中）。真名是 `.stream`，`styles.css:100-105`。这是在标着「实读」的段落里写了不存在的东西 —— 正是 CLAUDE.md 第三节要防的事 |
| §5「拖拽会高频重渲染 → 放大重编译风险」 | **方向反了**。编译 effect 依赖是 `[kind, code, push, send]`（`PreviewFrame.tsx:154`），后两个是 `useCallback(...,[])`（`:83-85`、`:89-93`）恒稳定；右栏架构下 `kind`/`code` 是 store 里的冻结字符串。拖拽改不动这四个值 → **不重编译**。于是 §6 那条「拖动后计数还是 3」**必然通过，是空跑护栏** |
| §1.2「`.main-body` 宽度 < 900px 转覆盖式」 | 这是**容器查询**不是媒体查询，只能用 `@container`；仓库里 `@container` 用量为零。且实测 `.main-body` 宽度**对视口非单调**（视口 830→574px，视口 815→815px），因为 `styles.css:603-608` 在 820px 把 sidebar 变 `position:fixed` 脱离文档流 |
| §1.1 允许拖到 70%，§1.2 说「压到 300px 会烂」 | **自相矛盾**。实测 1440 屏拖到 70% 时聊天列 355px，而 `.main-body` 全程 1184 > 900，**覆盖式一次都不会触发** |
| §3「ConsolePanel 从 CodeBlock 内部搬过来」 | 它**不在** CodeBlock 里。渲染在 `PreviewFrame.tsx:190`，`entries` 是 PreviewFrame 的私有 state（`:59`）。要做成兄弟节点就得改 PreviewFrame 的接口 |
| §6 担心 Todos/Agents 测试会红 | 它们**很干净、不会红**（纯 `render` + `getByText`，零布局耦合）。真正会红的是 §6 没提的 `Markdown.test.tsx:51`/`:92` 两条 |

评审同时**逐条核实 §5 对已合入代码（`73e5a5f`）的描述全部属实** —— 错的只是从那些事实推出的风险方向。

## 1. 拆成三个 PR

三件事各有各的失败模式，捆在一起时「demo 为什么归零」无法归因：

| PR | 内容 | 为什么这样切 |
|---|---|---|
| **PR1（本文档主体）** | 只搬预览到右栏，**固定宽度，不做拖拽** | 收益的九成在「预览不再跟着聊天滚走」，与拖拽无关。省掉持久化、钳位、以及最难写的那条测试 |
| PR2 | 待办 / 子代理搬家 + 空态谓词提取 | 独立可验证 |
| PR3 | 拖拽（如果 PR1 用下来真觉得需要） | 可能根本不需要 |

## 2. 现状（本次为实读，逐条核过）

```
.shell   { height:100vh; display:flex }             styles.css:38
  .sidebar { width:256px; flex:none }               styles.css:39   （820px 处转 position:fixed，:603-608）
  .main    { flex:1; min-width:0;
             display:flex; flex-direction:column }  styles.css:70
    .main-header                                    Shell.tsx:262
    main.chat { flex:1; display:flex;
                flex-direction:column }             styles.css:99
      .stream { flex:1; overflow-y:auto; … }        styles.css:100-105   ← 不是 .messages
      …composer
--col = 46rem = 736px                               styles.css:11
```

预览目前渲染在 `Markdown.tsx:109` 的 CodeBlock 内部；`ConsolePanel` 在 `PreviewFrame.tsx:190` 内部。

## 3. store 升级

`activePreview.ts` 现在只存 `activeId: string | null`。升级为携带载荷：

```ts
export interface ActiveRun {
  id: string
  kind: PreviewKind
  code: string
  sessionId: string     // ← P0-2：run 的生命周期归属会话
}
```

**必须保留的既有决策**（`activePreview.ts:9-11` 已写明理由）：模块级 store 而非 context ——
用 context 会迫使 `Markdown` 的 `components` 表随状态重建，那正是它被 hoist 出来要避免的。
升级后**仍然**用 `useSyncExternalStore`。

### 3.1 `getSnapshot` 的两种写法，一种禁止

```ts
// 允许：返回 store 持有的同一个对象（整体替换，Object.is 够用）
const getSnapshot = () => activeRun
// 允许：返回布尔（按值比较）
useSyncExternalStore(sub, () => activeRun?.id === id)
// 禁止：返回派生对象 —— 每次新引用 → 无限重渲染
useSyncExternalStore(sub, () => ({ open: activeRun?.id === id }))   // ✗
```

### 3.2 `code` 用**快照**，不是活推

点击「运行」时冻结代码。理由：活推（CodeBlock 每次 code 变就 `updateRun`）会把抖动通过模块级 store
广播给**每一个** CodeBlock 订阅者，反而新引入重渲染风暴。
代价：流式/revert 后代码变了预览不跟 —— 可接受，因为运行按钮在流式期本就禁用（`Markdown.tsx:83`），
点击时代码必然已完整。

### 3.3 run 归属会话（P0-2）

`activePreview` 是模块级单例，**目前没有任何人在切会话时清它**
（`grep closePreview` 只有 `Markdown.tsx:85`/`:109` 两处调用点）。
今天无害：预览在 CodeBlock 内，切会话 → 消息树换掉 → 预览随之消失。
搬到右栏后由 store 驱动、与消息树无关 → **在会话 A 打开预览、切到会话 B，右栏还挂着 A 的代码**。
`/clear`、revert、`switchSession` 是同一条路。

做法：`Shell` 里 `useEffect(() => closeRun(), [currentSessionId])`，或在选择器里比对 `sessionId`。

### 3.4 `id` 不能用 `useId()`（P0-3）

`CodeBlock` 现在拿 `useId()` 当身份（`Markdown.tsx:69`）。`useId()` **位置派生**，实测：

```
plain: _R_0_ / share: _R_2_ / filtered: _R_2_
```

进出分享模式时 `MessageList.tsx:99`/`:108` 的 `label` ↔ `div` 互换会整体重挂
（`Shell.tsx:169` 的注释本身就写着这件事），且 `:79` 的 `shareMode` 过滤还会改列表长度。

后果：预览跑着 → 点「分享」→ 按钮从「停止」翻回「运行」→ 再点一下 `openRun` 用新 id 顶掉旧 run
→ **iframe 重挂、计数器归零**。

做法：用 `messageId + 代码块序号` 组合（`Message` 已有稳定 id，见 `2026-07-23-stable-message-id-design.md`）。
`StreamingContext` 那条通道已经在，可复用来传 messageId。

## 4. 布局

```
.shell
  .sidebar
  .main (column)
    .main-header                       ← 仍横跨全宽
    .main-body (row)                   ← 新增，【永远渲染】
      main.chat  (flex:1, min-width:560px)
      aside.rail (flex:none)           ← 只有它条件渲染
```

### 4.1 `.main-body` 永远渲染（P0-1，最重要的一条）

v1 §3 那句「三块都没内容时整个右栏不占位，`.main-body` 退回单列」会直接诱导实现者写成：

```tsx
hasRail ? <div className="main-body">{chat}{rail}</div> : <main className="chat">…</main>   // ✗
```

那会在右栏每次出现/消失时**卸载并重建 MessageList + Composer**，丢掉：
Composer 里没发出的草稿、`MessageList` 的滚动位置（`MessageList.tsx:20-21`）、
以及 CodeBlock 的 `useId()` 身份。而 `TodosPanel` 一个回合内可以出现/消失好几次
（`TodosPanel.tsx:12` 空则 null，`:15` 全完成也 null）。

**正确形状**：`.main-body` 永远在，只条件渲染 `.rail` 子节点。

### 4.2 宽度策略（P0-5）

v1 的 `min(50%, 720px)` 实测把 1440 屏的正文列从 736px 压到 552px（-25%），**整篇对话重新换行**。

```css
.main-body { container-type: inline-size }
.rail { width: clamp(320px, 100cqw - 780px, 720px) }
.chat { min-width: 560px }
```

1440 屏上右栏约 404px，**正文列保住 736px 一格不动**。代价：宽屏上预览默认窄一点。

### 4.3 窄屏（P0-4）

**是 `@container` 不是 `@media`** —— 判据是 `.main-body` 的宽度，不是视口宽度，
且两者关系非单调（见 §0）。

```css
@container (max-width: 900px) { .main-body.has-rail .rail { /* 覆盖式 */ } }
```

**覆盖式必须是同一棵树只换 class**，绝不能写成 `narrow ? <Overlay><Rail/></Overlay> : <Rail/>` ——
跨断点那一刻 `PreviewFrame` 换位置 → `token` 重生（`PreviewFrame.tsx:65` 的 `useMemo(...,[])`）
→ 新 document → demo 归零。

**要写进 spec 的代价**：900px 阈值意味着只有视口 ≥ 1156px（900+256）才有并排视图。
1440 屏上开个不最大化的窗口就永远是覆盖式。
**另一个取舍**：覆盖式会盖住 Composer（实测 composer 盒子完全落在 `.chat` 内），即看预览时不能打字。

### 4.3.1 `@container` 规则**改不了容器自己**（PR2 实现期撞出来的，血的教训）

`.main-body` 自己带 `container-type: inline-size`，而容器查询匹配的是**祖先**容器。所以

```css
@container (max-width: 900px) { .main-body.rail-narrow { flex-direction: column } }   /* ✗ 永不命中 */
```

这条规则**永远不会生效**。PR2 第一版据此做「窄屏转顶部横带」，真浏览器里量出 `flexDirection`
仍是 `row`，右栏塌成一条 182px 竖条，把正文列从 726px 挤到 **612px** —— 直接违反 §4.2 的核心承诺。

**jsdom 完全看不见这个**（无布局、无容器查询），单测全绿。又一个「测试绿 ≠ 能用」的实例。

**结论**：任何想给 `.main-body` **自身**换布局的方案，都必须先把 `container-type` 挪到别的宿主。
评估过挪到 `.main`（宽度相同），但那会让 `.dirpick-pop` / `.model-pop-anchor` 这些 `position: fixed`
弹层以 `.main` 为包含块、整体偏移 256px —— 风险不值当。
PR2 因此改用「窄屏时待办/子代理回落正文列」的方案（见 §8）。

## 5. 面板结构

`PreviewFrame.tsx:178-181` 已有一条 `.preview-bar`（kind + 「收起预览」），
**不要再造 `.rail-head`**，否则两个关闭按钮。复用并扩展它。

### 5.1 高度模型要改（P1-2）

`PreviewFrame` 自适应内容高度：`useState(160)`（`:60`）→ 上报后钳到 `[80, 900]`（`:116`）→ `style={{height}}`（`:188`）。
塞进 `flex:1` 的右栏后，一个上报 50px 的计数器 demo 会变成 900px 高的栏里一个 80px 的框加 800px 空白，
**第一眼就是「做坏了」**。

做法：加 prop `fitMode: 'content' | 'fill'`；`fill` 时 iframe 走 `height:100%` + `flex:1`。
**不要删掉 guest 的 resize 上报通道** —— 它在 A1 里是刻意设计（避免同源读 `scrollHeight`，
而现在已经没有同源了），只是不再驱动布局。

### 5.2 ConsolePanel 需要提升（P1-3）
要让它和 iframe 成为兄弟节点，必须把 `entries` 提出 `PreviewFrame`（改成受控 prop）。
`PreviewFrame.test.tsx:45-64` 的 harness 会跟着动。

### 5.3 `.code-wrap:has(.preview)` 会静默失效（P1-6）
`styles.css:206-207`：
```css
/* 预览已展开时按钮常驻，否则鼠标一移开就找不到「停止」了。 */
.code-wrap:has(.preview) .code-run { opacity: 1; }
```
`.preview` 搬走后此选择器永不命中 → `.code-run` 退回 `opacity:0` + 只在 hover 显形，
注释里写明的那个体验问题原样回归。
做法：由 React 加 `.code-wrap.running`（右栏 store 说了算），CSS 改成 `.code-wrap.running .code-run`。

## 6. 拖拽（PR3，本 PR 不做）

若将来做，实现形状必须是「CSS 变量 + 直接写 DOM，不进 React state」：

```tsx
const move = (ev: PointerEvent) => {
  const w = clamp(bodyRef.current!.getBoundingClientRect().right - ev.clientX, MIN, MAX)
  bodyRef.current!.style.setProperty('--rail-w', w + 'px')   // ← 不 setState
}
```

**仓库里已有的先例是反面教材**：`ManageDrawer.tsx:231-238` 是 `useState<number>` + `style={{width}}`，
实现者极可能照抄。**不要抄它。**

注意：即便如此，拖拽期间 `PreviewFrame` 每帧仍会 setState —— guest 的 ResizeObserver
（`preamble.ts:71-72`）宽度一变就上报，父页 `:116` `setHeight`。所以「宽度不进 state」
买到的是「少一次父组件渲染」，不是「零渲染」。别拿它当性能护栏卖。

## 7. 测试

### 7.1 必须替换的空跑护栏（P0）
v1 §6 那条「拖动分栏后计数器还是 3」照现在写法**必然通过**。改成断言 **iframe 身份**：

```ts
const token = () => iframe.getAttribute('srcdoc').match(/var TOKEN = "([^"]+)"/)[1]
const before = token()
// …开关右栏、跨 900px 断点各一次…
expect(token()).toBe(before)        // 重挂必变（token 来自 useMemo(...,[]) + ++seq）
expect(await counterText()).toBe('3')  // 附加断言，不是主断言
```
token 是确定性的、不需要等待。**并做变异验证**：把覆盖式故意写成两棵子树，确认这条真的红。

### 7.2 其余
- **P0-1 锁**：右栏出现/消失后，Composer 的 draft 与 `.stream` 的 scrollTop 不变
- **P0-2 锁**：会话 A 开预览 → 切会话 B → 右栏为空
- **P0-3 锁**：进出分享模式后，run 不被顶掉
- `getSnapshot` 引用稳定（连续调用 `===`）
- 面板不挂载时不编译

### 7.3 两条会红的既有测试，**不许删**（P1-4）
`Markdown.test.tsx:51` 和 `:92` 用 `container.querySelector('iframe')!` —— 搬家后 iframe 不在
`<Markdown>` 的 container 里，`!` 断言炸 TypeError。

它们锁的是「`<pre>` 内联 ref detach → `code` 抖成空串 → 重编译」。搬到右栏后 `code` 是 store 快照，
**这条路径从架构上消失**。危险在于实现者会顺手删掉它们，**连带删掉 `Markdown.tsx:103` 的
`if (!el) return` 守卫 —— 那行对「复制」按钮仍然必要**。
做法：改写成同时挂载 `<Markdown>` + `<Rail>` 的 harness。

## 8. PR2 预告（待办/子代理搬家）

空态判据现在长在组件内部，**在 Shell 里复刻一份必然漂移**：
```
TodosPanel.tsx:12   if (!todos.length) return null
TodosPanel.tsx:15   if (done === todos.length) return null
AgentsPanel.tsx:71  if (!running) return null
```
`AgentsPanel` 的 `running` 还依赖 `currentTurn(messages)` 的切分和 collectAgents 的「后台派发跳过」规则 ——
这套逻辑刚因为「永久卡在 1 运行中」的真实故障重写过（`AgentsPanel.tsx:8-18`）。复刻 = 把那个故障请回来。

做法：导出 `hasVisibleTodos(todos)` / `runningAgentCount(messages, bg)`，**组件自己也用它**，
加一条「谓词与组件渲染结果一致」的测试。

另需表态：`Shell.tsx:263` 有 `mainView === 'cron'` 的独立分支，右栏在 cron 视图下显不显示。
以及窄屏下待办会被藏进覆盖层 —— 恰好抹掉「环境感知」这个搬家理由。

## 9. 其它已知项

- `__resetActivePreview()` 会 `listeners.clear()`（`activePreview.ts:47`）。右栏成为长驻订阅者后，
  `afterEach` 里调它又跨用例复用挂载会静默断掉通知 → 假绿。改成只重置 state 不清 listeners。
- `.backdrop` 是 `z-index:20`、`.sidebar` 是 `30`，右栏无 z-index → 侧栏抽屉打开时右栏被蒙层压住。
  行为可接受（抽屉是模态），但要有意识地选。
- 右栏出现/消失会**重排整篇对话**。建议一旦本回合出现就保持占位到回合结束（空则渲染收起态）。
  §4.2 的 `clamp` 已让默认宽度下正文列不变，这条是补充保险。
