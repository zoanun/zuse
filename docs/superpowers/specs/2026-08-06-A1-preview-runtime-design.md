# A1 — 代码预览运行时（浏览器侧）设计

> **日期**: 2026-08-06
> **程序**: 代码沙箱 / 可运行 artifact。本文只覆盖 **A1（浏览器 iframe 内跑前端渲染类产物）**；
> Python/Java 走 server 子进程，是独立的 **A2**。
> **前置调研**: 已完成（体积实测、上游实现勘察、维护状态核查），结论内联在下文各处。
> **评审**: 已经独立子代理评审一轮（新开，非做调研那个）。它复测了全部体积数据（误差 <1%）、
> 用真浏览器验证了 iframe 自解沙箱与 CSP 继承、实证了 sucrase 的真实行为。9 条 findings 全部采纳，
> 其中 4 条会直接导致返工或写不出代码（§4.1 流式信号无来源、§2.3 JSX runtime 选错、§8.1 接口需按 PR2 定形、§9 Playwright 基建不存在）。本文为修订版。

---

## 1. 目标与范围

模型写出的前端代码，用户点一下就能看到**跑起来的样子**，而不是只看到一段文本。

**A1 覆盖**：HTML/CSS/JS、JSX/TSX、Vue SFC。
**A1 不覆盖**：Python、Java（→ A2，server 子进程）。

### 1.1 为什么不是「照抄 Claude Artifacts」

Claude Artifacts 必须把一切塞进浏览器沙箱，因为它跑在**别人的服务器**上。zuse 跑在用户自己机器上，且 `BashTool` 本来就能执行任意命令。这条差异贯穿整个设计：

- **Python/Java 不用 Pyodide/WASM**，直接起子进程（A2）——不新增任何攻击面，还能用上本机真实工具链。
- **iframe 不追求真隔离**（见 §5），因为它挡不住任何本来挡得住的东西。

## 2. 技术选型（全部有实测数据支撑）

体积均为实测（jsdelivr 下载 + `gzip -9`），版本为 2026-08-06 的 npm latest。

| 用途 | 选定 | gzip | 落选项与理由 |
|---|---|---|---|
| TS / JSX / TSX 转译 | **sucrase 3.35.1** | **46 KB** | `@babel/standalone` 8.0.4 = **551 KB**（重 12 倍）；`esbuild-wasm` = **3.54 MB**；`@swc/wasm-web` 更大 |
| Vue SFC 编译 | **`vue/compiler-sfc` 浏览器构建**（随 `vue@~3.5` 带入） | **374 KB** | `vue3-sfc-loader` = 487 KB **且**最后发版 2024-02、预构建 dist 里 bake 了 3.4.15 编译器 |

> 上表六条体积均经**两个独立子代理各自下载复测**，误差 <1%，可以信。

### 2.0 vue3-sfc-loader 的落选理由（订正 + 实证）

初稿写「锁死 `@vue/compiler-sfc ^3.4`」**不准确**：manifest 是 `^3.4.15`，caret 不是锁，实测 `npm i vue3-sfc-loader@0.9.5` 解析到的是 3.5.41。真正的问题在**预构建 dist**——评审在下载的 `vue3-sfc-loader.esm.js` 里 grep 到硬编码 `version="3.4.15"`。两条消费路径要分清。

初稿还推测它「会误编译 Vue 3.5 已转正的 reactive props destructure」——**当时那只是推理**。评审做了实证，同一段 `const { msg = 'hi' } = defineProps<{msg?:string}>()`：

- 3.5.41 → `props:{msg:{type:String,required:false,default:'hi'}}`，render 用 `__props.msg`。**正确**。
- 3.4.15 → `props:{msg:{type:String,required:false}}` —— **default 被丢弃**，setup 退化成 `const { msg='hi' } = __props`，而 render 引用 `_ctx.msg`。不传 msg 时渲染空字符串而非 `'hi'`，**且零报错**。

这类"静默给出错误结果"是最难排查的一种。落选成立，理由现在是实证的。

### 2.3 JSX runtime：必须显式选 `automatic + production`

实测 sucrase 3.35.1 三种模式的输出（这条决定 import map 的内容，选错会大面积挂）：

| 模式 | 首行输出 | 后果 |
|---|---|---|
| 默认 `classic` | `React.createElement('div', {__self: this, __source: {...}}, "hi")` | **要求 guest 作用域里有 `React` 绑定**。模型写 JSX 常不写 `import React`（React 17+ 起就不需要了）→ `React is not defined` |
| `automatic` | `import {jsxDEV as _jsxDEV} from "react/jsx-dev-runtime"` | 走的是 **`jsx-dev-runtime`**，不是 `jsx-runtime`。import map 里没有它 → 解析失败 |
| **`automatic` + `production: true`** | `import {jsx as _jsx} from "react/jsx-runtime"` | ✅ 干净；无 `__self`/`__source` 噪音；正是 map 里已有的那一项 |

**定死：`{ transforms: ['typescript','jsx'], jsxRuntime: 'automatic', production: true }`。** 这同时决定了 vendor 构建的 entry 清单只需 `react/jsx-runtime`，不需 `jsx-dev-runtime`。

### 2.4 Vue 运行时构建的取舍

因为走 `inlineTemplate: true` 预编译，guest **不需要** template 编译器。实测：

- `vue.esm-browser.prod.js` = 62,338 B gzip
- `vue.runtime.esm-browser.prod.js` = **41,285 B gzip**（省 ~21 KB）

**选 runtime-only**。代价：模型偶尔写 `{ template: '...' }` 字符串选项的组件会挂。判断依据是这种写法在 SFC 语境下极罕见（SFC 的模板在 `<template>` 块里，走编译期），而 21 KB 是每次预览都要付的。挂掉时 guest 会报明确的运行时错误，不是静默错误。

### 2.1 关于 Babel standalone「不推荐生产」

官方文档原文写的是：*"not recommended for production use... **Valid use cases include** ... **real-time compilation for sites like JSFiddle**"* —— A1 正是它点名认可的用法。**所以排除它的理由不是那句话，纯粹是 551 KB vs 46 KB。**

sucrase 的真实代价：它不是规范完备的编译器，只做语法制导转换、不做语法降级，不支持 `const enum`、decorators、部分 TS 边角。Vue 核心团队在自己的 REPL 里接受了这套 tradeoff，本地单用户场景更该接受。

### 2.2 Vue：为什么必须用 374 KB 的完整编译器，不能退到 59 KB 的全局构建

这是本设计最容易被"优化"掉、但绝不能退的一条。

`vue.global.prod.js`（59 KB）只打包了 `@vue/compiler-dom`，它能编译 **template 字符串**，但**完全不支持 `<script setup>`** —— 后者不是运行时特性，是 `@vue/compiler-sfc` 的 `compileScript()` 做的**编译期转换**。全局构建里连 SFC 解析器都没有，看不懂 `<template>/<script>/<style>` 这个文件结构。它同样不支持 `<style scoped>`（无 `__scopeId` 生成）和 TypeScript。

而 2026 年任何 LLM 写 Vue，产出几乎必然是 `<script setup>` + `<style scoped>`。走窄路线的结果是**绝大多数 Vue 产物直接渲染失败**，且失败信息晦涩，用户会认定这功能是坏的。374 KB 走懒加载分包，在 localhost 场景成本近似为零。

**上游参考**：`play.vuejs.org` 用的就是这条路（`@vue/repl@4.7.2`，零 runtime 依赖）。其 `src/transform.ts`（409 行）是本设计编译管线的直接蓝本。

## 3. 架构

```
packages/web/src/preview/
  types.ts            PreviewSpec / CompileResult
  detect.ts           代码块 → 可否预览 + 何种 kind
  compile/index.ts    compile(spec) —— 全部 await import(...) 懒加载
  compile/script.ts   sucrase：TS/JSX/TSX → JS
  compile/vue.ts      vue/compiler-sfc：SFC → JS + CSS
  runtime/shell.html  ?raw；iframe 文档骨架，含 import map 与 preamble 占位
  runtime/preamble.ts ?raw；guest 侧注入脚本（console 桥 / 错误捕获 / 高度上报 / eval 收信）
  runtime/importmap.ts 固定映射表
  PreviewProxy.ts     父子 postMessage RPC
  PreviewFrame.tsx    iframe 宿主与生命周期
  ConsolePanel.tsx    日志 / 运行时错误 / 编译错误展示
```

**接线点**：[`Markdown.tsx`](../../../packages/web/src/components/Markdown.tsx) 的 `CodeBlock` 已经在给每个 fenced code block 包一层带「复制」按钮的外壳（`.code-wrap`）。「运行」按钮长在同一处，与「复制」并列。**不新建平行的渲染路径。**

**语言从哪来（评审 D5，初稿没交代而现有代码恰好拿不到）**：react-markdown v9 传给 `pre` 组件的 props 里 `className` 为 **null**，除 `children`/`node` 外没有任何自有 prop。语言只存在于

```
props.node.children[0].properties.className === ["hljs", "language-jsx"]
```

而现有签名 `CodeBlock({ node, ...rest })` 正好把 `node` 解构后**丢弃**。所以 `detect()` 的入参必须是 `node`，实现时要改这个签名并保留 `node`。

**不会污染导出路径**：`packages/web/src/state/exportChat.tsx` 是另一处独立的 `ReactMarkdown` 调用且**不传 `components`**，所以加运行按钮不会影响导出/分享出去的内容。

### 3.1 数据流

```
fenced code block ──detect──► PreviewSpec{kind, code}
                                    │
                              compile(spec)            ← 懒加载 sucrase / compiler-sfc
                                    │
                          CompileResult{js, css, errors}
                                    │
              ┌─────────────────────┴──────────────────┐
        errors 非空                                 errors 为空
              │                                          │
        ConsolePanel 显示编译错误        PreviewProxy.eval(js, css) → iframe
                                                         │
                                        guest 的 preamble ──postMessage──► ConsolePanel
                                        （console.* / onerror / unhandledrejection / resize）
```

## 4. iframe 生命周期：**只绑 import map，不绑代码**

这是性能与体验的关键，也是最容易写错的地方。

模型是**逐 token 吐代码**的。若在 `code` 变化时重建 `srcdoc`，一个 200 行组件会触发几百次 iframe 销毁重建 —— 闪屏、丢状态、CPU 拉满。而且 **`srcdoc` 一改就必然销毁整个 document，没有 HMR**。

所以：

- **iframe 只在 import map 变化时重建**（几乎不变）。
- **代码更新走 `postMessage({action:'eval', js, css})`**，往同一个 document 里注入新的 `<script type="module">`。
- 只在**代码围栏闭合后**才触发编译，并加防抖（`COMPILE_DEBOUNCE_MS`，120ms）。
- **iframe 也不绑 `theme`**（2026-08-07 补）。主题有独立的 postMessage 通道，把它塞进 `srcdoc` 的依赖里 = 切一次主题就换一个 document，demo 状态全丢。初版正是这么写的，配上「不重放产物」直接变成「切主题后预览永久空白且零报错」。
- **`ready` 到达时统一重放**最近一次 eval 与最近一次 theme。新 document 不可能知道上一轮 eval 过什么；只在「编译完成」那一刻下发是错的。原来那个「单槽 `pendingRef` 缓冲」不行：只存得下一条消息，eval 与 theme 会互相覆盖并静默丢失。
- **编译 effect 的依赖必须是 `spec.kind` / `spec.code` 两个原始值，不能是 `spec` 对象**。调用方每次渲染都新建 `{kind, code}` 字面量 —— 依赖对象身份的话，点一下代码块的「复制」按钮就会把整个 demo 重跑一遍、控制台清空（实测：计数器从 3 归 0，1.5 秒后再来一遍）。

### 4.1 「围栏是否闭合」这个信号从哪来（评审 D1，初稿的硬伤）

初稿把「围栏闭合后才编译」当成关键约束，却**没说这个信息从哪取** —— 而评审实测发现：**在选定的接线点上根本观测不到**。未闭合的 ` ```vue ` 围栏，react-markdown 照样渲染成结构完全相同的 `<pre>` 且带 `language-vue`，`CodeBlock` 内部无法区分「已闭合」与「还在流式吐」。

**定死的数据通路**：由 `Message` 组件（它已 memo，且持有本条消息是否仍在流式的信息）经 **props/context 下传 `isStreaming`** 到 `Markdown` → `CodeBlock`。运行按钮在 `isStreaming` 为真时**禁用**（而不是隐藏——隐藏会导致按钮在流式结束瞬间跳出来，布局抖动）。

不写进 spec 的话，实现阶段会在这里现场发明一个错误方案（比如去数反引号，或用防抖赌"应该吐完了"）。

## 5. 安全立场：**摘掉 `allow-same-origin`**（2026-08-07 订正，原立场是错的）

`srcdoc` 文档继承父页面 origin。同时给 `allow-scripts` 与 `allow-same-origin`，guest 就能拿到 `parent.document` → 找到自己那个 `<iframe>` → **删掉 `sandbox` 属性** → reload → 解放自己。MDN 原文：*"it is **strongly discouraged** to use both... making it **no more secure than not using the `sandbox` attribute at all**."*

初稿据此判定「反正挡不住，不如给功能让路」，并写下理由 1：

> ~~zuse 的 `BashTool` 本来就能在本机执行任意命令。浏览器沙箱挡不住任何本来挡得住的东西，只会挡住**功能**。~~

**这条理由是事实错误。** `BashTool` 的每一次执行都要过 `canUseTool` 权限提示；同源 iframe 里的 `fetch` **不用**。两者的威胁模型根本不同 —— 沙箱挡住的正是 **「绕过权限提示的无人值守提权」**，那恰恰是它挡得住、也值得挡的东西。

独立评审在**真浏览器**里实测确认（预览里的代码，零权限提示）：

| 调用 | 结果 |
|---|---|
| `GET /api/sessions` | **200**，返回全部会话的真实内容 |
| `PUT /api/files/content` | 已认证，可改本机任意文件 |
| `POST /api/mcp` | 已认证，可注册一个 **command 任意**的 stdio server —— 下次 daemon 重启即执行 |

一段模型生成的（或从网上复制的）代码块，用户点一下「运行」就够了。

**现立场**：`SANDBOX_TOKENS` **不含 `allow-same-origin`**，guest 跑在 opaque origin(`"null"`)上。

摘掉之后实测**唯一**坏掉的东西是 vendor 模块的 CORS：

```
Access to script at 'http://127.0.0.1:4180/preview-vendor/react.js' from origin 'null'
has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present
```

**对策**：`packages/server/src/http/server.ts` 里**只**给 `/preview-vendor/*` 这一条静态路由加 `Access-Control-Allow-Origin: *`。那里放的是我们自己构建的静态 JS，无凭据、无用户数据。**绝不加 `Access-Control-Allow-Credentials`，绝不扩到 `/api/*`** —— 那等于把上表三条洞原样还回去。

高度上报（guest 内 `ResizeObserver`，见陷阱 1）与 postMessage 桥（`targetOrigin:'*'` + `event.source` + token 鉴别，见陷阱 8）本来就不依赖同源，不受影响。

**约束**：配一条断言 `allow-same-origin` **不存在**的测试（`PreviewFrame.test.tsx`）。**这条是真的安全测试**，不再是防误改测试 —— 注释拦不住手快的人，断言可以。

**残留风险（如实记录）**：opaque origin 只挡住「带着父页凭据打已认证 API」。guest 仍能访问公网（§6.5 的决定：不拦网络），所以它仍可以把 `postMessage` 拿到的数据外传，或对 `127.0.0.1` 的其它端口做无凭据探测。要彻底隔离仍然只有「独立 origin + 独立端口」一条路，那笔账没变（要重做 daemon 表面积、配置与认证边界），本轮不做。

**CSP 的连带事实**：仓库当前**没有任何 `Content-Security-Policy`**（已 grep 核实），所以 srcdoc 预览今天直接可用。但只要有人给 daemon 加上 `script-src 'self'`，所有预览会瞬间全挂 —— guest 的 preamble 是 inline script，而 srcdoc 文档**继承嵌入方的 CSP**。故记一条约束：**加 CSP 前必须先把预览改成独立 URL**。

## 6. 明确不支持（写清楚，不含糊）

- ❌ **`import` 任意 npm 包**。只有一张固定 import map：`vue`、`react`、`react-dom`、`react-dom/client`、`react/jsx-runtime`（**不含** `jsx-dev-runtime`，见 §2.3）。其他裸包名会在 guest 里抛模块解析错误，由 preamble 捕获后在 ConsolePanel 里展示 —— 我们**额外**在编译阶段扫一遍 import 说明符，命中未知裸包名时给一条更可读的提示 `package "X" is not available in preview`。两条路都有，因为编译期扫描不可能覆盖动态 `import()`。
- ❌ 多文件工程、产物之间互相 import（上游 `moduleCompiler.ts` 那 300 行，砍掉）
- ❌ `<style lang="scss|less">`、`<template lang="pug">`（浏览器里没预处理器）
- ❌ `<style module>`（CSS Modules）
- ❌ **Vue JSX**（需 `@vue/babel-plugin-jsx` → 把 Babel 拖回来，上游为此单独懒加载了一个 6.81 MB 的 chunk）
- ⚠️ decorators、`const enum` 等 sucrase 覆盖不到的语法 —— **措辞订正（评审 D3）**：初稿说这些会「明确报错」，**是错的**。实测 sucrase 3.35.1 对 `@dec class A {}` **原样输出、不抛异常**（`const enum` 则被编成普通 enum IIFE）。真正报错的是浏览器：Chrome 对该输出报 `SyntaxError`。所以准确说法是「**不保证支持，表现为 guest 侧运行时错误**」，由 preamble 捕获后归因展示 —— 而不是编译期拦截。
- ❌ **`localStorage` / `sessionStorage`**。guest 跑在 opaque origin 上（§5），碰这两个 API 会抛 `SecurityError`。这是**响亮失败**（错误由 preamble 捕获、在 ConsolePanel 里可见），不是静默失效 —— 所以只需在这里写明，不必额外做垫片。要在 demo 里存状态就用内存变量。
- ❌ 真正的安全隔离（§5 摘掉 `allow-same-origin` 之后挡住了「免权限提示打已认证 API」这一类，但**不是**完整隔离 —— 残留风险见 §5 末尾）

**待定（产品判断，尚未决策）**：Vue SFC 的 **CSS 语法错**目前直接**否决整次预览**（`js` 置空、组件根本不渲染）。合理的替代是降级成 warning、照常渲染组件 —— 一个分号写错就整个白屏，对「看一眼」的用途未必划算。两种都说得通，等有真实使用反馈再定。（错误文本本身已经洗掉 ANSI 色码与构建机绝对路径，见 `compile/vue.ts` 的 `cleanErrorText`。）

## 6.5 UI 与生命周期（评审 D7：初稿整块缺失）

| 问题 | 决定 | 理由 |
|---|---|---|
| **预览放哪** | 代码块**就地展开**在 `.code-wrap` 下方，不进 `ManageDrawer` | 预览与代码要能对照着看；抽屉是"管理某类资源"的语义，预览不是资源 |
| **同时多个预览** | **全局单例，同一时刻只有一个预览是活的**；点另一个代码块的运行按钮 → 前一个收起 | 每个活预览 = 一个 iframe + 一份懒加载编译器。允许 N 个等于允许 N 份 374 KB 编译器同时驻留，且互相抢 CPU |
| **切会话 / 刷新** | 一律销毁，不恢复 | 与 §10「不做产物持久化」一致。预览是"看一眼"，不是工作产物 |
| **深色模式** | 父页面在 iframe ready 后 postMessage 下发 theme，并在 `data-theme` 变化时补发 | guest 是**独立 document**，不会继承 `<html data-theme>`；仓库的 `src/theme.ts` 用 MutationObserver 盯根元素，那套完全够不到 iframe 里。不下发的话，浅色主题下用户会看到一块刺眼的白 |
| **guest 的网络请求** | 不拦 | 与 §5 的安全立场一致 —— 既然不做隔离，拦网络只是装样子。模型写的 demo 常要 fetch 一个公开 API，拦了就废了一半用例 |

## 7. 已知陷阱（调研实测踩过，照此避开）

| # | 陷阱 | 对策 |
|---|---|---|
| 1 | **iframe 自适应高度会把设计锁死在 `allow-same-origin` 上**。读 `iframe.contentDocument.body.scrollHeight` 要求同源 | 从第一天起就在 **guest 内部**挂 `ResizeObserver` 把高度 postMessage 出来。这样"要不要真沙箱"始终是可后悔的决策 |
| 2 | **`postMessage` 的 `DataCloneError` 会静默打死日志桥**。`console.log(组件实例)`、循环引用对象都无法结构化克隆，而错误抛在被 patch 的 `console.log` 里 —— 现象是「日志面板从某行之后就不动了」，极难定位 | 每个 postMessage 包 try/catch，降级为 `args.map(toString)`；`toString` 依次尝试 `String` → `Object.prototype.toString.call` → `typeof`；对框架代理对象专门识别替换 |
| 3 | **流式输出导致 iframe 疯狂重建** | 见 §4：iframe 只绑 import map，代码走 eval |
| 4 | **`compiler-sfc.esm-browser.js` 没有 minified 版本**（实测该包 dist 只有 `.cjs.js` 与 `.esm-browser.js`，无 `.prod` 变体）。从 CDN 直引 = 传 1.65 MB 未压缩源码 | 走 `import('vue/compiler-sfc')` 让 Vite 打包压缩进独立 async chunk。**连带**：浏览器版内联的 postcss 会报 `pathToFileURL` 相关错误，上游显式忽略这类错误 —— 上线第一天就会撞上 |
| 5 | **有 `<script setup>` 时绝不能再调 `compileTemplate`**。`compileScript(descriptor, {inlineTemplate:true})` 已把 render 内联进去，再拼一次会得到双 render 的破组件（有时渲染两遍、有时白屏） | 守卫：`if (descriptor.template && (!descriptor.scriptSetup || inlineTemplate === false))` |
| 5b | **scoped CSS 会静默失效**：需手动追加 `__sfc__.__scopeId = "data-v-" + id`，**且**把**同一个 id** 传给 `compileStyleAsync({scoped:true, id})`。两处 id 不一致 → 样式注入了、选择器一个都匹配不上、**零报错** | id 用文件名/内容的稳定哈希，单点生成、两处共用 |
| 6 | **React 19 不发布任何浏览器可直接加载的构建**。实测 `packages/web` 解析到 react **19.2.7**，无 `umd/`、无 esm-browser（`node_modules` 里那个带 umd 的是 18.3.1，属别的包的依赖树） | 构建时加一个额外 entry 产出 ESM bundle 到 **`public/preview-vendor/`**。**Vue 相反** —— `vue.esm-browser.prod.js` 开箱即用，直接拷贝。**两个框架不能共用同一套 vendor 流程** |
| 9 | **vendor 产物落 `dist/` 的话 `pnpm dev` 下全是 404**（vite dev 服务 `public/`，不服务 `dist/`），而**模块级 import 失败在 guest 里完全不可见** —— 实测 `window.onerror`、`unhandledrejection` 都不触发，`script.onerror` 也不可靠。现象是预览一片空白 + 控制台零输出 | ① 产物改出到 `public/preview-vendor/`，且 vendor 构建串在 `vite build`/`vite` **之前**（dev 与 build 都吃得到）；② preamble 在注入的模块体最前面写一个 `window.__zuseRan = runId` 报到标记，`MODULE_START_TIMEOUT_MS`(3s) 内没报到就发一条指名 `/preview-vendor/*` 的错误 —— 静默空白变成响亮失败 |
| 7 | 编译器与运行时版本漂移 | `@vue/compiler-sfc` 与自托管的 `vue.runtime.esm-browser.prod.js` 必须出自**同一个** `vue` 依赖，别一个走 CDN 一个走 npm。先钉 `~3.5` |
| 8 | **srcdoc 里 `location.origin` 恒为字符串 `"null"`**（评审真浏览器实测）。即使给了 `allow-same-origin`、能摸到 `parent.document`，它**仍然**是 `"null"`，`location.href` 是 `about:srcdoc` | preamble 里**绝不能**用 `location.origin` 做同源判断。父页鉴别消息只认 `event.source === iframe.contentWindow` + 每次预览随机生成的 token；guest 回信一律 `targetOrigin: '*'`（opaque origin 下没有别的值能匹配） |

## 8. 分两个 PR

iframe 生命周期 + postMessage 桥 + console/错误捕获 + preamble 这套管线**所有语言共用，且占工作量约 80%**。

- **PR1 — 管线 + HTML/JS/JSX/TSX**。新增依赖仅 sucrase（46 KB）。管线打磨稳，且本周就有东西可用可测。
- **PR2 — 接 Vue SFC**。插入 `compile/vue.ts`，新增 `vue` 依赖与 vendor 产物。

### 8.1 PR1 必须按 PR2 的形状先定接口（评审 D6）

拆 PR 合理，但有两处**真实的返工风险**，都必须在 PR1 就定对：

1. **`CompileResult` 的 css 字段**。对 HTML/JSX，一段 css 字符串就够；但 Vue 要求 scoped id 在 `compileScript` 与 `compileStyleAsync` 之间共享、还要注入 `__scopeId`（见陷阱 5b）。若 PR1 把 css 定成 `string`，PR2 必然改签名。
   **定死**：`styles: Array<{ code: string; scopeId?: string }>`，PR1 里就是长度 0 或 1 的数组。

2. **vendor 构建流程**。陷阱 6 已说明「两个框架不能共用同一套 vendor 流程」（React 19 无浏览器构建须自己 bundle，Vue 有现成产物只需拷贝），而 `packages/web/vite.config.ts` **当前完全没有 `build.rollupOptions`**（已核实，零命中）。PR1 要凭空建这套流程却只有 React 一个消费者，极易建成 React 专用形状。
   **定死**：vendor 产出写成**入口清单驱动**——一张 `{ 包名 → 来源(bundle | copy) }` 的表，PR1 表里只有 React 相关项，PR2 追加 Vue 的 copy 项，**不改流程本体**。

## 9. 测试策略

浏览器行为难以在 node 环境完整模拟，所以分层，**不假装 jsdom 能测 iframe**：

| 层 | 测什么 | 怎么测 |
|---|---|---|
| 纯函数 | `detect()` 从 `node` 里取语言的判定、import map 生成、`toString` 降级链 | vitest（jsdom），确定性 |
| 编译 | sucrase 输出必须走 `react/jsx-runtime`（§2.3，选错 runtime 会大面积挂，值得钉死）；`<script setup>` 时**不得**二次 `compileTemplate`；scoped id 两处一致 | vitest，断言产物字符串特征 |
| 安全 | `PreviewFrame` 的 sandbox 属性**不含** `allow-same-origin`（含 `allow-scripts`）；server 只给 `/preview-vendor/*` 加 CORS，`/api/*` 与其它静态资源都不加、且从不带 `Allow-Credentials` | vitest + RTL / node http。**这是真的安全测试**（2026-08-07 与 §5 一起订正 —— 初稿写的是「同时含两个 token 的防误改测试」，方向反了） |
| 生命周期 | ① document 重建（再次收到 `ready`）后必须重放最近一次 eval；② 切主题不重建 document；③ 内容不变的重渲染不得重新下发 eval；④ 编译有防抖 | vitest + jsdom。用假 `contentWindow` 收父页→guest 的 postMessage，token 从 srcdoc 里的 preamble 源码回读。①③ 各自对应一个「测试全绿但真跑是空白 / demo 被重置」的真实缺陷 |
| 端到端 | 真跑一段 HTML/JSX/Vue，看渲染结果与 console 捕获 | **agent 手工 smoke（照 `/ship` 的既有做法，用 Playwright MCP）** |

**订正一条初稿的错误陈述（评审 D2）**：初稿说端到端走「Playwright（仓库已有 web 端 E2E 惯例）」——**仓库根本没有这套基建**。已核实：全仓 package.json 零 playwright 依赖、无 `playwright.config.*`、无 `e2e/` 目录、**连 `.github/workflows` 都不存在**（没有 CI）。唯一的"惯例"是 `.claude/skills/ship/SKILL.md` 规定的「web 改动时由 agent 用 Playwright MCP 手工 smoke」——那是一次性人工验证，**不是可提交、可回归的测试**。

本 spec **不**把「引入 playwright + config + npm script」纳入范围：那是一项独立的基建工作，应该单独立项并承认其成本，塞进一个功能 spec 里会让两件事都做不好。A1 的端到端就照 `/ship` 手工 smoke，并如实承认这一层没有自动回归。

**另如实声明**：§5 的安全立场使得"沙箱有效性"无法也不该被测试——它本来就不隔离。不写伪装成安全测试的东西。

## 10. 非目标

- 不做 A2（Python/Java 子进程执行）——独立 spec。
- 不做产物持久化/分享（那是 artifact 管理，另一件事）。
- 不做 npm 包按需拉取（§6）。
- 不改 `packages/tui`（TUI 没有渲染 HTML 的能力，本特性是 Web 专属）。
