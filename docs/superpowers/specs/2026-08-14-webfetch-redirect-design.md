# WebFetch 重定向绕过权限闸（回溯审计 D5）设计 v2

日期：2026-08-14
状态：v2 —— 已按独立子代理评审的 1-A/1-B/1-C、2-A/2-B/2-C、3-A~3-F 全部重写

## 一、实测事实（先摆证据，再谈方案）

以下每条都在本机真跑过，输出原样贴在下面。**不是推断。**

### 1.1 绕过成立

两个真的 http 服务器（不打外网），一个只做 302，一个是「被 deny 的秘密站」。
权限配置：`allow: ["WebFetch(localhost)"]`、`deny: ["WebFetch(127.0.0.1)"]`。

```
入口 URL          = http://localhost:51377/
specifierFor 给出 = localhost
闸门裁决          = {"decision":"allow","rule":"WebFetch(localhost)","matched":"WebFetch(localhost)"}
直连秘密站裁决    = {"decision":"deny","rule":"WebFetch(127.0.0.1)","matched":"WebFetch(127.0.0.1)"}
--- 工具返回 ---
# SECRET
http://localhost:51377/

TOP-SECRET-PAYLOAD-42
----------------
✗ 绕过成立：被 deny 的主机内容被取回来了
```

（脚本：`scratchpad/d5-repro.mts`，`npx tsx` 直跑。）

`decide()` 只看 `specifierFor` 给出的**入口主机名**，而
[webfetch.ts:234](../../../packages/tools/src/webfetch.ts#L234) 用的是 `redirect: 'follow'` ——
**跳到哪儿去了没有任何人再看一眼**。

### 1.2 输出在骗模型

上面那段输出的抬头写的是 `http://localhost:51377/`，**内容却来自 127.0.0.1**。
`formatOutput(title, parsed.href, content)`（[webfetch.ts:263](../../../packages/tools/src/webfetch.ts#L263)）
用的是**入口** URL；`extractContent(body, parsed.href)`（[:258](../../../packages/tools/src/webfetch.ts#L258)）
把 jsdom 的 base URL 也设成入口 URL，页面里的相对链接会解析到错误的源上。
**这条独立于权限问题，本身就该修。**

### 1.3 Node 的 `redirect:'manual'` **不是**浏览器语义 —— 整个方案的地基

WHATWG fetch 规范规定 manual 模式返回 *opaque-redirect filtered response*（`status: 0`、
header 列表为空、body 为 null），浏览器照此实现。**照规范读，本设计根本不可能实现。**
Node/undici 不是这样：

```
=== (a) manual 模式 Node 给不给 Location ===
{"path":"/302","status":302,"type":"basic","ok":false,"location":"/secret","headerCount":5,"bodyNull":false}
{"path":"/noloc","status":302,"type":"basic","ok":false,"location":null,"headerCount":4,"bodyNull":false}
```

`type` 是 `basic`、header 全在、`Location` 读得到、无 Location 时是 **`null`**（不是 undefined ——
`?? '默认值'` 兜得住，`if (loc === undefined)` 兜不住）。

**这条必须留在 spec 里。** 否则下一个读规范的人会以为方案行不通，或者更糟：把它「修」成浏览器语义。

### 1.4 现行 `follow` 模式对各 3xx 的实际行为

```
=== (b) follow 模式对各 3xx 跟不跟随（看最终 url）===
300: status=300 finalUrl=…/300     跟随=false
301: status=200 finalUrl=…/secret  跟随=true
302: status=200 finalUrl=…/secret  跟随=true
303: status=200 finalUrl=…/secret  跟随=true
304: status=304 finalUrl=…/304     跟随=false
307: status=200 finalUrl=…/secret  跟随=true
308: status=200 finalUrl=…/secret  跟随=true
```

**300 和 304 即使带 `Location` 也不跟随。** 所以自己实现循环时**不能**写「status 是 3xx
且有 Location 就跳」—— 那会凭空多出一条现行实现根本不会走的出站请求路径。

### 1.5 主机名归一：哪些写法能绕过字面 glob 匹配

规则匹配是**字面 glob**（[permission.ts:569](../../../packages/core/src/permission.ts#L569)
`if (kind === 'opaque') return globToRegExp(p.specifier).test(specifier)`）。而 URL 解析器的归一
只覆盖一部分写法：

```
=== (c) 主机名归一 ===
http://localhost./             → hostname=localhost.          ← 尾点保留！
http://[::ffff:127.0.0.1]/     → hostname=[::ffff:7f00:1]     ← 且被压缩成十六进制
http://2130706433/             → hostname=127.0.0.1           ← 十进制 IP 已归一
http://0x7f.1/                 → hostname=127.0.0.1           ← 十六进制已归一
http://127.1/                  → hostname=127.0.0.1           ← 短写已归一
http://127.0.0.1./             → hostname=127.0.0.1           ← IPv4 的尾点被吃掉，非 IPv4 的不会
http://EXAMPLE.com/            → hostname=example.com         ← 大小写已归一
http://中国.com/               → hostname=xn--fiqs8s.com      ← IDN 已 punycode
```

而这两种「没归一」的写法**真的到得了**只监听 127.0.0.1 的服务器：

```
=== (d) 真连 ===
http://localhost.:64537/secret         → 200 PAYLOAD
http://[::ffff:127.0.0.1]:64537/secret → 200 PAYLOAD
```

**结论：`deny: WebFetch(localhost)` 挡不住 `http://localhost./`。**
这个洞**今天在入口闸上就存在**（不需要重定向）；`Location` 由对方站点写，重定向路径上
更是攻击者单方面就能触发。它落在本设计**自己声明的**威胁模型之内，且修复成本近乎为零。

> 上一版 spec 在 §2 举「十进制 IP」当作「堵不完」的例子 —— **那是错的**，
> WHATWG URL 解析器已经归一了它。论据错会让人以为「反正都挡不住」而放过上面这个能挡住的子集。

### 1.6 唯一的接线点

全仓库调用 `tool.run(...)` 的地方只有三处：

| 位置 | 用途 |
|---|---|
| `packages/core/src/agent.ts:564`（ctx 由 `:371 buildCtx` 造） | **走注册表派发，唯一** |
| `packages/server/src/session/SessionManager.ts:991`（ctx 在 `:993`） | 硬编码 `registry.get('Memory')` |
| `packages/tui/src/hooks/useConversation.ts:412`（ctx 在 `:414`） | 同上 |

（`agent-tool.ts:183` / `workflow.ts:220` / `SessionManager.ts:1294` 那几处 `tracker:` **不是**
ToolContext，是 `runAgent` 的选项字段，最终仍由 `buildCtx` 造 ctx。上一版表格把它们列成
「构造点」是标注错误，结论不受影响。）

所以：加一个可选的 `ctx.checkSpecifier` **只需改一处接线**，且后两处够不着 WebFetch，
fail-closed 不会打坏任何现存路径。

## 二、要解决什么 / 不解决什么

**解决**：*用户在权限配置里写下的 WebFetch 规则，要在整条重定向链上、以及在主机名的
等价写法上都算数*；并且*告诉模型内容真正来自哪里*。

**明确不解决：SSRF —— 具体说，「域名在 DNS 层解析到内网地址」。**
那必须在 connect 时校验（拿到 socket 的对端地址再判），是出口代理 / 网络命名空间的活，
不是 URL 层能做的。塞进这一版只会得到一个看起来安全、实则不是的东西。

**也不做「默认 deny 一批 IP 段」**（169.254.169.254、10/8、192.168/16…）。
代价是把「抓本机开发服务器」这类正常用法一起废掉 —— 本仓库自己的验证脚本就在抓 127.0.0.1；
而收益被上一条掏空（域名照样解析进去）。要这个的人应该配 `deny: WebFetch(169.254.169.254)`，
规则语言已经够用。

注意这两条与 §1.5 的区别：**主机名等价写法**是 URL 层可判定、零副作用的，纳入；
**DNS 解析结果**不是，划出去。上一版把两者混为一谈，是论据错误。

## 三、方案

### 3.0 为什么不选更简单的那个（必须先回答）

**备选方案 B：禁止跨主机跳，把 `Location` 当 observation 交给模型，让它自己再调一次 WebFetch。**

它砍掉的东西很实在：不需要 `ToolContext.checkSpecifier` 这个新字段、不需要 agent.ts 接线、
不需要 fail-closed 论证、不需要在工具内部复刻一遍 verdict 处理、也没有下面 1-A 那个
「弹框时间吃掉抓取超时」的问题（弹框回到正常的 `gateAndRunTool` 路径）。
额外好处：目标 URL 用**自己的** URL 做缓存键（§3.5 那条特例整个消失）、jsdom base URL
和输出抬头天然正确、`allow_once` 的语义争议不存在。

**不选它的理由**：每个跨主机重定向多一个**模型回合**。短链接（`t.co`/`bit.ly`/`doi.org`）
几乎必然跨主机，是高频路径；链上两次跨主机 = 两个回合，极端情况会撞 `maxTurns`，
而且模型不一定照做。**方案 A（逐跳过闸）的 UX 明显更好，代价是多一条 ctx 接口。**

选 A。但把 B 记在这里 —— 将来谁问「为什么 WebFetch 要往 ToolContext 上挂个新接口」，
答案在这一节。**注意：两个方案都要写 `redirect:'manual'` + 循环**（同主机跳必须静默跟随），
差别只在 §3.2。

### 3.1 `redirect: 'manual'` + 自己跳

```
current = 入口 URL；hops = []；approved = new Set([canonicalHost(入口)])
loop 至多 MAX_REDIRECTS 次:
  res = fetch(current, { redirect: 'manual', signal: 本跳新建的超时 ∪ ctx.signal, … })
  若 res.status ∉ REDIRECT_STATUS 或 Location 为 null → 跳出（终态响应）
  next = new URL(location, current.href)       ← 相对 Location 按【当前跳】解析
  校验 next.protocol ∈ {http:, https:}          ← 每一跳都查
  h = canonicalHost(next)
  若 h !== canonicalHost(current) 且 !approved.has(h):
      过闸（见 3.2）；通过则 approved.add(h)
  hops.push(next)；current = next
```

逐条说明：

1. **`REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])` 写死**，不写「是 3xx 就跳」。
   依据 §1.4：现行实现对 300/304 不跟随，写宽了会引入新的出站路径。其余 3xx 落到
   下面第 2 条报 `HTTP 300 Multiple Choices`。
   （303 会改方法、307/308 保持方法 —— 本工具只发 GET，两者对我们都无影响。）
2. **`!res.ok` 会吃掉 3xx**：现在是 `if (!res.ok) return HTTP ${status}`
   （[webfetch.ts:249](../../../packages/tools/src/webfetch.ts#L249)）。manual 模式下 302 的
   `res.ok` 是 `false`。顺序必须是「先判重定向并跳，再判 `!res.ok`」，否则**所有**重定向
   都会变成「HTTP 302 Found」错误。
3. **jsdom base URL 和输出抬头用 `current.href`（最终 URL）**，不是入口。修 §1.2。
4. **相对 `Location`** 用 `new URL(loc, current.href)`。`Location` 为 `null` 的重定向状态码
   当终态响应处理（原样报 `HTTP 302 Found`），不要当成「跳到 null」。
5. **每一跳的 scheme 检查**。入口的检查在
   [webfetch.ts:218-220](../../../packages/tools/src/webfetch.ts#L218)，只查入口。
   `Location: file:///C:/Users/...`、`data:`、`javascript:` 在现行 `follow` 下由 undici 兜着，
   改 manual 之后**必须自己兜**。这条不能漏。
6. **每跳新建 `AbortSignal.timeout(FETCH_TIMEOUT_MS)`**，只度量网络时间；`ctx.signal` 全程共用。
   理由见下面「1-A」。

**`MAX_REDIRECTS = 10`。** 上一版写 5，理由是「每多一跳就多一次弹窗」—— **那个理由不成立**：
按上面的算法**同主机跳一次都不弹**，弹窗数由链上不同主机的个数决定，与跳数没有单调关系。
真实站点 `http→https→www→尾斜杠→地区→同意页→登录` 到 6 跳不罕见，5 会误伤。
取 10 而不是浏览器的 20：够用，且超限时报错而不是静默停在中途。

**`approved` Set 是必要的**：`a→b→a→b→a` 这种链，若不记已放行主机，`b` 会弹两次
（「仅此一次」不进 `sessionAllow`，第二次仍会问）。两行代码堵一个 prompt-fatigue 缺口。

### 3.2 过闸：`ToolContext.checkSpecifier`

```ts
// tool.ts
export interface ToolContext {
  …
  /**
   * 工具**执行到一半**才知道自己要碰哪个资源时，回头再过一次权限闸。
   * 目前唯一用户：WebFetch 的跨主机重定向。
   * 返回 'allow' | 'deny' —— 'ask' 已在闸门内部经 canUseTool 问过用户、折叠掉了。
   */
  checkSpecifier?(specifier: string): Promise<'allow' | 'deny'>
}
```

**不带 `toolName` 参数**（上一版带）。`buildCtx()` 是**逐次工具调用**构造的
（[agent.ts:389-392](../../../packages/core/src/agent.ts#L389)），闭包直接捕获 `tool` 对象：
少一个参数、少一条 `registry.get(name)` 可能是 undefined 的分支、也断掉「某个工具冒用
别人的名字去过闸」这条没人想要的路。而且 `decide()` 本来就要 `Tool` 对象
（[permission.ts:591](../../../packages/core/src/permission.ts#L591) 读 `tool.specifierKind`），
闭包捕获比按名反查更直接。

`agent.ts` 里的实现必须**沿用与首次过闸完全相同的 verdict 处理**：

| decide 结果 | 动作 |
|---|---|
| `deny` | 返回 `'deny'` |
| `allow` + `matched === MATCHED_BYPASS` | 调 `deps.onAutoAllow?.(name, specifier)` 再返回 `'allow'` |
| `allow` | 返回 `'allow'` |
| `ask` | `deps.canUseTool`（缺席则 `'deny'`）→ `allow_session`/`allow_persist` 要 push 进 `sessionAllow`、`allow_persist` 还要 `onPersistAllow(rule)` |

漏掉最后一行的后果：用户点「本会话允许」在这条路上不生效、每跳都重弹 —— 正是
[tool.ts:126-135](../../../packages/core/src/tool.ts#L126) 那段注释记录过的缺陷的翻版。
`onAutoAllow` 那行是为了让常驻横幅的「已自动放行 N 次」在全自主档下把跨主机跳也算进去。

**已知的语义差异（写下来，不当 bug）**：首次过闸时 `canUseTool` 抛错会一路抛出、中止整个
回合（[agent.ts:405-406](../../../packages/core/src/agent.ts#L405) 的注释明确依赖这点）；
从 `WebFetch.run` 里抛则被 `runOneTool` 的 catch 吞成一条 isError 结果。这个差异可接受
（一次抓取失败 < 整个回合炸掉），但要记着。

**并发安全（有依据，不要出于恐惧加锁）**：`agent.ts:513-516` 的 `if (!includes) push` 和
`settings.ts` 的 `appendAllowRule` 全程**没有一个 `await`**，是同步的读-改-写，事件循环
无法在中间插入另一个 `checkSpecifier`。并发最坏只造成「同一主机弹两次框」，而这在
**首次过闸**上今天就存在（Agent 工具 `parallelizable`，多个子代理共享同一个 `sessionAllow`）。

**缺席时 fail closed。** 没有 `checkSpecifier` → 跨主机跳一律拒绝并说明原因。
依据 §1.6：现存三条 `tool.run` 路径里另外两条够不着 WebFetch，**不会打坏任何东西**。
取舍：将来谁新加 ctx 构造点忘了接，表现是「跨站重定向抓不了」这种**看得见的报错**，
不是权限闸静默失效。上一轮 D6 的教训正是「ask 对只读工具 fail open，配错的规则变成静默放行」。

### 3.3 主机名归一 `canonicalHost(u: URL): string`

只做两件 URL 层可判定、无歧义、无副作用的事（依据 §1.5）：

1. **去掉末尾单个 `.`**：`localhost.` → `localhost`。
2. **拆开 IPv4-mapped IPv6**：`[::ffff:7f00:1]` → `127.0.0.1`。
   **注意**：Node 把 `[::ffff:127.0.0.1]` 序列化成 **`[::ffff:7f00:1]`**（§1.5 实测），
   所以不能只剥方括号 —— 要匹配 `^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$` 并把两个
   16 位组拼成点分四段；顺带也认 `^\[::ffff:(\d+\.\d+\.\d+\.\d+)\]$` 这种字面形式。
   其余 IPv6 一律原样返回（别自己写通用 IPv6 归一，那是另一个能出 bug 的坑）。

大小写、IDN、十进制/十六进制 IP、IPv4 尾点 —— **`new URL().hostname` 已经归一好了**（§1.5 实测），
不要再 `toLowerCase()`，也不要担心大小写绕过。

`specifierFor`（[webfetch.ts:194-202](../../../packages/tools/src/webfetch.ts#L194)）
和跨主机判断**共用**这个函数 —— 这样入口闸上的同一个洞（§1.5：今天就存在）一并补掉。

### 3.4 「跨主机」只比 hostname，不比 scheme/port

上一版说理由是「比 port 会造出用户答不出规则的死局」—— **那个论据是错的**。
规则串由 [permission.ts:46-48](../../../packages/core/src/permission.ts#L46) `buildRule` 生成，
完全可以「按 origin 变化决定要不要问、但仍把 hostname 当 specifier」，弹框给出的规则
就是 `WebFetch(a.com)`，用户答得出。

**真正的理由是「按 origin 判会多问、收益小」**：规则语言里只有主机名，判据比规则表达力
更细，得到的是一堆「问了也白问」的框（用户点了允许，规则却写不出对应的 port 限定）。

承认的代价：

- `https://a.com` → `http://a.com` 的**降级**不会再问。
- `a.com:443` → `a.com:8080` 不会再问。

**评审建议过「降级直接报错」，本版不采纳**：降级罕见但真实存在（配置错误的站点），
报错会新增一个失败模式；而目标主机名仍在用户 allow 的那个名字之内，与规则的表达力一致。
记在这里，将来若有实际案例再改。

### 3.5 缓存：跨主机跳过的结果不写缓存

读侧仍按入口 URL（`origin+pathname+search`）命中；**写侧：一旦发生过跨主机跳就不写**。

**这不是安全必需项，措辞要准。** 入口闸今天就是宽的：`WebFetch(evil.com)` 弹框点
「仅此一次」，结果照样进缓存，15 分钟内第二次调用直接命中、不再弹
（[webfetch.ts:222-225](../../../packages/tools/src/webfetch.ts#L222)）。而且第二次命中返回的
是**用户已经批准取回的同一份字节**，没有新的网络出口、没有新的信息泄露 ——「仅此一次」
被违反的只是字面，不是实质。

所以准确的说法是：**这里与入口闸的既有行为不一致，我们在新路径上选了更保守的一边**，
理由是重定向链的目标主机是**攻击者选的**（`Location` 由对方站点写），而入口 URL 是模型
自己写的，两者的可信度不同。入口闸那条已知、本次不改。
代价：跨主机重定向的 URL 每次真抓一次（短链接之类），多一次网络往返。

### 3.6 输出要说实话

```
# 标题
http://127.0.0.1:51378/                          ← 最终 URL
（经 1 次重定向，起自 http://localhost:51377/）
```

只在 `hops.length > 0` 时加那行括号 —— 不给无重定向的常见情况增加噪声。
这是 §1.2 的修复，也是模型判断「这内容可信吗」的必要信息。

### 3.7 不做的一项：`res.body?.cancel()`

实测（40 次连续 302，服务端计 TCP 连接数）undici 会自动 dump 未消费的响应体并复用连接：
`{"N":40,"connections_unconsumed":2,"connections_cancelled":0}`。大体积重定向体（1 MiB）下
两种写法都会掉复用，但都有界。**不是缺陷**，加它只是一行廉价卫生，不写不算漏项。

## 四、测试计划（TDD，先红）

单测（`webfetch.test.ts`，注入 `__setFetchImpl`）。
**桩必须记录 `checkSpecifier` 的调用参数** —— 否则一个「拿入口主机名去问」的错误实现
（`ctx.checkSpecifier(parsed.hostname)`，一个永远 allow 的空闸）会让下面 1/2 两条全绿。

1. 302 到不同主机 + 桩返回 `deny` → 报错、**不发第二次请求**、不含目标正文，
   且**断言桩收到的是目标主机名** `['b.example']`。
2. 302 到不同主机 + 桩返回 `allow` → 拿到正文，抬头是最终 URL，含「经 1 次重定向」，
   同样断言入参。
3. **按主机名区分裁决的桩**（只 deny `b.example`）：`a→b` 拒、`a→a2`（同主机不同路径）
   **一次都不问**。
4. 相对 `Location` **必须两跳**：`a.com/x` →(跨主机) `b.com/y` →(相对 `/z`)，
   断言最终是 `b.com/z` **而不是** `a.com/z`。
   （单跳分不出 base 用的是入口还是当前跳 —— `current === entry`，恒绿。）
5. `Location: file:///C:/x` → 拒绝，且不含文件内容。
6. **边界成对**：10 跳成功 + 11 跳超限报错（只测「11 跳失败」对 `>=10` 和 `>10` 都过）。
7. 重定向状态码但 `Location` 为 `null` → 报 `HTTP 302 Found`，不崩。
8. **300 和 304 带 Location 也不跟随** → 报 `HTTP 300/304`（锁 §1.4）。
9. `ctx.checkSpecifier` 为 undefined + 跨主机跳 → 拒绝（fail closed）。
10. 跨主机跳成功后**不写缓存**：同一 URL 连抓两次 → `fetch` 被调两轮。
11. 无重定向的普通 200 → 照旧写缓存（第二次不发请求），抬头**不含**「经 N 次重定向」。
12. `a→b→a→b` → 对 `b` **只问一次**（`approved` Set）。
13. **`canonicalHost`**（纯函数直测）：`localhost.`→`localhost`、`[::ffff:7f00:1]`→`127.0.0.1`、
    `[::ffff:127.0.0.1]`→`127.0.0.1`、`[::1]` 原样、`example.com` 原样。
14. **入口闸也补上了**：`specifierFor({url:'http://localhost./'})` 返回 `'localhost'`。
15. 权限弹框慢（桩里 `await` 一个 > `FETCH_TIMEOUT_MS` 的延时）后返回 allow →
    **后续跳仍能正常完成**，不报超时（锁「每跳新建超时」）。

接线测（新文件 `packages/core/src/checkSpecifierWiring.test.ts`）：

16. `ctx.checkSpecifier` 确实被注入；deny 规则 → `'deny'`。
17. ask + `canUseTool` 返回 `allow_session` → `'allow'`，且 **push 进 `sessionAllow` 的规则串是
    `WebFetch(<目标主机>)`**，不是入口主机。
18. ask + `canUseTool` 返回 `deny` → `'deny'`。
19. ask + `canUseTool` **缺席** → `'deny'`（对齐 [agent.ts:501-503](../../../packages/core/src/agent.ts#L501)）。
20. ask + `allow_persist` → `onPersistAllow` 被调。

**变异验证（两处）**：
- 把跨主机判断改成恒 `false` → 第 1 条必须变红。
- 把 `new URL(loc, current.href)` 改成 `new URL(loc, parsed.href)` → 第 4 条必须变红。

**真跑验证（三条）**：
- 重跑 `scratchpad/d5-repro.mts`，「✗ 绕过成立」必须翻转。
- **`Location: http://localhost.:<port>/` 必须被 `deny: WebFetch(localhost)` 拦住** ——
  这才是本次改动真正的验收线（§1.5）。
- 真外网 `http://github.com` → `https://github.com/`（同主机不同 scheme）：
  **不弹框、直接抓到**。

## 五、影响面 / 代价汇总

- **正常用法会多一次弹窗**：短链接、`doi.org` 之类必然跨主机。`default` 档下是 ask；
  `bypass` 档下 `decide` 照旧直接 allow（但会计入 `onAutoAllow` 计数）。
- 跨主机重定向的结果不进缓存 → 这类 URL 每次真抓。
- 跳数上限从「undici 默认 20」收到 10。
- `canonicalHost` 让 `WebFetch(localhost)` 这类规则**变严**：以前 `localhost.` 逃得掉，
  现在逃不掉。这是修复，但属于行为变化，写进 `docs/features.md`。
- `redirect:'manual'` 之后 OAuth 那种认证跳转更容易断在中途 —— 但 WebFetch 本来就不带
  cookie jar，属既有限制，非本改动引入。
