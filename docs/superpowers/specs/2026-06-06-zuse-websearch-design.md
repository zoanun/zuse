# zuse WebSearch 工具设计

> 状态:设计稿(待评审)。日期:2026-06-06。
> 上游:[phase-roadmap.md](../plans/phase-roadmap.md) Phase 6.5(已实现,roadmap 处留状态摘要 + 本链接)。
> 关联:[WebFetch 设计](./2026-06-06-zuse-webfetch-design.md)、[多 provider 设计](./2026-06-05-zuse-multi-provider-design.md)、[设置与权限设计](./2026-06-04-zuse-settings-and-permissions-design.md)。

## 1. 目标与非目标

**目标**:给 zuse 加一个 `WebSearch` 工具,让主模型能按关键词检索互联网、拿到一组「标题 + URL + 摘要」,据此决定要不要再用 `WebFetch` 抓正文。

**非目标(v1 不做)**:
- 工具内不调用任何 LLM(不做查询改写、不做结果总结)—— 与 WebFetch「方案 B」一致,原始结果直接交主模型。
- 不抓正文(正文是 `WebFetch` 的职责,职责不重叠)。
- 不实现 Anthropic 原生 `web_search` 服务端工具 —— zuse 的实际 provider(qwen 经 dashscope 等)跑不了它,是死重量。WebSearch 走外部搜索 provider。
- 不做结果缓存(搜索结果时效性强,且查询多变命中率低;WebFetch 才需要缓存正文)。

## 2. 架构总览

```
主模型 --(WebSearch: query)--> 工具 run()
                                  │
                                  ▼
              orchestrator: 按 [backend, ...fallback] 依次尝试
                                  │
                                  ▼
              BACKENDS[name](query, opts, signal)  ── 数据驱动的后端注册表
                ├─ tavily → POST api.tavily.com/search
                └─ brave  → GET api.search.brave.com/res/v1/web/search
                                  │
                                  ▼
              SearchResult[] {title, url, snippet} ── 统一中间形态
                                  │
                                  ▼
              格式化为 Markdown 列表 → ToolResult
```

三条设计原则(与仓库既有约定一致):
1. **数据驱动**:加后端 = `backends` 配置加一条 + 注册表加一个 search 函数,不动 orchestrator 逻辑。对齐 `providers` 的设计。
2. **后端无状态**:search 函数是纯粹的「请求 → 解析 → 返回」,无缓存、无全局态(测试可注入 fetch seam)。
3. **失败显式**:后端用类型化错误区分「可回退的硬失败」与「不可回退」,orchestrator 据此决定回退;发生回退时在输出里加一行 note(zuse 无 logger 模块,note 随 ToolResult 回喂模型,transcript 可见),不静默。

## 3. 配置 schema

新增顶层 `webSearch` 块(不并入 `providers` —— 搜索后端不是聊天 provider,协议/字段都不同)。

```jsonc
"webSearch": {
  "backend": "tavily",        // 主后端;切后端只动这一行
  "fallback": ["brave"],      // 可选:主后端硬失败时按序回退;省略 = 不回退
  "maxResults": 5,            // 可选:每次返回条数上限,默认 5
  "backends": {               // 各后端各存各的 key(切换时互不覆盖)
    "tavily": { "apiKey": "tvly-..." },
    "brave":  { "apiKey": "BSA-..." }
  }
}
```

**类型(types.ts)**:

```ts
/** 单个搜索后端的原始配置(来自 settings 文件)。 */
export interface RawWebSearchBackendConfig {
  apiKey?: string
}

/** WebSearch 原始配置(三层合并前)。 */
export interface RawWebSearchConfig {
  backend?: string
  fallback?: string[]
  maxResults?: number
  backends?: Record<string, RawWebSearchBackendConfig>
}

/** 解析后的 WebSearch 配置(供工具使用)。 */
export interface WebSearchConfig {
  backend: string
  fallback: string[]
  maxResults: number
  /** 仅含「已解析出 key」的后端;无 key 的后端不会进这里。 */
  backends: Record<string, { apiKey: string }>
}
```

**解析(settings.ts,新增 `getWebSearchConfig`)**:
- 无 `webSearch` 块,或 `backends` 里没有任何可用 key → 返回 `null`(工具不注册,见 §8)。
- 每个后端的 key 只取字面量 `apiKey`(来自 settings 三层,`settings.local.jsonc` 等),不读环境变量。
- `maxResults` 缺省回落到 `DEFAULT_MAX_RESULTS = 5`。
- `fallback` 缺省 `[]`。
- `backend` 缺省取 `backends` 里第一个有 key 的后端(让「只配一个后端、不写 backend」也能用)。

**三层合并(settings.ts `mergeLayers`)**:`webSearch` 做深合并 —— `backends` 按后端名合并(同 `providers` 的合并方式),`fallback` 用「靠后层覆盖」而非拼接(回退顺序应可被 local 层整体改写,而非追加)。`backend` / `maxResults` 标量覆盖。

## 4. 后端 seam 与注册表

```ts
/** 后端搜索函数签名:纯请求/解析,失败抛 WebSearchBackendError。 */
export type SearchBackend = (
  query: string,
  opts: SearchOpts,
  signal: AbortSignal,
) => Promise<SearchResult[]>

export interface SearchOpts {
  apiKey: string
  maxResults: number
  allowedDomains?: string[]
  blockedDomains?: string[]
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

/** 数据驱动注册表:加后端 = 加一条。 */
const BACKENDS: Record<string, SearchBackend> = {
  tavily: searchTavily,   // POST api.tavily.com/search,key 走 body.api_key
  brave: searchBrave,     // GET api.search.brave.com/...,key 走 X-Subscription-Token 头
}
// 切换 = 改配置 backend;回退 = 配置 fallback。两者都只认这里的 key 名。
// brave 无 include/exclude 数组参数,域名过滤用 site:/-site: 操作符拼进 q。
```

**`searchTavily`**:`POST https://api.tavily.com/search`,body `{ api_key, query, max_results, include_domains?, exclude_domains? }`(域名数组为空则不传该字段),解析响应 `results[]` → `{ title, url, snippet }`(摘要取 Tavily 的 `content` 字段)。

**网络 seam**:复用 WebFetch 同款 `__setFetchImpl` / `__resetFetchImpl`(`packages/tools/src/websearch.ts` 内自有一份),单测不打网络。

## 5. 自动回退(orchestrator)

```ts
/** 后端失败时抛此错;retryable 决定 orchestrator 是否回退到下一个后端。 */
export class WebSearchBackendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) { super(message) }
}
```

**回退判定**(在 `searchTavily` 内把 HTTP/网络情况映射成 `retryable`):

| 情况 | retryable | 说明 |
| --- | --- | --- |
| 网络错误 / DNS / 超时 | ✅ | 换后端可能通 |
| HTTP 401 / 403 | ✅ | 坏/过期 key —— 正是「key 不好用」要回退的场景 |
| HTTP 429 | ✅ | 限流,换后端绕开 |
| HTTP 5xx | ✅ | 服务端故障 |
| HTTP 400 / 422 | ❌ | query 本身有问题,换后端同样错 |
| HTTP 200 + 空结果 | (不抛错) | 有效的「查无结果」,**不回退** |
| 用户取消(`ctx.signal` aborted) | (不抛 retryable) | 直接中止整个工具,不回退 |

**orchestrator 流程**(`run()` 内):
1. 候选链 = `[backend, ...fallback]`,去重,且**过滤掉 `config.backends` 里没 key 的后端**。
2. 依次尝试:成功(含空结果)→ 立即返回。
3. 抛 `retryable=true` 且链里还有下一个 → 记下这次失败(后端名 + status),试下一个;最终成功时把发生过的回退作为一行 note 放进输出(如 `[note: tavily failed (401), used brave]`)。
4. 抛 `retryable=false` → 立即返回该错误(不再试)。
5. 用户取消 → 返回 `WebSearch cancelled.`(对齐 WebFetch 的取消语义,取消优先于超时)。
6. 全部 retryable 失败 → 返回最后一个错误。

`fallback` 为空(默认)时链里只有主后端,行为退化为「无回退」,不会无意中烧第二家额度。

## 6. 工具输入 schema

```ts
interface WebSearchInput {
  query: string                // 必填
  max_results?: number         // 覆盖配置的 maxResults
  allowed_domains?: string[]   // 透传后端的 include_domains
  blocked_domains?: string[]   // 透传后端的 exclude_domains
}
```

域名过滤做成 per-call 输入(而非全局配置):模型可把某次搜索锁定到特定文档站,与主流 agent 的 WebSearch 行为对齐。`max_results` 经 `clampPositiveInt` 夹取,缺省回落到 `config.maxResults`。

## 7. 输出格式(Markdown)

```
Found 3 results for "rust async traits 2026":

1. [Async traits in Rust](https://example.com/a)
   Stabilized in 1.x, async fn in traits now works without the async-trait crate...

2. [...](...)
   ...
```

- 摘要单条过长则截断(单条上限,如 ~500 字符),避免一次搜索撑爆上下文。
- 空结果:`No results for: <query>`(`isError: false` —— 查无是有效结果,不是错误)。
- 与 WebFetch 一致:工具内**不**调用 LLM,原文交主模型阅读。

## 8. 时效性(年月)—— 免费搭车

不像部分实现那样在工具里手动注入「当前年月」到 query。zuse 的 `AgentEnvironment` 已把当前日期注入系统提示([prompt.ts](../../../packages/core/src/prompt.ts)),主模型自己知道「今天」,可在 query 里自带年份(如「... 2026」)。**零额外代码**。

## 9. 权限

- **非 readOnly**:网络出口有副作用语义,不在 `default` 模式自动放行 —— 对齐 WebFetch。
- `specifierFor` 返回 `null`(搜索没有像 hostname 那样的天然限定符)→ 授权规则就是裸 `WebSearch`,一次授权覆盖后续所有搜索。

## 10. 接线

- **工厂模式**:`createWebSearchTool(config: WebSearchConfig): Tool`。WebSearch 需要 key,而 `ToolContext` 不携带 settings,所以用工厂在构造时注入 config(WebFetch 是静态 const,因其无需配置 —— 这是两者的关键差异)。
- **注册**:`createDefaultRegistry` 增加可选参数 `opts?: { webSearch?: WebSearchConfig | null }`;**仅当 `webSearch` 非 null 时** `register(createWebSearchTool(webSearch))`。没配 key 就不向模型暴露这个工具,避免它调了空手而归。
- **TUI**:启动构建 registry 时 `getWebSearchConfig(settings)` 传入。

## 11. 文件布局

| 文件 | 职责 |
| --- | --- |
| `packages/core/src/types.ts` | 增 `RawWebSearchConfig` / `WebSearchConfig` 等类型 |
| `packages/core/src/settings.ts` | 增 `getWebSearchConfig`;`mergeLayers` 处理 `webSearch` 深合并 |
| `packages/tools/src/websearch.ts` | 工具主体:`createWebSearchTool`、orchestrator、`BACKENDS`、`searchTavily`、`WebSearchBackendError`、fetch seam |
| `packages/tools/src/websearch.test.ts` | 单测(见 §12) |
| `packages/tools/src/index.ts` | `createDefaultRegistry` 接收并按需注册 WebSearch |
| `.zuse/settings.local.json.example` | 增 `webSearch` 示例块(占位 key,可提交) |

## 12. 测试(mock fetch seam,不打网络)

- **query 拼装**:`max_results` / `allowed_domains` / `blocked_domains` 正确映射到 Tavily body;空域名数组不出现在 body 里。
- **结果格式化**:多结果 → 编号 Markdown 列表;超长摘要被截断。
- **空结果**:返回 `No results for: ...`,`isError: false`。
- **回退命中**:主后端抛 401(retryable)→ 回退到第二后端并成功;断言输出含回退 note。
- **回退不触发**:主后端抛 400(不可回退)→ 直接返回错误,不试第二个。
- **空结果不回退**:主后端 200 空结果 → 直接返回「查无」,不试第二个。
- **全失败**:链上所有后端都 retryable 失败 → 返回最后一个错误。
- **缺 key**:`getWebSearchConfig` 在无可用 key 时返回 null;`createDefaultRegistry` 不注册工具。
- **brave 后端**:`backend: "brave"` 直接走 brave,摘要取 `web.results[].description`;域名过滤拼成 `site:`/`-site:` 操作符。
- **取消**:`ctx.signal` 已 abort → 返回 cancelled,不回退。

## 13. 待评审 / 可能微调

- 单条摘要截断阈值(暂定 ~500 字符)与是否给「结果总数」提示。
- `fallback` 用「覆盖」而非「拼接」的合并语义是否符合预期(本设计选覆盖)。
- brave 域名过滤靠 `site:`/`-site:` 操作符近似实现(Brave 无原生 include/exclude 数组);多域名 allowed 用 `(site:a OR site:b)`。
