# 代码执行 Runner 设计 v2（取代 2026-08-07 v1）

> v1 被独立评审判为「不能进入实现」，5 个 P0。同时用户提出 v1 的核心前提是错的：
> 他写的 Python 分多个文件，而 v1 §6 明确「不做多文件工程」。
> **v2 换掉的是定位，不是细节。**

## 0. v1 错在哪（先认账，免得 v2 重蹈）

| v1 的说法 | 实际 | 来源 |
|---|---|---|
| 「实测事实全部在本机跑过」，§2.2 给 Java 配 `-Dfile.encoding=UTF-8` | **这条根本没测**。JDK 18 起（JEP 400）该参数与控制台编码解耦，JDK 21 上无效，中文输出仍是 GBK（`c4e3bac3`）。正确参数是 `-Dstdout.encoding` / `-Dstderr.encoding`（实测转为 `e4bda0e5a5bd`） | 评审实测 |
| §2.3 `env: {...process.env, ...}` | **泄露 4 个真实凭据**：`GH_TOKEN`、`OSS_ACCESS_KEY`、`OSS_SECRET_KEY`、`BAILIAN_CODING_PLAN_API_KEY`。且 §4 的知情同意**一个字没提环境变量** | 评审实测 |
| §1 把 PEP 723 内联依赖「保留为特性」，§2.3 定 60s 超时 | 冷装 pandas+matplotlib 实测 **374s**，是上限的 6.2 倍。首次使用的默认路径必然超时 | 评审实测 |
| §2.4「无孤儿运行需要 GC」 | `taskkill /T` 在父子链完整时确实杀得干净（这点对），但有 3 条路径产生永久孤儿：中间进程先死、daemon 重启、模型代码 `Popen` 后台进程。孤儿还让 `rm -rf` 报 EBUSY，`~/.zuse/runs/` 只增不减 | 评审实测 |
| §2.4 两条路由 | **一个字没写鉴权**。项目约定是每条路由自己 `isAuthed`（server.ts 里 46 处），没有全局中间件。按字面实现 = 无鉴权 RCE | 评审实读 |
| §6「不做多文件工程」 | 用户实际就是分多文件写 Python。**这个限制是从 A1 浏览器沙箱思路顺下来的，对后端语言不成立** | 用户 |

评审同时确认 v1 **对**的部分，v2 原样保留：`res.on('close')` 断连感知（三种断法均 2ms 内触发）、
NDJSON 而非复用 WS（复用 WS 必然要请回 runId 做多路复用）、时间戳断言写成**下界**不会 flaky、
`PYTHONUNBUFFERED=1` 确有必要、stdin 用 `'ignore'`、runner 自注册表。

## 1. 定位改变：从「跑一个代码块」到「在项目里跑一条命令」

v1 把代码写进临时目录的 `main.py` 再跑。多文件一来，`from utils import x` 立刻断 ——
**「复制到临时目录」这一步本身就是问题的来源**。

v2 分成两档，主次颠倒：

| 档 | 场景 | cwd | 多文件 |
|---|---|---|---|
| **项目运行（主）** | 模型把项目写进磁盘，用户要跑 | **会话的真实 cwd** | 天然支持，`import` 正常解析 |
| 片段运行（次） | 「写个快排看看」这种一次性代码块 | 临时目录 | 不支持，也不需要 |

片段运行降级为附属能力，不再是主线。

## 2. 为什么这是个新能力，而不是「让模型自己用 Bash 跑」

`packages/tools/src/bash.ts` 实读：

```
13: const DEFAULT_TIMEOUT = 120_000     // 2 分钟
15: const MAX_TIMEOUT     = 600_000     // 10 分钟封顶
```

Bash 工具是**一次性**的：输出等进程结束才整体返回（不流式），超时即杀，**没有后台模式**。
所以 `npm run dev` 这类常驻进程用它跑必然超时被杀。

缺的是：**在真实目录跑一条命令 + 流式输出 + 可中止 + 不受 Bash 超时约束**，
外加 web 项目把 dev server 端口嵌进右栏。

## 3. 安全（v1 最大的漏洞在这）

### 3.1 环境变量白名单（P0，代价近乎为零）

**不再 `{...process.env}`。** 只传必需项：

```
Windows: PATH, PATHEXT, SYSTEMROOT, TEMP, TMP, USERPROFILE, APPDATA, LOCALAPPDATA,
         NUMBER_OF_PROCESSORS, OS, COMSPEC
POSIX:   PATH, HOME, TMPDIR, LANG, SHELL, USER
+ runner 自己声明的（PYTHONUNBUFFERED 等）
```

`APPDATA` 必须留 —— uv 的解释器装在 `%APPDATA%\uv\python`，缺了 Python 起不来。
`SYSTEMROOT`/`PATHEXT` 缺了 Windows 上进程根本起不来。

**白名单而非黑名单**：黑名单（`delete env.X_KEY`）挡不住 `OSS_SECRET_KEY` 这类项目外命名。
测试断言：`ZUSE_API_KEY`、`GH_TOKEN`、任何含 `KEY`/`TOKEN`/`SECRET` 的键都不在产出 env 里。

**代价**：项目运行档下，用户**可能真的需要**某些 env（比如 `DATABASE_URL`）。
对策：设置项 `codeRun.passEnv: string[]` 显式点名放行，默认空。显式动作，有摩擦是对的。

### 3.2 鉴权（P0）
两条路由都必须 `isAuthed`，并严格校验 `content-type: application/json`
（挡掉 simple-request 形态的跨站 POST）。cookie 是 `SameSite=Lax`（server.ts:190-197）
已有兜底，但那是**恰好**安全不是设计安全；且 GET 路由在 Lax 下顶层导航仍会带 cookie。

### 3.3 知情同意改写
v1 说「能读写文件、能联网、能装包」。**必须补上**：
- 「能读到 zuse 进程的环境变量」→ v2 白名单后这条不再成立，改成「**不会**拿到你的 API key 等凭据」
- 项目运行档要明说「在你的真实项目目录里跑，能改你的代码和数据」

v1 §4「daemon 已有 Bash 工具所以无所谓」这个论证**删掉** ——
Bash 有 permission 三层表 + 用户审批，这里没有；Bash 是模型发起用户审批，这里是用户点击、无第二人复核。
正确表述：「本地单用户工具，我们用 env 白名单 + 独立进程 + 硬超时把风险压到可接受，
但不做沙箱 —— 做半个沙箱比不做更危险」。

## 4. 进程生命周期（P0-4 的修正）

v1 说「无跨请求状态、无孤儿需要 GC」。**保留 runId/DELETE 的简化（评审认可），
但必须恢复一张在飞运行的内存 Set**：

- daemon 退出时（`SIGINT`/`beforeExit`）遍历 Set 逐个 `killTree` —— 否则重启留残留（实测会）
- 并发上限（默认 2）：`activePreview` 是**模块级变量 = 每标签页一份**，
  多标签页时前端根本不设防。超限返回 409
- 临时目录清理：`rm -rf` 包 try/catch + 重试；启动时扫 `~/.zuse/runs/` 清陈旧目录

**复用而非重写**：`packages/tools/src/util.ts:35-46` 已有 `killTree`（Windows `taskkill /T /F` +
POSIX 负 pid），只是没从 barrel 导出，加一行 export 即可。tsup 对 `@zuse/*` 是 `noExternal`，跨包无打包问题。

**结束事件**：监听 `'close'` 为主，另挂 `'exit'` 后 ~2s 宽限定时器强制收尾。
（实测：孤儿孙进程继承 stdout 管道时，`'exit'` 169ms 触发而 `'close'` 13 秒都不来。
只听 `'close'` 会让响应永不结束；只听 `'exit'` 会丢最后几行输出。）
kill 后拿到的是 `code=1, sig=null`，单看 code 分不出「程序退了 1」和「被杀」，
所以**必须先发 `timeout`/`aborted` 事件再发 `exit`**。

## 5. 超时分段（P0-3）

```
installTimeoutMs  默认 300s   只覆盖到「首个 stdout 字节」之前
runTimeoutMs      默认 60s    首字节之后开始计
```

不直接把 60s 调大 —— 那会让死循环脚本白占 5 分钟。
UI 在装包阶段显式提示「正在安装依赖（首次较慢）」。

**顺带**：uv 的下载进度走 **stderr**。若照 v1 §3「stderr 用告警色」，
一次成功的装包会满屏红色警告。装包阶段的 stderr 要单独归类。

## 6. 输出通道（P1-1：v1 自相矛盾）

v1 §3 说复用 A1 的 `ConsolePanel`，§2.3 又说「不做行缓冲，否则 `\r` 进度条全丢」。
**两者不可能同时成立** —— ConsolePanel 是逐行 `<li>` 渲染（ConsolePanel.tsx:15-22），
`ConsoleEntry` 也没有 `stream` 字段（types.ts:42-49）。
实测 300KB 单行被切成 5 个 chunk，按 chunk 一个 `<li>` → 一行变五行。

**v2 决定：做真正的终端输出区**（`<pre>` + 前端 chunk 拼接 + `\r` 回车处理），
不复用 ConsolePanel。理由：v1 §0 自己说「产物是终端式输出」，
而 ConsolePanel 是为 `console.log` 事件流设计的，形态本就不同。
「共用同一个控制台面板」是想当然的复用。

## 7. 语言类型不要挤进 `PreviewKind`（P1-3）

v1 §3 说扩 `detect.ts` 让 `python` → `PreviewKind`。但 `compile/script.ts:15-22` 的
`transformsFor` 有 `default` 分支、无 exhaustive 检查，
`compile/index.ts:29-44` 会原样返回 `{ js: <python 源码>, errors: [] }` ——
**Python 源码会被静默塞进 iframe 当 JS 跑**。

v2：新增独立的 `RunLang = 'python' | 'java'` 与 `detectRunLang()`，
CodeBlock 先判 run 再判 preview。顺手给 `transformsFor` 补 `never` 兜底。

## 8. Java 编码（P0-2）

```
args: ['-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', 'Main.java']
```

**不是** `-Dfile.encoding`（JDK 21 无效）。也**不能**写 `-J-D...`（单文件启动器不吃 `-J`，
实测 `Unrecognized option`）。
测试必须加一条 **java 中文用例**，且逻辑层断言要断 `stdout.encoding` ——
v1 的断言会把错误参数固化成绿灯，那比 bug 本身更糟。

## 9. 测试补强

除 v1 已有的，追加：
- env 白名单：产出 env 里不含任何 `KEY`/`TOKEN`/`SECRET` 键（**这条要变异验证**：
  改回 `{...process.env}` 必须变红）
- java 中文输出不乱码（字节级断言，不是看着像）
- 两条路由未认证 → 401
- daemon 退出时在飞进程被清理
- 并发超限 → 409
- 时间戳断言写成**下界**（`总跨度 > 阈值`），**绝不能写上界** —— 慢机器只会让跨度更大
- abort 后进程消失要**带 deadline 轮询**（10s 内每 200ms 查），
  不能立刻查：`killTree` 是 fire-and-forget，实测 taskkill 到 `'exit'` 有 ~2.3s 延迟

## 10. 已知不可修，但要写进文档
stdout / stderr 是两条独立管道，Node **不保证**跨管道相对顺序，同一毫秒内写的可能倒置。
实测在 250ms 粒度上顺序正确，但别声称严格交错 —— 免得日后被当 bug 查。
