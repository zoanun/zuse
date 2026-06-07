# Phase 5.5.1：登录 shell 环境快照（shell snapshot）设计

> 状态：已实现。对应 roadmap Phase 5.5.1。
>
> **2026-06-07 更新**：原 §3 的"v1 仅 bash（Windows git-bash），POSIX 延后"取舍已撤销。
> 现已扩展到 **POSIX 的 bash 与 zsh**：`resolveShell()` 在 POSIX 上改为优先解析用户登录
> shell（`$SHELL`，取 bash/zsh），快照按 shell 类型生成对应 dump 语法。`/bin/sh`(dash 等)
> 仍优雅降级。下文 §2/§3/§4/§9/§10 已据此更新；提交于本次变更集。
>
> **2026-06-07 真机验证 + 两处 dump 修复**：在 WSL 真 Linux 上用 Node 22 直跑真实
> `ensureShellSnapshot` 端到端验证，发现并修复了原 dump 脚本的两个致命解析中断 bug
> （bash 的 extglob、zsh 的 run-help 别名碰撞），见 §2.1。同时记录一个 zsh 已知限制
> （别名不展开），见 §11。
>
> **2026-06-07 对齐 Claude Code 真实实现并重写**：参考 `cc-haha/src/utils/bash/ShellSnapshot.ts`
> 全量对齐，`shell-snapshot.ts` 重写。核心变化(详见 §2、§2.1、§4.1)：
> 1. **采集架构改为脚本内 `>>` 写文件**——不再抓 stdout + MARKER 切 banner，rc 欢迎语只去
>    stdout(丢弃)，从根上消除 banner 污染，`extractSnapshotBody`/`filterWinptyAliases` 两个
>    导出随之删除。
> 2. **`unalias -a` 置于快照开头 + 别名放最后**——这是 §2.1 两个解析 bug 的**更优统一解法**:
>    定义函数前先清空所有别名，zsh 的 run-help 碰撞与 bash 的别名冻结一并消失;原 zsh 的
>    `unsetopt/setopt aliases` 夹函数 hack 被取代删除。
> 3. **函数转储滤掉单下划线补全函数**(`grep -vE '^_[^_]'`，保留 `__` helper)——快照从约 95KB
>    缩到约 22KB(真机实测)，补全函数对非交互执行无用，且削掉大半 extglob 风险。
> 4. **一处有意偏离 CC**：CC 对 bash 函数逐个 base64+eval(坏函数隔离)；zuse 实测在 Windows
>    git-bash 对约 144 个函数各 spawn 一次 `base64` 构建耗时 6–8s 不可接受，改用内建
>    `declare -f "$func"` 循环(零 spawn)。extglob 风险已由前置 `shopt -p` + 过滤兜住。
> 5. 仍用 `-i -l`(非 CC 的纯 `-l`)：`-i` 让 `.bashrc` 的 `case $- in *i*) return` 守卫放行;
>    叠加脚本内显式 `source rc` 兜住 `.bash_profile` 未串联 `.bashrc` 的情况。已在带守卫的
>    `.bashrc` 上真机验证。
>
> 全部经 WSL 真机端到端验证(bash 5.2.21 / zsh 5.9)：函数+PATH 两 shell 均通;含系统
> bash-completion(extglob)时 source 无解析错误;zsh 别名不展开仍为 §11 已知限制。
> 原 §2/§10 关于"shell options 后置/不做"的表述已据 §2.1 订正。

## 1. 要解决的痛点

zuse 的 Bash 工具用 `spawn(shell, ...)` 跑命令。被 spawn 的子 shell **不是登录/交互 shell**，不会读 `.bashrc` / `.bash_profile` / `.profile`。后果：

- 用户在交互终端里定义的 **alias** 与 **shell 函数**在 zuse 跑的命令里全部消失。
- 用户 rc 文件往 `PATH` 注入的工具目录（nvm / mise / pyenv / 自定义 bin）也看不见——典型表现：终端里 `pnpm`/某脚本能跑，zuse 里 `command not found`。

> 注：本机的 Volta 把 shim 装在系统 PATH 上（`C:\Program Files\Volta\`），所以 `node`/`npm`/`pnpm` 本就可见；快照在本机的主要收益是 **git-bash `.bashrc` 里的 alias、函数、以及 rc 追加的 PATH**。

## 2. 方案概述（对齐 Claude Code 的 ShellSnapshot）

启动时**一次性**用登录+交互 shell 跑一段**构建脚本**，让 shell 自己把"sourcing rc 之后"的环境
**`>>` 追加写进**一个快照 `.sh` 文件；**此后每条 Bash 命令开头 `source` 这个快照**——一次性付
login shell 的钱，之后每条命令复用，不必每条都开 login shell（慢）。

> **为何写文件而非抓 stdout**：早期版本抓子进程 stdout、再用 `__ZUSE_SNAPSHOT_BEGIN__` 标记切掉
> rc banner。改为脚本内 `>>` 写文件后，rc 的欢迎语只去 stdout(被丢弃)，快照文件天然干净——
> 从根上消除 banner 污染，也不再需要 `extractSnapshotBody` 那套标记切割。这是 CC 的做法。

快照文件**内部的执行顺序刻意固定**为(由 `snapshotBuilderScript` 按此顺序 emit)：

1. **`unalias -a`**：定义函数前先清空所有别名。这是规避两类解析中断的统一手段(见 §2.1)，
   别名留到第 4 步再加回。
2. **shell 选项**：bash `shopt -p`(含 `extglob`，**必须在函数之前**——否则含 extglob 的函数体
   解析报错) + `shopt -s expand_aliases`(让非交互 `bash -c` 也展开 alias)；zsh 只恢复 glob 相关
   选项(`extendedglob` 等)。两者都**不照搬** `set -o`/全量 `setopt`——`errexit`/`pipefail`/
   `no_clobber` 等行为开关会破坏 bash.ts 的 `source 快照; 命令; 捕获 pwd; exit $?` 包装。
3. **函数**：bash `declare -f`、zsh `typeset -f`，二者均**滤掉单下划线补全函数**
   (`grep -vE '^_[^_]'`，保留 `__` 开头的 mise/pyenv helper)——补全函数对非交互执行无用、量大
   (本机曾约 144 个/95KB，过滤后约 22KB)，且其函数体常含 extglob，过滤同时削掉大半解析风险。
4. **alias**(放最后，函数已定义完不再碰撞)：剥掉 bash 的 `alias ` 前缀(zsh 裸 alias 无前缀)，
   统一加 `alias -- ` 前缀变可重新 source 的形式。Windows git-bash 额外**过滤含 `winpty` 的
   alias**(形如 `alias node='winpty node.exe'`，无 tty 管道里报 "stdin is not a tty" 坏掉输出)。
5. **PATH**：`printf 'export PATH=%q\n' "$PATH"`，`%q` 安全转义。

> **偏离 CC 一处**：CC 对 bash 函数逐个 base64 编码后单独 `eval`(坏函数只失败自己，不拖垮整份)。
> zuse 实测在 Windows git-bash 对约 144 个函数各 spawn 一次 `base64` 外部进程，构建耗时冲到
> 6–8s 不可接受，改用内建 `declare -f "$func"` 循环转储(循环内零进程 spawn)。extglob 解析风险
> 已由第 2 步 `shopt -p` + 第 3 步过滤兜住，故直接转储安全。

## 2.1 两个曾导致解析中断的 bug，及统一解法

函数转储会带进**依赖特定 shell 状态才能解析**的函数体；若 `source` 快照时该状态不就位，会在解析
函数那一步**报错中断**，中断点之后的 alias/PATH **全部丢失**(快照静默失效)。两类 shell 各踩一个：

1. **bash 的 extglob**：系统 `bash-completion` 的函数体含 `!(no-*)`、`@(...)` 等 **extglob** 语法，
   非交互 `source` 默认未开 extglob，解析即报 syntax error 中断。**解法**：①第 2 步把 `shopt -p`
   (含 extglob)排在函数**之前**恢复；②第 3 步过滤掉单下划线补全函数(extglob 的主要来源)。
2. **zsh 的 run-help 别名碰撞**：zsh 默认带 `run-help` 等**别名**，而函数转储含同名 autoload
   **函数**定义；别名展开开着时"定义与别名同名的函数"触发 `defining function based on alias`
   中断。**解法**：第 1 步 `unalias -a` 先清空所有别名，定义函数时已无同名别名可撞(也顺带解掉
   bash 的别名冻结问题)——比早期"`unsetopt aliases` 夹函数"的 hack 更通用，故后者已删除。

均经 WSL 真 Linux 端到端验证：bash 5.2.21 加载系统 bash-completion 后 `source` 快照 **stderr
全空、无解析错误**，func/PATH 正常；zsh 5.9 run-help 碰撞消失、func/PATH 正常。

## 3. 关键取舍：覆盖 bash 与 zsh，执行 shell 与建快照 shell 同款

执行 shell 必须与建快照的 shell **同款**，否则把一种 shell 的语法 `source` 进另一种会报错。为此 `resolveShell()` 的策略是：让执行 shell 就是用户的登录 shell，快照便天然同款。

`resolveShell()` 解析事实：

- **Windows**：优先返回 git-bash 路径 → label `bash`（不变）。没有 git-bash 时退 pwsh/cmd（这两类不建快照）。
- **POSIX**：改为优先解析用户登录 shell `$SHELL`——仅当它是 **bash 或 zsh** 才取（这两类快照已支持）；否则按序探测 `/bin/bash`、`/usr/bin/bash`、`/bin/zsh`、`/usr/bin/zsh`；都不可用才回退 `shell:true`（`/bin/sh`，label `sh`）。

因此快照在 **Windows git-bash、POSIX bash、POSIX zsh** 三种情形真正构建。仅当 POSIX 上既无 `$SHELL`(bash/zsh) 也找不到任何 bash/zsh 安装、落到 `/bin/sh`(dash 等，无 `declare -f`/`functions`) 时才**优雅降级**：不建快照，命令与现状完全一致。

> **未覆盖（明确延后）**：fish、nushell 等非 POSIX-sh-兼容 shell 的快照语法各异，且 `buildCwdCapture` 的 `pwd`/`$?`/`exit` 包装也未必适配，故不在本期支持——这类用户落到降级路径，命令仍能跑，只是没有快照增强。`ZUSE_SHELL` 环境变量可在两平台显式覆盖执行 shell。

## 4. 架构与单元边界

### 4.1 新文件 `packages/tools/src/shell-snapshot.ts`

职责：构建快照文件，返回**可直接 `source` 的路径**（正斜杠形式）或 `null`（不适用/失败）。

导出：

- `snapshotBuilderScript(opts): string`——生成交给 `shell -i -l -c` 执行的**构建脚本**。脚本(按需)
  显式 `source rc < /dev/null`，再把 `unalias -a` → shell 选项 → 函数 → 别名 → PATH 依次 `>>` 追加
  进 `opts.snapshotFile`。`opts.label === 'zsh'` 走 zsh 语法(`setopt`(仅 glob 项) / `typeset -f`)，
  否则走 bash 语法(`shopt -p` / `shopt -s expand_aliases` / `declare -f`)。别名转储与 PATH 两 shell
  共用。返回的脚本由 spawn 以 argv 传入，不经二次 shell 转义。
- `ensureShellSnapshot(shell: string | true, label: string): Promise<string | null>`——**记忆化**入口：首次调用真正构建，后续返回同一 Promise。`label` 非 bash/zsh 或 `shell` 非字符串路径，直接 `Promise.resolve(null)`。

> 早期版本的 `extractSnapshotBody` / `filterWinptyAliases` 两个导出已删除：改为脚本内 `>>` 写文件后
> 不再抓 stdout，banner 切割与 winpty 过滤都在构建脚本内完成。

构建步骤（`label ∈ {bash, zsh}`，`buildSnapshot`）：

1. `mkdirSync(~/.zuse/shell-snapshots/)`；快照文件 `snapshot-<label>-<pid>.sh`，rc 文件按 label 取
   `~/.bashrc` 或 `~/.zshrc`；路径统一转正斜杠(git-bash 的 `source` 不认反斜杠)。
2. `script = snapshotBuilderScript({label, snapshotFile, configFile, configFileExists})`。
3. `spawn(shell, ['-i', '-l', '-c', script], { stdio: ['ignore','ignore','ignore'], timeout: 10_000, env: {...process.env, SHELL: shell, GIT_EDITOR: 'true'} })`。
   - `-i -l`：`-i` 让 `.bashrc` 的 `case $- in *i*) return` 非交互守卫放行；`-l` 走 profile 链；
     脚本内还会显式 `source rc` 兜住 `.bash_profile` 未串联 `.bashrc` 的情况。
   - stdout/stderr 全 `ignore`：快照走文件，stdout 只剩 rc banner(丢弃)，stderr 是无 tty 噪音(丢弃)。
   - `GIT_EDITOR=true`：防 rc 里 git 钩子开编辑器卡住；`timeout: 10_000` 兜底。
4. `close` 后 `statSync(file).size > 0` 才算成功：注册 `process.once('exit', unlinkSync)` 清理，返回
   正斜杠路径；否则(空文件/spawn 错/异常)返回 `null`(降级)。

### 4.2 改 `packages/tools/src/bash.ts`

- 新增导出 `primeShellSnapshot(): Promise<string | null>`——`ensureShellSnapshot(SHELL, getShellLabel())` 的零参封装，供 TUI 启动时预热。
- `BashTool.run` 改为先 `await primeShellSnapshot()` 拿到 `snapshot`（记忆化，仅首次真正构建），再走原有 spawn 流程。
- `buildCwdCapture(command)` 增参 `buildCwdCapture(command, snapshot)`：
  - 仅 `label ∈ {bash, zsh, sh}` 返回对象（zsh 同样有稳定的 `pwd`/`$?`/`exit` 与反斜杠转义别名）。
  - `snapshot` 非空时，exec 串前缀 `source '<snapshot>' 2>/dev/null\n`。
  - cwd 回捕用的 `pwd` 加反斜杠转义为 `\pwd`，绕过用户可能 source 进来的 `pwd` alias，防止 `\pwd -W` 被改写破坏 cwd 捕获。
  - 退出码透传不变：`<前缀><命令>\n__zuse_ec=$?; \pwd -W 1>'file' 2>/dev/null; exit $__zuse_ec`。`$?` 紧跟用户命令，反映用户命令退出码（不被 source/pwd 的 0 掩盖）。

最终执行串形如：
```
source '/c/Users/x/.zuse/shell-snapshots/snapshot-123.sh' 2>/dev/null
<用户命令>
__zuse_ec=$?; \pwd -W 1>'/tmp/zuse-cwd-...' 2>/dev/null; exit $__zuse_ec
```
spawn 仍以 `cwd: ctx.cwd` 指定工作目录，快照不含 `cd`，故 `source` 不改变工作目录——cwd 持久化逻辑不受影响。

### 4.3 改 `packages/tools/src/index.ts`

re-export `primeShellSnapshot`。

### 4.4 改 `packages/tui/src/App.tsx`

挂载时 `useEffect` 里 fire-and-forget 调一次 `primeShellSnapshot()`，把 ≤10s 的首次构建挪到启动期，避免首条命令卡顿。失败无影响（降级）。

## 5. 数据流

```
App 挂载 ──prime──▶ ensureShellSnapshot(SHELL, label)
                        │ label∈{bash,zsh}?  否 → null（降级）
                        │ 是
                        ▼
              spawn(shell -ilc snapshotBuilderScript(...))
                   └─脚本内: source rc; unalias -a; 选项; 函数(过滤); 别名; PATH ──>> 写──▶
                                        ~/.zuse/shell-snapshots/snapshot-<label>-<pid>.sh
                   close 后 statSync.size>0 ? 返回正斜杠路径(记忆化) : null
Bash.run ──await prime──▶ snapshot 路径 ──▶ buildCwdCapture(command, snapshot)
                                              → exec = source 快照; 命令; 回捕 pwd; exit $?
                                              → spawn(exec, {cwd, shell:SHELL})
```

## 6. 错误处理与降级

- `label` 非 bash/zsh（如 `/bin/sh`、pwsh、cmd）：`null`，命令照旧（与现状一致）。
- spawn 失败 / 超时 / stdout 为空：`null`，命令照旧。
- 写文件失败：`null`，命令照旧。
- `source '<snapshot>' 2>/dev/null`：即便快照里某行报错也吞掉 stderr，不污染用户命令输出。
- 全程 best-effort：快照只是"把用户 rc 的副作用固化"，从不扩大权限面；失败时退回未快照行为，不阻断任何命令。

## 7. 安全

- 快照落在用户私有目录 `~/.zuse/shell-snapshots/`，文件名带 pid，进程退出 cleanup。
- 不引入新权限：快照内容来自用户自己的 rc，权限校验仍在 agent 循环上游按**用户原始命令**逐子命令过闸（快照前缀不参与权限判定——见 §8）。

## 8. 与权限校验的关系

权限判定 `decide()` 看的是模型给出的**原始命令字符串**（`specifier`），不是加了 `source 快照; ...; exit $?` 包装后的执行串。包装只在 `BashTool.run` 内部、过闸**之后**发生，因此快照不影响任何 deny/allow/ask 判定。这与现有 cwd 捕获包装的处理一致。

## 9. 测试策略

纯函数单测（对 `snapshotBuilderScript` 的输出做断言，跨平台稳定）：

- **通用结构**：含 `SNAPSHOT_FILE=`、(rc 存在时)显式 `source '<rc>'`、`printf 'export PATH=%q`；
  rc 不存在时不出现 `source '`；顺序铁律 **`unalias -a` → 函数 → `alias -- `**(别名在函数之后)；
  含 winpty 过滤分支 `grep -v "='winpty "`。
- **bash**：**`shopt -p` 在 `declare -F` 之前**(extglob 须先就位——§2.1 解法 1 的回归)；含
  `grep -vE '^_[^_]'`(过滤补全函数)、`declare -f "$func"`(内建循环转储)；**不含** `base64`(偏离
  CC 的回归)、**不含** `set -o `(不导出行为开关的回归)。
- **zsh**：用 `typeset +f`/`typeset -f`、含 `grep -vE '^_[^_]'`、含 `extendedglob`；**不含**
  `declare -F`、**不含** `base64`、**不含** `unsetopt aliases`(旧 hack 已被 `unalias -a` 取代的回归)。

集成测（`runIf(getShellLabel() ∈ {bash, zsh})`，本机 git-bash 会真跑；POSIX bash/zsh 上也会真跑）：

- `BashTool`：通过快照执行一条命令仍正常返回输出、退出码、cwd 持久化不被破坏。

真机端到端验证（WSL，不进 CI，开发期手动跑）：用真实 `ensureShellSnapshot` 在 bash 5.2.21 /
zsh 5.9 上建快照并 source 执行 probe，确认 func/PATH 传递、带系统 bash-completion(extglob)时
source 无解析错误、带非交互守卫的 `.bashrc` 也能拿到别名(验证 `-i` + 显式 source)。

## 10. 不做（YAGNI）

- **完整**固化 shell options。bash 只 emit `shopt -p`(§2.1 解法 1，extglob 等函数体能解析所必需) +
  `expand_aliases`；zsh 只恢复 glob 相关 setopt。两者都**刻意不导出** `set -o`/全量 `setopt` 里的
  `errexit`/`pipefail`/`no_clobber` 等行为开关——它们会改变用户命令的退出码/管道语义，破坏
  `source 快照; 命令; 捕获 pwd; exit $?` 包装(这是对 CC"照搬全部 options"的有意收敛)。
- **bash 函数 base64+eval**：CC 这么做(坏函数隔离)，zuse 因 Windows 逐函数 spawn 性能不可接受而
  改内建 `declare -f` 循环(见 §2 偏离说明)；extglob 风险已由 `shopt -p` + 过滤兜住，不引入 base64。
- fish / nushell 等非 POSIX-sh 兼容 shell 的快照（见 §3 未覆盖说明）。
- tmux 套接字注入（5.5.2）、sandbox（5.5.3）。

## 11. 已知限制：zsh 下用户别名不展开（v1 接受）

**现象**：zsh 登录 shell 的快照里 alias 能被正确 dump（`alias` 输出经 `sed` 统一加 `alias -- `
前缀变可重新 source 形式）并写进快照文件，但经 zuse 执行的命令里这些用户别名**不会展开**。
bash（含 Windows git-bash、POSIX bash）不受影响，别名正常展开。**已在 WSL zsh 5.9 真机复现**
(probe 输出 `ALIAS_NOEXPAND`)。

**根因（已铁证定位，非快照缺陷）**：`bash.ts` 用 `spawn(exec, { shell: SHELL })` 执行，等价
于 `zsh -c '<exec>'`。zsh 对 `-c` 字符串的语义是**先把整串解析完再开始执行**——所以当 zsh 解析
到"用户命令"那一行时，前面 `source 快照` 那行**尚未执行**，快照里定义的别名在解析期还不存在，
别名遂不展开。bash 的 `-c` 是**逐行解析**（解析一行执行一行），故 source 进来的别名对后续行可见。
已用对照实验证实：同一份 zsh 快照改用 **stdin 喂入**（`zsh` 从标准输入逐行读）时别名正常展开，
证明快照内容 100% 正确，问题纯在 `-c` 的执行策略。

**为何接受为 v1 限制（选项 A）而非改执行策略（选项 B）**：
- 真正的"command not found"痛点来自 **shell 函数**和 **rc 注入的 PATH**——这两样在 zsh 下已
  端到端验证可用。别名对一个"总是发出完整命令"的 AI agent 几乎无价值。
- 选项 B（把 `bash.ts` 的 POSIX 分支从 `-c` 改成 stdin/临时文件喂入）能让 zsh 别名也生效，但
  要重新验证信号转发、命令自身 stdin 继承、超时、以及绕开 Windows cmd/pwsh 分支，风险面与
  收益严重不成比例。
- 若未来确有 zsh 别名需求，B 的改法已记录在此，可单独立项。

bash 用户无此限制；zsh 用户的函数与 PATH 增强照常生效，仅个人 alias 不展开。
