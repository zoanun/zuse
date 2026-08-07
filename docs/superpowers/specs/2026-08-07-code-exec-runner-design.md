# 代码执行 Runner 设计（Python / Java 真跑）

> 承接 `2026-08-06-A1-preview-runtime-design.md`。A1 让前端语言（HTML/JS/TS/React/Vue）在浏览器 iframe 里跑起来；
> 本设计让**后端语言在用户本机真实执行**，输出流回页面。
>
> 内部曾用代号 "A2"，与已有的 `2026-07-29-A2-remote-access-tls-design.md` 撞号，故此文档不用字母代号，
> 统一称 **代码执行 Runner**。

## 0. 结论先行

- 用**本机已装的工具链**（uv 0.7.2 → cpython 3.11.12；Temurin JDK 21.0.9），不自带、不下载运行时。
- 执行发生在**服务端**（daemon 进程），不是浏览器。产物是终端式输出，不是渲染画面 —— 这与 A1 的预览是两种形态，共用同一个控制台面板。
- 传输用**单条 POST + NDJSON 分块流式响应**，`fetch` + `body.getReader()` 读。**这条响应本身就是这次运行的生命周期句柄**：连接断 = 运行终止。
- 安全上不假装有沙箱。这是**用户手动点击**触发的、在**本机单用户开发工具**里、执行**屏幕上就摆着的代码** —— 但仍需一次明确的知情同意，因为代码是模型写的，用户可能没读就点了。

## 1. 已实测的事实（设计依据，全部在本机 Windows 11 + PowerShell 上跑过）

| 事实 | 命令 | 结果 | 对设计的影响 |
|---|---|---|---|
| Java 单文件启动允许类名 ≠ 文件名 | `java Main.java`（内含 `public class Greeter`） | 正常输出，exit 0 | **不用解析 public class 名**，永远写死 `Main.java`。省掉一个易错的正则 |
| Python 管道输出是块缓冲 | 程序每 0.6s 打一行，`uv run` 管道接收 | 三行全在退出瞬间到达（间隔 <100ms） | **必须 `PYTHONUNBUFFERED=1`**。不加则"流式"是假的 |
| 加上 `PYTHONUNBUFFERED=1` 后 | 同上 | 恢复 0.6s 间隔 | 修法有效 |
| Java 管道输出 | 同类程序 | 天然 0.6s 间隔 | `System.out` 遇换行自动 flush，无需处理 |
| uv 支持 PEP 723 内联依赖 | 脚本头写 `# /// script` + `dependencies = ["cowsay"]` | uv 自动装包后正常运行 | **保留为特性**，但意味着会联网装包，知情同意里必须说 |
| 本机无裸 `python` | `python --version` | 无输出 | 只能走 `uv run`，不能 fallback 到 `python` |
| uv 已装解释器 | `uv python list --only-installed` | 3.11.12 / 3.10.17 | `uv run --no-project` 默认取 3.11 |

## 2. 服务端结构

新模块 `packages/server/src/run/`。

### 2.1 runner 注册表 —— 沿用 provider registry 的自注册模式

```ts
// runners/types.ts（纯类型）
export interface CodeRunner {
  /** 唯一语言键，与 web 侧 detect 出的 lang 对齐 */
  lang: string
  /** 写进临时目录的文件名 */
  filename: string
  /** 探测工具链是否可用。失败要返回可读原因，不许抛 */
  probe(): Promise<ToolchainProbe>
  /** 构造启动命令。dir 是这次运行的独立临时目录 */
  command(dir: string): { exec: string; args: string[]; env: Record<string, string> }
}
export interface ToolchainProbe {
  ok: boolean
  /** ok 时给版本串（"uv 0.7.2 · cpython 3.11.12"），否则给原因 */
  detail: string
}
```

`runners/index.ts` 用**显式数组**（与 `BUILTIN_PROVIDER_MODULES` 同构，不用目录扫描 —— 打包后扫不到）：

```ts
export const BUILTIN_RUNNERS: CodeRunner[] = [pythonRunner, javaRunner]
```

`buildRunnerIndex(runners)` 遇重复 `lang` 直接抛。理由与 provider registry 相同：**重复注册在运行期表现为"某个 runner 神秘失效"，抛出来才能在启动时暴露**。

导出名必须全局唯一（`pythonRunner` / `javaRunner`，不要都叫 `runner`）—— `core/index.ts` 那次 TS2308 撞名的教训，`server/index.ts` 同样有 barrel。

将来加 Go / Rust / C#：新建一个文件 + 数组里加一项，不动别处。

### 2.2 两个内置 runner

**python**
```
exec: 'uv'
args: ['run', '--no-project', 'main.py']
env:  { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
probe: uv --version（拿不到就 ok:false，detail 指向 https://docs.astral.sh/uv/）
```
`PYTHONIOENCODING=utf-8` 不是可选项：Windows 默认 OEM 代码页，中文 `print` 会乱码。本项目在 steer 持久化那轮已经踩过一次 OEM 解码。

**java**
```
exec: 'java'
args: ['-Dfile.encoding=UTF-8', 'Main.java']
env:  {}
probe: java -version（走 stderr，注意别只读 stdout）
```
用 JEP 330 单文件源码启动，**不单独 javac**：少一个进程、少一个中间产物、报错信息一样好。

### 2.3 RunService —— 生命周期

```ts
run(lang, code, signal): AsyncIterable<RunEvent>
```

1. 建独立临时目录 `~/.zuse/runs/<runId>/`（`runId` 用 crypto 随机）。**不在项目 cwd 里跑** —— 模型写的 `open('out.txt','w')` 不该落进用户仓库。
2. 写入源码文件（`main.py` / `Main.java`）。
3. `spawn(exec, args, { cwd: dir, env: {...process.env, ...runner.env}, stdio: ['ignore','pipe','pipe'], windowsHide: true })`。
   **stdin 用 `'ignore'` 而不是留着** —— 否则 `input()` 会永久挂起直到超时，用户看到的是"卡住"而不是"这里需要输入"。`'ignore'` 让它立刻拿到 EOF，抛一个明确的 `EOFError`。
4. stdout / stderr 分别按块 emit，标 `stream` 字段。**不做行缓冲**：进度条这类 `\r` 输出按行缓冲会全丢。
5. 结束 emit `exit`，然后 `rm -rf` 临时目录。

**三道硬闸**（都在服务端，不信任前端）：

| 闸 | 默认值 | 触发后 |
|---|---|---|
| 墙钟超时 | 60s | kill 进程树，emit `{type:'timeout'}` |
| 输出字节上限 | 512 KB | emit `{type:'truncated'}`，kill 进程树 |
| 连接断开 | — | kill 进程树 |

**kill 必须杀进程树**。`uv run` 会 fork 出真正的 python 子进程；只 kill uv 会留下孤儿 python 继续跑、继续占 CPU、继续写文件。Windows 上用 `taskkill /PID <pid> /T /F`，POSIX 上用 `process.kill(-pid)` + `detached: true`。这一条不写测试就一定会漏。

### 2.4 HTTP 接口

```
GET  /api/run/toolchains   → { python: {ok, detail}, java: {ok, detail} }
POST /api/run              → 200, Content-Type: application/x-ndjson，分块流
     body: { lang, code }
```

**没有 `DELETE /api/run/:id`，也没有 runId 表。** 中止 = 前端 `AbortController.abort()` → 连接断 → 服务端 `res.on('close')` → 杀进程树。
这样换来的：无跨请求状态、无孤儿运行需要 GC、无 runId 泄漏、刷新页面自动收尾。
代价：页面刷新会终止运行（这里其实是**想要**的行为），且没有断线重连（运行都是秒级，不需要）。

NDJSON 事件（每行一个 JSON）：
```jsonc
{"type":"started","toolchain":"uv 0.7.2 · cpython 3.11.12"}
{"type":"out","stream":"stdout","text":"..."}
{"type":"out","stream":"stderr","text":"..."}
{"type":"exit","code":0,"ms":812}
{"type":"timeout"} | {"type":"truncated"} | {"type":"error","message":"..."}
```

`toolchains` 探测结果缓存 30s：让 UI 能提前置灰并说明原因，而不是点下去才失败；30s 又短到用户装完 JDK 刷个页面就能生效。

## 3. 前端

- `preview/detect.ts` 扩表：`python|py` → `python`，`java` → `java`。
- **后端语言不进 iframe**。新增 `RunPanel`，复用 A1 的 `ConsolePanel` 渲染输出（stderr 用告警色），底部一个「停止」按钮。
- 复用 `activePreview` 单例：同一时刻只有一个东西在跑 —— 切走会 abort 掉当前运行，这与"只保留一个预览"的既有心智一致。
- 按钮态：模型还在输出时置灰（同 A1）；工具链不可用时置灰 + tooltip 给 `detail` 原文。

## 4. 知情同意

这是本设计唯一需要"表态"的地方，把理由写清楚：

**为什么需要**：A1 的预览跑在 iframe 里，最坏结果是页面卡住。本设计**在用户账户下真实执行代码**，能读写整个文件系统、能联网、能装包。且代码是**模型写的**，用户完全可能没细读就点了运行。

**为什么不做沙箱**：本项目定位是本机单用户开发工具，daemon 已经有 Bash 工具在跑任意命令。做一个真沙箱（容器 / seccomp / Job Object）的成本远超收益，且**做半个沙箱比不做更危险** —— 它会让用户以为安全。所以：不做，但要说实话。

**做法**：每个会话首次点运行时弹一次确认，明说会在本机真实执行、能读写文件和联网、Python 还可能按内联声明装包；带「本次会话不再提示」。加设置开关 `codeRun.enabled`（默认 true）供彻底关掉。

`RawSettings` 增补：
```ts
codeRun?: { enabled?: boolean; timeoutMs?: number; maxOutputBytes?: number }
```

## 5. 测试

不可信的绿灯没有意义，所以分两层：

**逻辑层（无工具链也能跑，任何机器都绿）**
- runner 表：重复 lang 抛错；python/java 在表内；`command()` 形状（含 `PYTHONUNBUFFERED`、`-Dfile.encoding=UTF-8` 两条断言 —— 它们是实测得出的必要条件，删掉就退回块缓冲/乱码）
- NDJSON 组帧：分块边界切在 JSON 中间时客户端能正确拼回
- 输出上限：喂超量数据 → 收到 `truncated` 且 spawn 出来的假进程被 kill
- 超时：假时钟推进 → kill + `timeout` 事件
- probe 失败：exec 不存在 → `{ok:false, detail}`，不抛

**真跑层（`describe.skipIf(!toolchainPresent)`）**
- python：打印中文 → 收到的不是乱码（锁死 `PYTHONIOENCODING`）
- python：分三次 sleep 打印 → **事件到达时间戳确实分散**（锁死 `PYTHONUNBUFFERED`；这是唯一能证明"流式是真的"的断言）
- python：`input()` → 拿到 EOFError 而不是挂住
- java：类名与文件名不符 → 正常运行（锁死 2.2 里"不解析类名"的决定）
- abort：中止后**真实 python 进程不再存在**（用 tasklist / ps 核实，不是只看事件）

`skipIf` + `ctx.skip()` 的组合是既有约定 —— 跳过要在报告里显式可见，不能静默假绿。

## 6. 明确不做

- 不做多文件工程、不做 stdin 交互、不做图形输出（matplotlib 存图后展示是后续话题）
- 不做包管理 UI —— Python 走 PEP 723 内联声明就够，Java 不支持第三方依赖
- 不做运行历史 / 结果持久化
- 不做真沙箱（理由见 §4）
