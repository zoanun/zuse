# 代码执行 Runner 设计 v3（取代 v1 / v2）

> v2 被独立评审判为「不能进入实现」，5 个 P0。根因不是细节写错，而是
> **v2 只改了 §1 的定位，§4/§5/§6/§8 全是 v1「跑一个代码块」的遗留** ——
> 于是它用 `npm run dev` 论证功能的必要性，再用 60s 超时 / 连接即生命周期 / 512KB 上限
> 把 `npm run dev` 杀三遍。v3 从两档的语义差异出发重写。

## 0. v2 错在哪（第三次认账，这次连模式一起记）

| v2 的说法 | 实测 |
|---|---|
| §3.1「`APPDATA` 必须留 —— uv 的解释器装在 `%APPDATA%\uv\python`，缺了起不来」 | **是编的**。uv 空 env 照跑（exit 0）；`APPDATA=C:\nonexistent-zzz` 也照跑。uv 走 `SHGetKnownFolderPath`，不读该变量 |
| §3.1「`SYSTEMROOT`/`PATHEXT` 缺了 Windows 上进程根本起不来」 | **是编的**。`java` 空 env（`env={}`）照样启动并输出「你好」 |
| §0 引用「PEP 723 冷装 374s」，§5 据此定 `installTimeoutMs=300s` | 374s **不可复现**（全新缓存重测 20.8s）。而且 300 < 374，引用自己的数字还定了个更小的值 —— 纯内部矛盾 |
| §5「以首个 stdout 字节切分 install/run 两段超时」 | **判据不成立**。只写 stderr 的程序（Python `logging` 默认走 stderr）永远拿不到 `runTimeoutMs` |
| §4 保留「连接即生命周期、不要 runId」 | 与 §2 的旗舰用例**不可能同时成立**：切会话/刷新页面就把 dev server 杀了 |
| §7/§8 保留 v1 的 `RunLang` + 固定 args | 跑不了 `mvn -q exec:java`。且 `-Dstdout.encoding` **无处可插**（mvn/gradle 不接受 JVM 参数直传） |
| 全文没写 `cwd` 从哪来 | 若接受请求体传入，`POST /api/run {cwd:"C:\\", cmd:"..."}` = 任意目录任意命令执行 |
| 全文没写 `.cmd`/`.bat` | 不带 `shell:true` 时 `mvn`/`vite` ENOENT；`spawn('mvn.cmd')` **同步抛 EINVAL**（不是 error 事件），daemon 会崩而不是报错 |

**这已经是第三次**在标着「实测」的位置写没测过的东西（前两次：Java `-Dfile.encoding`、右栏设计里不存在的 `.messages` 类）。
v3 的实测节**只写我或评审代理真跑过并贴了输出的**，其余一律标「未验证」。

**v2 做对、v3 原样保留的**（评审逐条实测过）：Java 用 `-Dstdout.encoding`/`-Dstderr.encoding`（不是 `file.encoding`，
且 `-J-D` 不被接受）、env 白名单的**方向**、逐路由 `isAuthed`、复用 `killTree` + 带 deadline 轮询、
不复用 ConsolePanel、新增 `RunLang` 且给 `transformsFor` 补 `never` 兜底、不声称跨管道严格交错。

## 1. 架构决定：不新建 run 子系统，先抽进程层

评审的核心建议，我采纳。理由是实读的：`packages/tools/src/bash.ts` 已经解决了

| 能力 | 位置 |
|---|---|
| shell 选型（git-bash → pwsh → cmd 三级回退） | `resolveShell()` 65-98 —— **`.cmd`/`.bat` 问题天然消失** |
| 跨 chunk 的 `StringDecoder` | 370-371 |
| Windows OEM 重解码 | 111-176 |
| 有界输出 + 落盘 | `StreamShaper` 361-365 |
| 杀进程树 | 复用 `util.ts:35-46` |
| Volta 递归守卫剥离 | 237（`buildChildEnv`） |

新建一套 = 全部重写一遍，**而且只有一半会被想起来** —— v2 就已经漏了 ANSI 转义和输出上界。

**做法**：抽 `packages/tools/src/proc/`（spawn + shell 选型 + 解码 + killTree + 有界缓冲），
`bash.ts` 与新的 run 服务各自在其上加策略。**这是纯提取重构，先做、单独验证、再上 run。**

不动 `bash.ts` 本身的对外行为：它是全仓测试最密的文件之一，且「后台 + 流式」要改 `ToolResult` 形态、
会波及 core 的工具协议。那是后续话题。

**顺带收益**：权限体系可以直接复用。`permission.ts` + `bash-security.ts` 已有命令级闸门
（`splitBashCommand` 逐子命令校验、混淆检测降级为 ask），用户也已经在用 `permissions.{allow,ask,deny}`。
用户点运行时**跳过 ask、但仍然尊重 deny** —— 一行代码换来一个已被测试覆盖的安全层，
比新造一套 env 白名单 + `passEnv` 逃生舱可靠，且不用学第二套心智模型。

## 2. 两档，两套语义（v2 最大的错是把它们混着写）

| | **片段运行** | **项目运行** |
|---|---|---|
| 场景 | 「写个快排看看」 | 多文件 Python / Java / `npm run dev` |
| cwd | 独立临时目录 | **会话的真实 cwd** |
| 命令 | runner 按语言固定 | **模型声明 + 用户可编辑**（§3） |
| 墙钟超时 | 300s | **无** |
| 空闲超时 | — | 默认无，可配 |
| 输出超限 | 截断 + 杀 | **环形缓冲，不杀** |
| 生命周期 | 连接即生命周期 | **真 runId + 可重连 + DELETE** |
| 同意粒度 | 每会话一次 | **按命令文本**（§6） |

### 2.1 为什么项目档不能有墙钟超时
`vite` 1 秒内就打 stdout，60s 后被 killTree —— **这个功能存在的唯一理由被自己的超时干掉了**。
要止损就用**空闲超时**（距上一个字节多久没动静）：死循环脚本不打字，dev server 一直打字，
这个判据把两者分得干净，且不依赖 stdout/stderr 归属。默认不开。

### 2.2 删掉「首个 stdout 字节」判据
实测：只写 stderr 的程序 `firstStdout = -1`，永远拿不到第二段超时。
装包阶段的提示改成纯 UI（「首 5s 没输出就显示『正在准备…』」），**不参与超时决策**。

## 3. 入口命令：模型声明 + 用户可编辑

v2 全文没说这条命令从哪来。三个方案里选 B：

- A. 从 `pyproject.toml` / `package.json` / `pom.xml` 探测 → 探测器要写三套，探不准时体验很差
- **B（选）**：模型在代码块 fence 上带 `run` 元信息（```` ```python run="uv run -m mypkg.cli" ```` ），
  或用一个 `propose_run` 工具声明；右栏把命令**明文显示在可编辑输入框里**，用户点运行 = 用户对这条命令负责
- C. 纯手输 → 作为 B 的兜底，不单独用

**为什么 B 是唯一诚实的同意形态**：知情同意从「你懂不懂后果」变成「你看这条命令行不行」。

**`cwd` 只能由服务端从 `sessionId` 反查**（`deps.service.list()` 已有每会话 cwd，`server.ts:580` 就是这么用的）。
**绝不接受请求体传入。**

## 4. 进程

- **必须走 shell**（或直接复用 `resolveShell()`）。实测：`mvn` 不带 shell → ENOENT；
  `spawn('mvn.cmd')` → **同步 throw EINVAL**。因此 `RunLang.command()` 返回一条命令串，不是 exec+args 数组。
- **在飞运行表**（真 runId）：daemon 退出时遍历 `killTree`、并发上限、临时目录 GC。
- `killTree` 实测三条链全部杀干净（uv→python、+ 普通 Popen 孙进程、+ `DETACHED_PROCESS` 孙进程），
  kill → `'exit'` 延迟 442~542ms。**测试要带 deadline 轮询**，不能立刻查。
  修正 v2 的说法：`DETACHED_PROCESS` **不是**孤儿路径（detach 只断控制台，不改 ParentProcessId）。
- 监听 `'close'` 为主 + `'exit'` 后 ~2s 宽限强制收尾。**先发 `timeout`/`aborted` 再发 `exit`**
  （kill 后拿到的是 `code=1, sig=null`，单看 code 分不出「退了 1」和「被杀」）。

## 5. 环境变量

方向不变（白名单），但**理由全部换成实测的**，且必须针对**项目模式的真实命令**重测。

已实测为真的：
- `PYTHONUNBUFFERED=1` 必需（不加则「流式」是假的）
- `PYTHONIOENCODING=utf-8` 必需（不加中文输出是 `???`）

未验证、但项目模式明显需要、**动手前必须逐个实测**：
`JAVA_HOME`（mvn/gradle 需要）、`VOLTA_HOME`（CLAUDE.md §五：Node 由 Volta 管，砍掉则 `node` 找不到）、
`SystemDrive` / `windir` / `ProgramData` / `ProgramFiles` / `ProgramW6432` / `HOMEDRIVE` / `HOMEPATH` /
`USERNAME` / `PROCESSOR_ARCHITECTURE`（MSVC / node-gyp / dotnet 工具链）。

**Java 编码在项目模式下不能靠命令行参数**（mvn 不接受）。实测 `JAVA_TOOL_OPTIONS` 可穿透：
```
JAVA_TOOL_OPTIONS="-Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8"  → stdout "你好"
```
代价：stderr 顶部多一行 `Picked up JAVA_TOOL_OPTIONS:`，前端要过滤。

**`passEnv` 逃生舱**：键名做白名单校验 + UI 里逐个勾选（不让人写数组），并**把即将传出的键名列给用户看**。
**必须写进 spec**：配置每会话只读一次（`createSession()` 里 `loadSettings()`），
改完 `passEnv` 要**新开会话**才生效 —— 否则用户会以为白名单坏了。

## 6. 安全

- 两条路由都 `isAuthed` + 严格校验 `content-type: application/json`。
- **同意按命令文本**：命令没变就不再问，变了就重新确认。
  （v2 的「每会话一次」在项目档下是洞：为 `python check.py` 同意过，
  模型下一条写成 `rm -rf build && deploy.sh` 不会再弹。）
- **非 loopback 绑定时 `codeRun` 默认关闭**。`startServer.ts:229-230` 有
  `plaintext HTTP on a network interface` 的警告，仓库里也有远程访问 TLS 设计 ——
  远程场景下这个按钮 = 拿到密码就能在别人机器上执行任意命令。
- 仍然不做沙箱，理由不变（做半个沙箱比不做更危险）。但**尊重 deny 表**（见 §1）。

## 7. 前端

- **不扩 `PreviewKind`**：`compile/script.ts` 的 `transformsFor` 有 `default` 分支，
  实测 python 源码会被原样当 JS 塞进 iframe（`errors=[]`、`js===原始 python 源码`）。
  新增 `RunLang` + `detectRunLang()`，并给 `transformsFor` 补 `never` 兜底。
- **`ActiveRun` 要改成判别联合**（现在 `kind: PreviewKind`），`Rail.tsx` 加分支。v2 一个字没提。
- **`RailRun` / `RailExec` 必须是兄弟槽位**，不能在 `RailRun` 内部三元切换 ——
  那会让 `PreviewFrame` 换位置，正是 `Rail.tsx:17-20` 那条注释警告的事。
- **终端输出区**（`<pre>` + chunk 拼接 + `\r` 处理）不复用 ConsolePanel（后者逐行 `<li>`、
  `ConsoleEntry` 无 `stream` 字段；实测 300KB 单行被切成 5 个 chunk，按 chunk 一个 `<li>` 会一行变五行）。
  v2 漏掉的两件事：
  - **ANSI 转义序列**（vite/pytest/cargo 全都上色）。要剥掉或做 ansi→span 渲染。**这是本块最大工作量。**
  - **输出上界**。`<pre>` 无限拼接 = dev server 跑一小时浏览器 OOM。必须环形缓冲。

## 8. 测试

- env 白名单：产出 env 不含任何 `KEY`/`TOKEN`/`SECRET` 键（**变异验证**：改回 `{...process.env}` 必须变红）
- Java 中文不乱码（字节级断言）；项目模式走 `JAVA_TOOL_OPTIONS`
- 两条路由未认证 → 401；`cwd` 不接受请求体传入
- daemon 退出时在飞进程被清理；并发超限 → 409
- 时间戳断言写成**下界**（`总跨度 > 阈值`），**绝不写上界**
- abort 后进程消失要**带 deadline 轮询**（实测 kill→exit 有 442~542ms 延迟）
- 项目档：墙钟超时不存在（长跑不被杀）；输出超限走环形缓冲而非 kill
- `.cmd` 入口（`mvn -v`）能起来 —— 锁住 §4 的 shell 决定

## 9. 已知不可修 / 明确不做
- stdout / stderr 是两条独立管道，Node **不保证**跨管道相对顺序（250ms 粒度上实测顺序正确，但别声称严格交错）
- 不做沙箱、不做包管理 UI、不做运行历史持久化
- 不改 `bash.ts` 的对外行为（只抽进程层）

## 10. 落地顺序
1. **抽 `packages/tools/src/proc/`**（纯重构，`bash.ts` 行为不变，全量测试须原样绿）
2. 服务端 run 服务（片段档先行，语义简单）
3. 前端 `RailExec` + 终端输出区（含 ANSI 与环形缓冲）
4. 项目档（runId / 重连 / 命令输入框 / 按命令同意）
