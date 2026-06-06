# WebFetch 工具设计（Phase 6.5）

> 状态：设计已批准，待落实现计划。
> 上游：[phase-roadmap.md](../plans/phase-roadmap.md) Phase 6.5（已实现，roadmap 处留状态摘要 + 本链接）。
> 范围：仅 **WebFetch**。WebSearch 仍阻塞于搜索源决策（SearXNG 自建 vs Tavily/Brave），本 spec 不涉及。

## 1. 目标与动机

给 zuse 一个专用的联网读取工具：输入一个 URL，抓取页面、抽取正文、转成 Markdown 返回，**由主模型自己阅读**，而非工具内再调一层 LLM 做摘要。

### 为什么不直接用 `Bash(curl)`

`Bash(curl)` 已经能抓网页，模型也能读。WebFetch 的增量价值有三点，且仅此三点：

1. **窄权限面。** `curl` 落在 `Bash` 权限域里，放行 `Bash` 等于放行任意 shell 命令；WebFetch 是独立工具，权限按**域名**收窄（`WebFetch(github.com)`），网络出口可被单独审批，不牵连 shell。
2. **token / 信号密度。** 噪声页（导航、广告、页脚、内联脚本）经 readability + turndown 抽取后只剩正文 Markdown，省掉大量无关 token，也让模型读得更准。
3. **缓存与健壮性封装。** 15 分钟内存缓存避免重复抓取；超时、重定向、content-type 门禁、错误归一等逻辑集中在一处，不必每次让模型现编 `curl` 参数。

干净的 SSR 页面上，WebFetch 相对 `curl` 优势有限；价值主要体现在**噪声页**和**窄权限**两点。这是清醒选择，不是银弹。

## 2. 工具契约

- **name:** `WebFetch`
- **输入:** `{ url: string }`，必填。**不带 `prompt` 参数**——抽取由主模型完成（见 §3 方案 B）。
- **输出:** `ToolResult`。
  - 成功：`output` = `# <标题>\n<来源 URL>\n\n<正文 Markdown>`。
  - 失败：`{ output, isError: true }`，`output` 为人类可读的错误说明。
- **readOnly:** **不设**（即 `false`）。网络出口有副作用语义（egress、可能触发远端动作），不能在 default 模式像 Read/Glob/Grep 那样自动放行。
- **specifierFor(input):** 从 `url` 解析出 **hostname** 返回（如 `github.com`），支撑权限规则匹配 `WebFetch(github.com)`、`WebFetch(*.dev)`。`url` 非法或无法解析 hostname 时返回 `null`。

### 与现有工具架构的契合

- `ToolContext` 维持 `{ cwd, signal, tracker }` 不变——WebFetch 不需要 ModelClient 或 settings（方案 B 的直接收益）。
- 仅 `index.ts` 的 `createDefaultRegistry()` 增加一次注册；符合「加工具 = 加一条注册」的数据驱动原则。
- 无新增 env var、无新增 provider。

## 3. 抽取策略：方案 B（工具内不调 LLM）

工具**不**在内部调用任何模型做摘要/抽取。它只做确定性的 HTML → 正文 Markdown 转换，把干净文本交给主模型。

理由：
- `ToolContext` 不含 ModelClient，方案 B 不必改动这一核心约束。
- 主模型本就要读这段内容，再插一层小模型摘要会丢信息、加延迟、增成本。
- 抽取是纯函数，易测、可复现。

## 4. 处理流水线（`WebFetchTool.run`）

1. **校验 url**：必须 `http://` 或 `https://`。否则返回 `isError`（「无效的 URL，仅支持 http/https」）。
2. **查缓存**：以规范化的 `url`（去 fragment）为 key。命中且未过期 → 直接返回缓存内容。
3. **抓取** `fetch(url)`：
   - 自定义 User-Agent（拟真浏览器串，减少被简单反爬拦截）。
   - 跟随重定向（fetch 默认 `redirect: 'follow'`）。
   - **30 秒超时**：用 `AbortSignal.timeout(30_000)` 与 `ctx.signal` 经 `AbortSignal.any([...])` 合并，既限时又尊重用户 Ctrl+C。
4. **检查 HTTP 状态**：非 2xx → `isError`，带状态码（如「HTTP 404 Not Found」）。
5. **检查 `content-type`**（按 MIME 主类型分流）：
   - `text/html` → 进抽取流水线（第 6 步）。
   - `text/plain` / `application/json` / `text/markdown` → 原文直接作为正文返回（仍走截断与缓存）。
   - 其它（图片 / `application/pdf` / 二进制等）→ `isError`（「不支持的内容类型：<type>」）。
6. **抽取正文**：
   - jsdom 解析 HTML 为 DOM。
   - `@mozilla/readability` 抽取主正文（`Readability(document).parse()`）。
   - 抽取成功 → 用其返回的正文 DOM/HTML 与标题。
   - **抽取失败/空**（readability 返回 `null` 或正文为空）→ **回退**：对 `document.body` 整体转换；标题取 `<title>`。
7. **转 Markdown**：`turndown` 把正文 HTML 转 Markdown，挂载 `turndown-plugin-gfm` 以支持表格/删除线等 GFM 语法。
8. **空正文提示**：若最终正文为空白（典型为 SPA 客户端渲染，原始 HTML 无正文），输出正文体替换为固定提示：
   > 正文为空，页面可能为 JS 客户端渲染（SPA）；可尝试其数据接口或直接粘贴内容。
   （此情形不视为 `isError`——抓取本身成功了，只是无可抽取内容。）
9. **截断**：正文 Markdown 超过 **50000 字符**时截断，并在末尾追加一行：
   > `\n\n[内容已截断，原文超过 50000 字符]`
10. **写缓存**并返回。

## 5. 模块结构

### 新建 `packages/tools/src/webfetch.ts`

导出三个单元，边界清晰、可独立测试：

- **`extractContent(html: string, url: string): { title: string; markdown: string }`**
  纯函数。内部：jsdom 解析 → readability 抽取（失败回退 body）→ turndown 转 Markdown。无网络、无 IO。**单测主战场**：给定 HTML 断言标题、正文、去噪、回退路径、空正文。
- **`createFetchCache(ttlMs: number, now?: () => number): FetchCache`**
  带可注入时钟的 TTL 内存缓存（内部 `Map<string, { value: string; expiresAt: number }>`）。`now` 默认 `Date.now`；单测注入假时钟验证命中/过期。接口：`get(key): string | undefined`、`set(key, value): void`。
- **`WebFetchTool: Tool`**
  组装上述两块 + `fetch`，实现 §2 契约与 §4 流水线。模块内持有一个进程级 cache 实例（TTL 15 分钟）。

**网络 seam（可测性）：** 模块内 `let fetchImpl: typeof fetch = globalThis.fetch`，并导出一个仅供测试的 setter（如 `__setFetchImpl`）。让 `run` 的网络路径也能单测——注入假 `fetch` 返回构造好的 `Response`，覆盖 content-type 分流与各错误分支，**不真打网络**。

### 修改 `packages/tools/src/index.ts`

- `createDefaultRegistry()` 注册 `WebFetchTool`。
- `export { WebFetchTool }`（与其它工具导出方式一致）。

### 修改 `packages/tools/package.json`

- `dependencies`：`jsdom`、`@mozilla/readability`、`turndown`、`turndown-plugin-gfm`。
- `devDependencies`：`@types/jsdom`、`@types/turndown`。
- （`@mozilla/readability` 自带类型；`turndown-plugin-gfm` 若无类型声明，在 webfetch.ts 顶部加一行 `// @ts-expect-error` 或局部 `declare module`。）

### 新建 `packages/tools/src/webfetch.test.ts`

- `extractContent`：标准文章 HTML → 断言标题 + 正文 Markdown + 去除导航/脚本；readability 失败 → 回退 body；空 body → 空正文。
- `createFetchCache`：set 后 get 命中；超过 TTL（推进假时钟）后 get 返回 undefined。
- `WebFetchTool.run`（注入假 fetch）：
  - HTML 正常 → 含标题 + URL + Markdown。
  - 非 2xx → `isError` 带状态码。
  - 非 HTML（如 `image/png`）→ `isError`。
  - `text/plain` → 原文返回。
  - 无效 url（非 http/https）→ `isError`。
  - 缓存命中 → 第二次调用不触发 fetch（断言假 fetch 仅被调一次）。
  - 超长正文 → 截断且带截断提示。

## 6. 权限与配置

- 默认 `ask`（因 `readOnly: false` 且无 allow 规则匹配时，`decide()` 落到 ask）。
- 示例 settings 的 `permissions.ask` 增加 `WebFetch(*)`，并在文档示范用 `WebFetch(<domain>)` 收窄放行特定域名。
- `specifierFor` 返回 hostname，使 `WebFetch(github.com)`、通配 `WebFetch(*.dev)` 等规则可命中。

## 7. 错误处理（统一为 `ToolResult{ isError: true }`）

| 情形 | 输出 |
|---|---|
| url 非 http/https | 「无效的 URL，仅支持 http/https」 |
| 网络错误 / DNS 失败 | 「抓取失败：<error message>」 |
| 超时（30s） | 「抓取超时（30 秒）」 |
| 用户中断（ctx.signal） | 由 AbortError 归一为「已取消」 |
| 非 2xx 状态 | 「HTTP <status> <statusText>」 |
| 不支持的 content-type | 「不支持的内容类型：<type>」 |

空正文（SPA）**不**算错误，按 §4 第 8 步返回提示文本。

## 8. 已知限制（不在 v1 处理）

- **SPA / 客户端渲染页抓不到正文。** `fetch` 不执行 JS，只拿原始 HTML；这与 `Bash(curl)` 是**共同**短板，非 WebFetch 独有。要抓需无头浏览器（Playwright/Puppeteer），依赖体量过大，YAGNI 砍掉。退路是抓该页数据接口或人工粘贴（见 §4 第 8 步提示）。
- 不解析 robots.txt。
- 不做并发批量抓取（一次一个 URL）。
- 不做认证/登录页抓取。

### 8.1 已处理的鲁棒性增强：Cloudflare 邮箱混淆还原

`extractContent` 在 readability/turndown **之前**调 `deobfuscateCfEmails(dom)`，把 Cloudflare 的邮箱混淆还原成明文（等价于浏览器端 `email-decode.min.js`）。覆盖两种来源：元素上的 `data-cfemail` 属性、`href="/cdn-cgi/l/email-protection#<hex>"` 片段。解码算法：hex 首字节为 XOR key（CF 每次加载随机轮换），其余字节逐个异或。

**为什么必须在工具层做（而非交给模型）**：CF 把原文（如 `python@3.12`）从文本里抹掉、只在 DOM 属性里留编码态 hex；turndown 一转，hex 就没了，模型看到的只有占位符 `[email protected]`。实测连强模型（deepseek 旗舰级）也只能瞎猜并幻觉，弱模型（mimo-free）同样失败 —— 因为所需信息根本不在模型可见的文本里。只有确定性解码能修。

### 8.2 鲁棒性增强的准入原则（决定"补到什么时候"）

为避免"出一个问题补一个"的无尽特例堆叠，一个网页鲁棒性问题**仅当同时满足以下三条**才在工具层修，否则一律记为已知限制、不处理：

1. **失败确定性且静默** —— 所需信息已被 markup 丢弃，模型在文本里根本看不到，只能瞎猜或编造（不是"模型不够强"）。
2. **高频** —— 影响真实网页的很大比例。
3. **修复确定性** —— 一段定死逻辑即可彻底消除，不依赖模型聪明与否。

Cloudflare 邮箱混淆三条全中（CF 覆盖面极广、信息被属性藏起、XOR 解码是死逻辑），故 §8.1 处理。其余混淆（`[at]`/`[dot]` 文字、HTML 实体、JS 拼接、其他 CDN 的 base64 等）基本过不了第 1 或第 2 条 —— 要么罕见、要么模型至少能察觉异常 —— 一律不追。注意：本原则只覆盖"信息被 markup 丢弃"这一类；"主模型读不懂噪声 markdown"是方案 B 的固有取舍（见 §3），属另一个层面的决策，不在此列。

## 9. 测试策略小结

- 抽取与缓存逻辑：纯函数单测，无网络。
- 网络路径：经 `__setFetchImpl` 注入假 `fetch`，覆盖全部分流与错误分支，CI 不依赖外网。
- 沿用仓库既有 vitest / TDD 约定。
