# A1 — 代码预览运行时（浏览器侧）设计

> **日期**: 2026-08-06
> **程序**: 代码沙箱 / 可运行 artifact。本文只覆盖 **A1（浏览器 iframe 内跑前端渲染类产物）**；
> Python/Java 走 server 子进程，是独立的 **A2**。
> **前置调研**: 已完成（体积实测、上游实现勘察、维护状态核查），结论内联在下文各处。

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
| Vue SFC 编译 | **`vue/compiler-sfc` 浏览器构建**（随 `vue@~3.5` 带入） | **374 KB** | `vue3-sfc-loader` = 487 KB **且**最后发版 2024-02、锁死 3.4 编译器 |

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
- 只在**代码围栏闭合后**才触发编译，并加防抖。

## 5. 安全立场：**明确地不做隔离**

`srcdoc` 文档继承父页面 origin。同时给 `allow-scripts` 与 `allow-same-origin`，guest 就能拿到 `parent.document` → 找到自己那个 `<iframe>` → **删掉 `sandbox` 属性** → reload → 解放自己。MDN 原文：*"it is **strongly discouraged** to use both... making it **no more secure than not using the `sandbox` attribute at all**."*

**本设计明知故用**（Vue 官方 REPL 亦然），理由：

1. zuse 的 `BashTool` 本来就能在本机执行任意命令。浏览器沙箱挡不住任何本来挡得住的东西，只会挡住**功能**。
2. 真隔离的唯一办法是**独立 origin**（daemon 另开一个端口专供预览）。那要重做 daemon 表面积、配置与认证边界，代价与收益严重不匹配。

**约束**：`PreviewFrame.tsx` 里**必须**写死一段注释说明这是有意选择。否则将来某次"安全加固"摘掉 `allow-same-origin`，会连带炸掉一堆依赖同源的东西。

**CSP 的连带事实**：仓库当前**没有任何 `Content-Security-Policy`**（已 grep 核实），所以 srcdoc 预览今天直接可用。但只要有人给 daemon 加上 `script-src 'self'`，所有预览会瞬间全挂 —— guest 的 preamble 是 inline script，而 srcdoc 文档**继承嵌入方的 CSP**。故记一条约束：**加 CSP 前必须先把预览改成独立 URL**。

## 6. 明确不支持（写清楚，不含糊）

- ❌ **`import` 任意 npm 包**。只有一张固定 import map：`vue`、`react`、`react-dom`、`react-dom/client`、`react/jsx-runtime`。其他裸包名 → **明确报错** `package "X" is not available in preview`，不静默失败。
- ❌ 多文件工程、产物之间互相 import（上游 `moduleCompiler.ts` 那 300 行，砍掉）
- ❌ `<style lang="scss|less">`、`<template lang="pug">`（浏览器里没预处理器）
- ❌ `<style module>`（CSS Modules）
- ❌ **Vue JSX**（需 `@vue/babel-plugin-jsx` → 把 Babel 拖回来，上游为此单独懒加载了一个 6.81 MB 的 chunk）
- ❌ decorators、`const enum` 等 sucrase 覆盖不到的语法
- ❌ 真正的安全隔离（§5，有意为之）

## 7. 已知陷阱（调研实测踩过，照此避开）

| # | 陷阱 | 对策 |
|---|---|---|
| 1 | **iframe 自适应高度会把设计锁死在 `allow-same-origin` 上**。读 `iframe.contentDocument.body.scrollHeight` 要求同源 | 从第一天起就在 **guest 内部**挂 `ResizeObserver` 把高度 postMessage 出来。这样"要不要真沙箱"始终是可后悔的决策 |
| 2 | **`postMessage` 的 `DataCloneError` 会静默打死日志桥**。`console.log(组件实例)`、循环引用对象都无法结构化克隆，而错误抛在被 patch 的 `console.log` 里 —— 现象是「日志面板从某行之后就不动了」，极难定位 | 每个 postMessage 包 try/catch，降级为 `args.map(toString)`；`toString` 依次尝试 `String` → `Object.prototype.toString.call` → `typeof`；对框架代理对象专门识别替换 |
| 3 | **流式输出导致 iframe 疯狂重建** | 见 §4：iframe 只绑 import map，代码走 eval |
| 4 | **`compiler-sfc.esm-browser.js` 没有 minified 版本**（实测该包 dist 只有 `.cjs.js` 与 `.esm-browser.js`，无 `.prod` 变体）。从 CDN 直引 = 传 1.65 MB 未压缩源码 | 走 `import('vue/compiler-sfc')` 让 Vite 打包压缩进独立 async chunk。**连带**：浏览器版内联的 postcss 会报 `pathToFileURL` 相关错误，上游显式忽略这类错误 —— 上线第一天就会撞上 |
| 5 | **有 `<script setup>` 时绝不能再调 `compileTemplate`**。`compileScript(descriptor, {inlineTemplate:true})` 已把 render 内联进去，再拼一次会得到双 render 的破组件（有时渲染两遍、有时白屏） | 守卫：`if (descriptor.template && (!descriptor.scriptSetup || inlineTemplate === false))` |
| 5b | **scoped CSS 会静默失效**：需手动追加 `__sfc__.__scopeId = "data-v-" + id`，**且**把**同一个 id** 传给 `compileStyleAsync({scoped:true, id})`。两处 id 不一致 → 样式注入了、选择器一个都匹配不上、**零报错** | id 用文件名/内容的稳定哈希，单点生成、两处共用 |
| 6 | **React 19 不发布任何浏览器可直接加载的构建**。实测 `packages/web` 解析到 react **19.2.7**，无 `umd/`、无 esm-browser（`node_modules` 里那个带 umd 的是 18.3.1，属别的包的依赖树） | 构建时加一个额外 rollup entry 产出 ESM bundle 到 `dist/preview-vendor/`。**Vue 相反** —— `vue.esm-browser.prod.js` 开箱即用，直接拷贝。**两个框架不能共用同一套 vendor 流程** |
| 7 | 编译器与运行时版本漂移 | `@vue/compiler-sfc` 与自托管的 `vue.esm-browser.prod.js` 必须出自**同一个** `vue` 依赖，别一个走 CDN 一个走 npm。先钉 `~3.5` |

## 8. 分两个 PR

iframe 生命周期 + postMessage 桥 + console/错误捕获 + preamble 这套管线**所有语言共用，且占工作量约 80%**。

- **PR1 — 管线 + HTML/JS/JSX/TSX**。新增依赖仅 sucrase（46 KB）。管线打磨稳，且本周就有东西可用可测。
- **PR2 — 接 Vue SFC**。插入 `compile/vue.ts`，新增 `vue` 依赖与 vendor 产物。

拆 PR 不牺牲最终能力，只是把可用时间提前。

## 9. 测试策略

浏览器行为难以在 node 环境完整模拟，所以分层，**不假装 jsdom 能测 iframe**：

| 层 | 测什么 | 怎么测 |
|---|---|---|
| 纯函数 | `detect()` 的判定、import map 生成、`toString` 降级链 | vitest（jsdom），确定性 |
| 编译 | sucrase / compiler-sfc 的产物形状；`<script setup>` 时**不得**二次 `compileTemplate`；scoped id 两处一致；不支持语法返回可读 errors | vitest，断言产物字符串特征 |
| 端到端 | 真跑一段 HTML/JSX/Vue，看渲染结果与 console 捕获 | Playwright（仓库已有 web 端 E2E 惯例） |

**如实声明**：§5 的安全立场使得"沙箱有效性"无法也不该被测试——它本来就不隔离。不写伪装成安全测试的东西。

## 10. 非目标

- 不做 A2（Python/Java 子进程执行）——独立 spec。
- 不做产物持久化/分享（那是 artifact 管理，另一件事）。
- 不做 npm 包按需拉取（§6）。
- 不改 `packages/tui`（TUI 没有渲染 HTML 的能力，本特性是 Web 专属）。
