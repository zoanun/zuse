# Zuse 项目工作规则

> 这份文件是**给在这个仓库里干活的 AI 看的**。全局规则见 `~/.claude/CLAUDE.md`，
> 这里只放本项目特有的东西。冲突时以全局那份的「文件与事实」铁律为准。

## 一、开发工作流（不可跳步）

每做一个功能，**严格按这个顺序**：

```
设计 → 写 spec → 开新子代理独立评审 → 与它讨论到对齐 → TDD 实现
     → 真跑验证 → 合本地 master → 写 docs/features.md
```

1. **写 spec**：落到 `docs/superpowers/specs/YYYY-MM-DD-<主题>-design.md`。
   spec 里要写清**取舍和代价**，不是只写方案。设计依据必须是**实测结果**，不是推断 ——
   实测过的事实单列一节，附命令和输出。
2. **开子代理评审**：spec 写完先派一个子代理挑毛病，**明确要求它别为了凑数编造问题**。
   讨论到双方认同再动手。
3. **TDD 实现**：先写会红的测试，再写实现。
4. **真跑验证**：见下面第三节。
5. **合本地 master**，然后往 `docs/features.md` 加一条**面向用户**的说明。

### 子代理的公正性（用户明确要求）

- **评审子代理必须新开**，绝不复用设计/实现它的那个代理 —— 会互相影响，评审就没意义了。
- 需要用户拍板的地方、自己拿不准的地方，**开子代理商议，按商议结果直接执行**，不要停下来等用户。
- 小改动也要走这一步。历史教训：favicon 那次因为「太小了不值得评审」而跳过，
  结果发了个 XML 都解析不了的文件出去。

## 二、自主边界

授权范围内可直接执行，**但这两条是硬线**：

- **不 push 到 origin**。只合本地 master。
- **不做破坏性/不可逆操作**（`git checkout --` 覆盖未提交改动、`reset --hard`、删数据）。
  历史教训：一次 `git checkout -- model-client.ts` 把整个重构冲掉了。
  要回滚就用 Edit 精确反向改，别用 checkout。

## 三、验证：测试绿 ≠ 能用

**这是本项目最重要的一条。** 曾经四个真实缺陷全部是测试全绿之后、真跑才暴露的：

- iframe 的 `onLoad` 把 ready 标志冲掉了
- 从 CJS 包 `export *` 得不到具名导出
- 三份 React 副本导致 dispatcher 为 null
- favicon 的 XML 注释非法，浏览器直接拒绝解析（当时只验证了「服务器能返回这个文件」——**那不算验证**）

所以：

- **改了网页 → 必须用真浏览器点一遍**（有 playwright MCP 可用）。
- **改了命令行行为 → 必须真敲那条命令看输出**，不是看单测。
- **断言某文件有问题 → 必须先用命令把原文打出来自证**（全局铁律）。
- 涉及外部工具链的测试用 `describe.skipIf(...)` + `ctx.skip()`，
  **跳过必须在报告里可见**，不许静默假绿。

### 变异测试

给关键护栏加测试后，**手工把实现改坏一处，确认测试真的变红**，再精确改回。
没做过变异验证的「护栏」很可能是纸糊的。

## 四、本项目的坑（都踩过）

| 坑 | 说明 |
|---|---|
| `.zuse/settings.local.jsonc` 覆盖全局 | daemon 读**项目级**那份。改 model / permissions 改本地这份；`contextWindow` 在全局 providers 里 |
| 配置读取用 daemon 的项目根 | `loadSettings()` → `findProjectRoot()` 从**daemon 进程 cwd** 往上找 `pnpm-workspace.yaml`。所以本仓库的配置在管**所有**会话，包括在别的目录里跑的 |
| 配置每会话只读一次 | `createSession()` 里 `loadSettings()` 一次。改完配置要**新开会话**才生效 |
| 改完 web 要 rebuild + 重启 | `pnpm --filter @zuse/web build` 再重启 daemon，否则用户刷的是旧包。用 `/restart` 技能 |
| 重启别传 `ZUSE_WEBDIR` | 传正斜杠路径会回退到旧 dev 页，看起来像版本回退。用内置 `defaultWebDir` |
| server 包真名是 `@zouyj/zuse-server` | `pnpm --filter` 写错会「无匹配 + 退出 0」，门禁空跑还显示绿 |
| 别在 git worktree 里验证跨包改动 | `@zuse/core` 软链指回主检出，会测到错误的分支代码 |
| `export *` barrel 会撞名 | `core/index.ts` 用了 `export *`，同名导出会 TS2308。注册表里的导出名要带前缀（`anthropicProviderModule` 而不是 `providerModule`） |
| Windows 子进程编码 | Python 要 `PYTHONIOENCODING=utf-8`。**Java 不是 `-Dfile.encoding`**（JDK 18+ 起它默认就是 UTF-8，设了等于没设 —— 实测字节仍是 GBK），要的是 `-Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8`（JDK 19+）。编译错误走 stderr，所以第二个不能漏。别用 `JAVA_TOOL_OPTIONS`：它有效但会往 stderr 多打一行 `Picked up …` |
| Python 管道输出是块缓冲 | 不加 `PYTHONUNBUFFERED=1`，「流式输出」是假的 |
| 用 zuse 开发 zuse 时 | 聊天里点 revert/retry 会回滚工作区、抹掉 CLI 改的未提交代码。点之前先 commit |

## 五、环境

- pnpm workspace monorepo：`packages/{core,protocol,server,tools,tui,web}`
- Windows 11 + PowerShell（PowerShell 侧串接用 `;`）；Bash 工具走 git bash
- 跑 Python 用 `uv run` —— **本机没有裸 `python`**
- Node 由 Volta 管。子进程要剥掉 `_VOLTA_TOOL_RECURSION`，否则子进程里 `node` 找不到
- 全量测试：`npx vitest run --root E:/ai-study/zuse`

## 六、代码风格

- **注释写「为什么」，不写「做了什么」。** 尤其要写清：为什么不选另一个方案、这里踩过什么坑、
  删掉这行会怎样。让后来的人不敢随手「精简」掉关键约束。
- 中文注释。
- 新增可扩展点用**显式注册数组**（见 `BUILTIN_PROVIDER_MODULES`），不要目录扫描 —— 打包后扫不到。
  注册表遇重复键**直接抛**：重复注册在运行期表现为「某项神秘失效」，抛出来才能在启动时暴露。
