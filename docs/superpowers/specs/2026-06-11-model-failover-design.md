# 模型额度耗尽自动降级(failover)设计文档

- 日期:2026-06-11
- 状态:已定(用户在线确认:触发条件、弹框 vs 自动可配、标记仅本会话内存、降级放编排层、默认 dialog、标记用运行时属性不改配置)
- 范围:`packages/core`(错误分类、设置)+ `packages/tui`(降级编排、picker 标注)

## 1. 背景

zuse 是多 provider 的 Agent TUI。模型调用链路:`useConversation.sendMessage` → `runAgent` → `client.sendMessages`。

- `retry.ts` 已在 **client 内部**对瞬时错误(429 / 5xx / 网络抖动)透明退避重试(`DEFAULT_MAX_RETRIES=5`),且只在"开流前/首块前"重试;一旦吐过 `message-start`/文本就不再重试。
- 重试耗尽、或遇到不可重试错误(401/402/403/404/422)时,client `yield { type: 'error', message }`(`anthropic-client.ts:191`、`openai-client.ts:330`)。
- `runAgent` 收到 `error` 事件即中止本回合、**丢弃 staged、什么都不提交**(`agent.ts:140`)。
- `useConversation` 的 error 分支只把它渲染成一条错误气泡(`useConversation.ts:336`),**无分类、无降级**。

缺口:当某模型额度耗尽(402/403/429)或不可用(404/503)时,用户只看到一条红色错误,得手动 `/model` 重选。本设计加入**自动降级**:按配置,要么弹 `/model` 选择器(坏的标注出来),要么自动切到同 provider 下一个可用模型并重发。

## 2. 目标

- **G1 错误分类**:`StreamEvent` 的 `error` 事件带上 `status?` 与 `category`,让编排层能区分"该降级 / 该换 provider / 只提示"。
- **G2 设置开关**:顶层 `failoverMode: 'dialog' | 'auto'`,默认 `'dialog'`。
- **G3 降级编排**:在 `useConversation` 的 error 处理里,按 `failoverMode` 决定弹框或自动切换+重发。只在**未吐出任何文本**时才降级。
- **G4 会话级标记**:被判坏的 `provider/model`(401 则整个 provider)记进**内存 Set**,picker 灰显标注;**进程重启即清**,零文件写入。

## 3. 非目标

- 不改 `retry.ts` 的 client 内重试逻辑(瞬时错误仍由 client 自愈)。
- 不做流中途降级:流已吐文本后再报错,只提示不切换(重发会重复内容)。
- 不持久化标记:不写 settings、不注释配置。额度通常会重置,持久化会误伤。
- 不做跨 provider 的自动链式降级:`auto` 模式只在**同 provider** 内自动找下一个;跨 provider 一律交还给用户(弹框)。
- 不改账本提交语义:降级 = 用新 client 重新发起整个回合,旧的失败回合本就什么都没提交。

## 4. 触发矩阵(最终口径)

走到 client 的 `error` 事件时(即 retry 已耗尽/不可重试),按 HTTP 状态归类:

| 上游状态 | category | dialog 模式 | auto 模式 |
|---|---|---|---|
| 402 / 403 / 429 | `quota` | 弹框(标该 model 坏) | 自动切同 provider 下一个未坏 model + 重发;无则弹框 |
| 404 / 503 | `unavailable` | 弹框(标该 model 坏) | 同上 |
| 401 | `auth` | 弹框(标**整个 provider** 坏) | **必弹框**(共享 key,换 model 救不了) |
| 其余(400/422/网络/未知/空闲超时) | `other` | 照旧只渲染错误气泡 | 照旧只渲染错误气泡 |

> 注:429/503 在 client 内已重试 5 次;能走到这里说明重试都没救回,按耗尽处理。

## 5. 模块布局

| 文件 | 改动 | 职责 |
|---|---|---|
| `packages/core/src/types.ts` | 改 | `error` 事件 += `status?: number`、`category: ErrorCategory`;新增 `ErrorCategory` 联合类型;`RawSettings`/`ResolvedSettings` += `failoverMode?` |
| `packages/core/src/retry.ts` | 改 | 新增纯函数 `classifyError(err): { status?, category }`(复用现有 `readStatus`) |
| `packages/core/src/anthropic-client.ts` | 改 | 三处 `yield {type:'error'}` 带上 `classifyError(err)`(中断/空闲超时归 `other`) |
| `packages/core/src/openai-client.ts` | 改 | 同上;`tool_call` 参数非法 JSON 的 error 归 `other` |
| `packages/core/src/settings.ts` | 改 | `mergeLayers` 合并 `failoverMode`(标量高层覆盖);新增 `resolveFailoverMode(settings): 'dialog'\|'auto'`(缺省 `'dialog'`) |
| `packages/tui/src/commands/registry.ts` | 改 | `ModelOption += unavailable?: { reason: ErrorCategory }`;`buildModelOptions` 增可选入参 `badKeys?: Map<string, ErrorCategory>` 用于标注 |
| `packages/tui/src/components/modelSelectItems.ts` | 改 | `SelectListItem` 携 `disabled?`/`badge?`;坏项打标 |
| `packages/tui/src/components/ModelSelect.tsx` | 改 | 透传 `badKeys`;坏项灰显 + 标签 + 不可确认 |
| `packages/tui/src/components/selectListCore.ts` | 改 | 选中/回车跳过 `disabled` 项(若 SelectList 未天然支持) |
| `packages/tui/src/hooks/useConversation.ts` | 改 | 核心:`badModelsRef` Set;error 分支按 category + failoverMode 走降级;`auto` 自动切换并重发 |

## 6. G1:错误分类(core)

`types.ts`:

```ts
export type ErrorCategory = 'quota' | 'auth' | 'unavailable' | 'other'

export type StreamEvent =
  | ...
  | { type: 'error'; message: string; status?: number; category?: ErrorCategory }
```

`category` 设为可选,旧代码/测试构造的 `{type:'error', message}` 仍合法;消费侧把 `undefined` 当 `'other'`。

`retry.ts` 新增:

```ts
/** 把已耗尽重试/不可重试的错误归类,供编排层决定是否降级。 */
export function classifyError(err: unknown): { status?: number; category: ErrorCategory } {
  const status = readStatus(err) // 复用现有私有函数(导出或内联)
  if (status === 401) return { status, category: 'auth' }
  if (status === 402 || status === 403 || status === 429) return { status, category: 'quota' }
  if (status === 404 || status === 503) return { status, category: 'unavailable' }
  return { status, category: 'other' }
}
```

两个 client 的"不可重试或重试用尽"分支由 `yield { type:'error', message }` 改为 `yield { type:'error', message, ...classifyError(err) }`。中断/空闲超时/非法 JSON 这些**非 HTTP**的 error 走 `classifyError`(无 status → `other`),语义正确。

## 7. G2:设置开关(core)

```ts
// RawSettings / ResolvedSettings
failoverMode?: 'dialog' | 'auto'
```

- `mergeLayers`:`if (layer.failoverMode !== undefined) out.failoverMode = layer.failoverMode`(与 `model` 等标量同款,高层覆盖)。
- `resolveFailoverMode(settings): 'dialog' | 'auto'`:返回 `settings.failoverMode ?? 'dialog'`。
- 不读环境变量(YAGNI;需要时再仿 `ZUSE_PROXY` 加)。

## 8. G3 + G4:降级编排与标记(tui / useConversation)

**新增会话级 ref**(刷新即清):

```ts
// key: `${providerId}/${model}`;value: 坏的原因(用于 picker 标签)
const badModelsRef = useRef<Map<string, ErrorCategory>>(new Map())
```

`auth` 时把该 provider 的**所有**已声明 model 都塞进去(遍历 `settings.providers[id].models`);其余只塞当前 `provider/model`。

**关键约束:绝不在 `for await` 循环内重入 `sendMessage`**(会与正在进行的流/AbortController 缠绕)。error 分支只**记录一个决定**到本回合局部变量,等 `for await` 自然结束(client 已 `return`)、在 `sendMessage` 函数体尾部统一执行降级动作。

**error 分支改写**(`useConversation.ts:336`)。当前回合记录了 `accumulated`、`currentAssistantId`,据此判断是否已吐文本:

```ts
// sendMessage 顶部声明:
let failoverDecision: { category: ErrorCategory } | null = null

// error 分支:
} else if (event.type === 'error') {
  if (controller.signal.aborted) { showAborted(); }
  else {
    const cat = event.category ?? 'other'
    const preStream = accumulated === '' && currentAssistantId === null
    if (preStream && cat !== 'other') {
      failoverDecision = { category: cat }   // 只记决定,不动手
    } else {
      showError(event.message)
    }
  }
}
```

**循环结束后**(`for await` 退出、`finally` 清掉 `abortRef` 之后),若 `failoverDecision` 非空则执行 `applyFailover(failoverDecision.category, text)`:

1. 标坏:把当前 `provider/model`(或 `auth` 时整个 provider)写入 `badModelsRef`。
2. 选下家(仅 `auto` 且 `category !== 'auth'`):在 `settings.providers[currentProviderId].models` 里,按声明顺序找**第一个不在 `badModelsRef`、且不是刚失败那个**的 model。
   - 找到 → `switchModel({providerId: 当前, model: 下家}, false)` → `print('额度耗尽,已切换到 <下家> 重试')` → **调 `sendMessage(userText, undefined, undefined, { isResend: true })`**(此时已不在 `for await` 内,安全)。
   - 没找到 → 落到第 3 步。
3. 弹框(`dialog` 模式、或 `auto` 找不到下家、或 `category === 'auth'`):`print('<原因>,请选择其他模型')` → `setModelSelectorOpen(true)`。picker 据 `badModelsRef` 灰显标注。

**重发去重**:`sendMessage` 增内部第四参 `opts?: { isResend?: boolean }`。`isResend` 为真时**跳过乐观 push user 气泡**(失败回合没提交、原 user 气泡仍在屏,直接复用),其余流程不变。

**降级深度**:`auto` 连续失败形成 `sendMessage → (循环结束) → applyFailover → sendMessage(isResend)` 链。每次把上一个标坏,候选单调减少,必然终止于"无下家→弹框"。`badModelsRef` 保证不回头试已坏的,无需额外计数器。

## 9. picker 标注(tui)

- `buildModelOptions(settings, curPid, curModel, badKeys?)`:对每个 option,若 `badKeys.has(`${id}/${model}`)` 则 `unavailable = { reason }`。保持纯函数。
- `ModelSelect`:从 props 拿 `badKeys`(由 `useConversation` 经 App 传入,即 `badModelsRef.current`),传给 `buildModelOptions`。
- 渲染:坏项 `dimColor` + 行尾标签 `(额度耗尽)`/`(key失效)`/`(不可用)`;`onSelect` 时若该项 `disabled` 则忽略(或 SelectList 直接跳过)。
- reason → 文案映射:`quota→额度耗尽`、`auth→key失效`、`unavailable→不可用`。

## 10. 测试

**core(纯函数,Vitest):**
- `classifyError`:401/402/403/404/429/503/400/网络err/无status → 正确 category。
- `mergeLayers`:`failoverMode` 高层覆盖低层;`resolveFailoverMode` 缺省 `'dialog'`。
- client:构造带 `status` 的 fake 错误,断言 `error` 事件带对应 `category`;已 `emitted` 后报错仍带分类(由消费侧 gate,不影响 client)。

**tui:**
- `buildModelOptions`:`badKeys` 命中项有 `unavailable`,未命中无。
- `modelSelectItems`:坏项 `disabled`/`badge` 正确。
- `useConversation`(若已有 hook 测试基建):
  - `dialog` 模式 + `quota` error + 未吐文本 → 开 selector、标坏当前 model、不重发。
  - `auto` 模式 + `quota` + 同 provider 有下家 → 切换 + 重发(断言 switchModel 被调、第二次 sendMessage)。
  - `auto` + 同 provider 无下家 → 开 selector。
  - `auth` → 整个 provider 标坏 + 开 selector(即便 auto)。
  - 已吐文本后 error → 只 showError,不降级。
  - `other` → 只 showError。

## 11. 风险 / 待决(计划阶段细化)

- **重发的执行点(已定,实现需照做)**:error 分支只置 `failoverDecision`,**循环结束、`finally` 清掉 `abortRef` 之后**才执行 `applyFailover`/重发(§8)。绝不在 `for await` 内重入 `sendMessage`。重发新建的 AbortController 与旧回合无重叠。这是本设计**实现时最易踩坑的点**,计划阶段需就此单列一步并配测试。
- **`isResend` 去重(已定)**:重发跳过乐观 push user 气泡,不破坏 `generation`/滚动高水位。
- **provider 无 models 声明**:扁平默认 provider 或未列 models 的 provider,`auto` 找不到下家 → 直接弹框(已被 §8 第2步自然覆盖)。
- **picker 全坏**:极端情况所有 model 都标坏,picker 全灰;用户仍可 Esc,或重启清标记。可接受(v1 不加"重置标记"入口,YAGNI)。
