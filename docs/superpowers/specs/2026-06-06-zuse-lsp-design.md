# zuse LSP 代码智能工具设计

> 状态:设计稿(待评审)。日期:2026-06-06。
> 上游:[phase-roadmap.md](../plans/phase-roadmap.md) Phase 6.6。
> 关联:[WebSearch 设计](./2026-06-06-zuse-websearch-design.md)(数据驱动多后端注册表的同构范式)、[设置与权限设计](./2026-06-04-zuse-settings-and-permissions-design.md)(readOnly 工具不进权限闸)。

## 1. 目标与非目标

**目标**:给 zuse 加一个只读的代码智能工具 `Lsp`,让主模型能对项目代码做三件高频查询 —— **跳定义(definition)/ 找引用(references)/ 看类型(hover)**。底层走标准 LSP(JSON-RPC over stdio),按 cwd 懒启动对应语言服务器、会话内复用同一进程。镜像 Claude Code 的 LSP 工具行为:只读、无副作用、不进权限闸。

**非目标(v1 不做)**:

- 只做上述三件套。**不做** diagnostics(诊断)、补全(completion)、重命名(rename)、格式化(formatting)、code action —— 这些要么有副作用、要么不属于「读代码时想问的问题」。
- **不做全局符号搜索**(workspace/symbol)。v1 的入口是「某文件某行的某个名字」,不是「全项目找叫 X 的东西」。后者更接近 Grep 的领域。
- **不内置任何语言服务器二进制**。用户自行安装(本机已有的 jdk/maven/gradle、go、rustup 等照旧用);工具只负责 spawn 已安装的 server,没装就在错误里给安装命令。
- **不支持多 cwd**。一个会话对应一个工作目录(从首个 `ctx.cwd` 捕获)。
- **不覆盖以下语言/场景**:JSP(无可用的成熟 OSS LSP,落回 Read/Grep);Oracle/SQL(需连活库,LSP 适配差);C/C++/C#(需 compile-database / .sln,启动摩擦大,本期不预置)。这些不是 bug,是范围裁剪。

## 2. 架构总览

```
主模型 --(Lsp: {operation, file, symbol, line?})--> 工具 run()
                                  │
                                  ▼
              symbol.ts: 读文件 + 定位 symbol → 0-based LSP Position
                                  │
                                  ▼
              LspManager.get(langId)  ── 会话级进程池(按语言懒启动 + 复用)
                                  │
                                  ▼
              LspClient  ── 封装「一个 server 进程 + 一条 vscode-jsonrpc 连接」
                │  spawn → initialize 握手 → 就绪等待 → didOpen → 发请求
                ▼
        language server 子进程(typescript-language-server / gopls / ...)
                                  │
                                  ▼
        LSP Location[] / Hover ── 统一中间形态
                                  │
                                  ▼
              结果格式化为文本(file:line:col + 源码行 / hover 文本)→ ToolResult
```

三条设计原则(与仓库既有约定一致):

1. **数据驱动**:加一门语言 = `LANGUAGE_SERVERS` 配置表加一条,**零业务代码**。对齐 `providers`(多 provider)与 `BACKENDS`(WebSearch)的范式。就绪策略、安装提示、特殊启动参数都做成配置字段,不写成某语言的 `if` 分支。
2. **客户端无持久状态**:不落库、不缓存结果。状态只有「会话级进程池」—— 一个 `LspManager` 持有 `Map<langId, LspClient>`,进程随会话生灭。
3. **失败显式**:server 没装(ENOENT)、崩溃、握手/就绪/请求超时、符号没找到 —— 全部以 `isError` 回喂模型(故障模式④),且「没装」要直接给安装命令。

### 2.1 库选型(Approach A′:框架用库,语义手写)

| 用途 | 选用 | 说明 |
| --- | --- | --- |
| 传输 / RPC 框架 | **`vscode-jsonrpc`** | 微软出品、独立包,**不耦合 VS Code API**。负责 Content-Length 分帧、请求/响应/通知的 JSON-RPC 收发。`createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin))` 即得一条连接。 |
| 类型化消息定义 | **`vscode-languageserver-protocol`** | LSP 各请求/通知的 TS 类型与方法常量(`InitializeRequest`、`DefinitionRequest`、`ReferencesRequest`、`HoverRequest`、`DidOpenTextDocumentNotification`、`Location`、`Position` 等)。只取类型,不引运行时逻辑。 |

**明确不用**:`vscode-languageclient`(耦合 VS Code 扩展宿主 API,跑不进 Node CLI)、`vscode-languageserver`(是用来「写服务端」的,方向相反)。

**手写的部分(承载学习与设计价值)**:initialize 握手与能力协商、文档同步(didOpen)、就绪等待策略、符号名+行号 → Position 的定位、结果格式化、工具层、会话级进程池与生命周期。这些是「协议语义 + 业务编排」,正是该自己掌握的;而 Content-Length 分帧那种机械且易错、无学习增量的活,交给库。

## 3. 语言服务器配置表(`servers.ts`)

```ts
/** 服务器就绪策略 —— 何时认为「可以开始查了」。 */
export type ReadyStrategy = 'immediate' | 'awaitProgress' | 'awaitNotification'

/** 单门语言的服务器配置。加语言 = 加一条。 */
export interface LanguageServerConfig {
  /** 语言标识,兼作进程池的 key 与 LSP languageId。 */
  id: string
  /** 归属此语言的文件扩展名(含点,小写)。 */
  extensions: string[]
  /** 服务器可执行文件名(在 PATH 上查找)。 */
  command: string
  /** 启动参数(多数是 ['--stdio'] 这类)。 */
  args: string[]
  /** initialize 时传给服务器的 initializationOptions(可选)。 */
  initializationOptions?: unknown
  /** 就绪策略。缺省 'immediate'。 */
  ready: ReadyStrategy
  /**
   * awaitNotification 策略要等的服务器通知方法名(如 jdtls 的 'language/status')。
   * awaitProgress 策略无需此字段(等 $/progress 的 end)。
   */
  readyNotification?: string
  /**
   * 需要额外「数据目录」参数的服务器(如 jdtls 的 -data <dir>:它的索引/元数据缓存,
   * 不替代用户的 maven/gradle)。给一个临时目录,返回要追加到 args 的片段。
   */
  dataDirArg?: (tmpDir: string) => string[]
  /** server 不在 PATH 上(ENOENT)时回喂给模型的安装提示。 */
  installHint: string
}
```

**v1 预置 8 门**(覆盖用户实际技术栈 + 启动干净的服务器):

| id | 扩展名 | command(+args) | ready | 安装提示(installHint) |
| --- | --- | --- | --- | --- |
| `typescript` | .ts .tsx .js .jsx .mjs .cjs | `typescript-language-server --stdio` | immediate | `npm i -g typescript-language-server typescript` |
| `python` | .py .pyi | `pyright-langserver --stdio` | immediate | `npm i -g pyright` |
| `vue` | .vue | `vue-language-server --stdio` | immediate | `npm i -g @vue/language-server`(Volar 需 `initializationOptions.typescript.tsdk` 指向本机 typescript 的 lib 目录) |
| `java` | .java | `jdtls`(+ `-data <tmpDir>`) | awaitNotification(`language/status` 的 `ServiceReady`) | 安装 Eclipse JDT LS(提供 `jdtls` 启动脚本);本机需有 JDK |
| `rust` | .rs | `rust-analyzer` | awaitProgress(索引完成) | `rustup component add rust-analyzer` |
| `go` | .go | `gopls` | awaitProgress(索引完成) | `go install golang.org/x/tools/gopls@latest` |
| `lua` | .lua | `lua-language-server` | immediate | 装 `lua-language-server`(scoop/brew/手动);LÖVE API 智能靠项目级 `.luarc.json`,zuse 不内置 |
| `bash` | .sh .bash | `bash-language-server start` | immediate | `npm i -g bash-language-server` |

**扩展名 → 语言查找**:`lookupLanguage(filePath): LanguageServerConfig | null` —— 取文件扩展名(小写),在表里线性查找首个 `extensions` 命中的条目;无命中返回 `null`(工具据此报「不支持的文件类型」)。纯函数,易测。

**未预置但可后续加**(仅文档备忘,不写代码):C/C++(clangd,需 compile_commands.json)、C#(csharp-ls / OmniSharp,需 .sln)、Kotlin(kotlin-language-server,较不稳)。

### 3.1 就绪策略说明

服务器进程起来 ≠ 能正确回答。三种策略对应三类服务器:

- **`immediate`**:`initialize` 握手 + 发 `initialized` 通知后即可查(TS/JS、Python、Vue、Lua、Bash)。
- **`awaitProgress`**:服务器要先索引整个工程才能给准确结果(rust-analyzer、gopls)。等它通过 `$/progress`(workDoneProgress)报告 `end`,或到达就绪超时上限就放行。
- **`awaitNotification`**:服务器用自定义通知宣告就绪(jdtls 发 `language/status`,payload `type === 'ServiceReady'`)。等到该通知或超时放行。

就绪等待都带**总超时上限**(如 30s);超时不算致命 —— 降级为「直接开查」并在输出里加一行 note(慢索引语言首查可能不准,但不至于卡死)。

## 4. LspClient —— 封装「一个 server 进程 + 一条连接」(`client.ts`)

一个 `LspClient` 实例 = 一门语言的一个服务器进程。生命周期五阶段:

1. **启动**:`spawn(config.command, [...config.args, ...dataDirArg?])`,工作目录 = manager 捕获的 cwd。复用 Bash 的 spawn 经验(`findOnPath` 解析可执行、`killTree` 杀进程树 —— 见 §8 抽取)。spawn 失败(ENOENT)→ 抛带 `installHint` 的 `LspError`。
2. **握手**:`createMessageConnection` 建连 → `connection.listen()` → 发 `initialize`(传 `rootUri` = cwd 的 file:// URI、`capabilities`、`config.initializationOptions`)→ 收到 `InitializeResult` 后发 `initialized` 通知。
3. **就绪**:按 `config.ready` 等待(§3.1)。`awaitProgress`/`awaitNotification` 通过 `connection.onProgress` / `connection.onNotification` 监听;用一个带超时的 Promise 包装,先到者胜。
4. **干活**:
   - `openDocument(absPath, text)`:首次查某文件前发 `textDocument/didOpen`(languageId = config.id,version 1,带全文)。同一 client 内对同一文件只 open 一次(记一个 `Set<uri>`)。
   - `definition/references/hover(uri, position)`:发对应 LSP 请求,带**请求超时**与 `ctx.signal` 中断(任一触发即 reject)。
5. **关闭**:`dispose()` —— 发 `shutdown` 请求 + `exit` 通知,给一个短宽限期;进程没退就 `killTree(child.pid)` 兜底。连接 `dispose()`。

```ts
export class LspClient {
  // 内部:child、connection、opened:Set<string>、ready:Promise<void>
  static async start(config: LanguageServerConfig, cwd: string, signal: AbortSignal): Promise<LspClient>
  openDocument(absPath: string, text: string): void
  definition(absPath: string, pos: Position, signal: AbortSignal): Promise<Location[]>
  references(absPath: string, pos: Position, signal: AbortSignal): Promise<Location[]>
  hover(absPath: string, pos: Position, signal: AbortSignal): Promise<Hover | null>
  dispose(): Promise<void>
}
```

LSP 的 `definition` 返回可能是 `Location | Location[] | LocationLink[]`,client 内统一归一成 `Location[]`(LocationLink 取 `targetUri`+`targetRange`)。

## 5. LspManager —— 会话级进程池(`manager.ts`)

「前台」角色:按需请人(懒启动)、重复利用(同语言复用进程)、下班送客(进程清理)。

```ts
export class LspManager {
  // 内部:cwd?:string、clients:Map<string, LspClient>、starting:Map<string, Promise<LspClient>>
  setCwd(cwd: string): void            // 首次 run 时由工具调用,后续忽略
  async getClient(config: LanguageServerConfig, signal: AbortSignal): Promise<LspClient>
  async dispose(): Promise<void>       // 关闭所有 client
}
```

- **cwd 捕获**:`ToolContext` 不带项目根,manager 在**首个** `run()` 里用 `ctx.cwd` 调 `setCwd`,之后固定。
- **懒启动 + 复用**:`getClient(config)` 先查 `clients`;命中直接返回。未命中则 `LspClient.start(...)`,**用 `starting` Map 做 in-flight 去重**(并发两次查同语言时只起一个进程,第二次 await 同一个启动 Promise)。启动成功后存入 `clients`。
- **进程清理**:`LspManager` 在构造时注册一次性的 `process.on('exit')` 与 `SIGINT` 兜底,对所有存活 client 调 `killTree`(进程退出场景里来不及优雅 shutdown,直接杀树防孤儿进程)。同时暴露 `dispose()` 供 TUI 在会话结束时优雅关闭。
  > 现状:TUI 的 registry 是 `useMemo` 按会话构建,**没有**既有的 teardown/SIGINT 钩子(Ctrl+C 直接退)。故 manager 自带 `process.on` 兜底是必要的;`dispose()` 作为「将来 TUI 接了优雅退出就能调」的接口先留好。

## 6. 符号定位(`symbol.ts`,纯函数)

LSP 只认 `Position {line, character}`(均 0-based;`character` 默认是 UTF-16 码元偏移)。工具入参给的是「符号名 + 可选行号」,需翻译:

```ts
export interface SymbolLocation {
  position: Position
  matchedLine: number   // 实际命中的 1-based 行号(回喂给用户看)
}

/** 在 text 里定位 symbol。给了 line 就只在该行找;没给就全文找首次出现。找不到返回 null。 */
export function locateSymbol(text: string, symbol: string, line?: number): SymbolLocation | null
```

规则:

- **按词边界匹配**:用 `\bsymbol\b`(对 symbol 做正则转义)避免 `foo` 命中 `foobar`。
- **给了 line**(1-based):只在该行找;取**该行内首次出现**的列偏移。
- **没给 line**:全文逐行扫,取**首个命中行的首次出现**;`matchedLine` 告知模型实际命中在第几行。
- **一行内多次出现**:取首次出现即可 —— 同名标识符在同一行通常指向同一符号(`foo() + foo()`),跳转/引用结果一致;极少数「同一行不同符号」(如 `foo(foo)` 函数与同名变量)v1 不额外加列参数(YAGNI,接口向后兼容,日后真需要再加「第几次出现」)。
- **找不到**:返回 `null`,工具报 `isError`(「文件里没找到符号 X」/「第 N 行没有 X」)。

## 7. 工具输入 schema

```ts
interface LspInput {
  operation: 'definition' | 'references' | 'hover'  // 必填
  file: string      // 必填,经 resolvePath(cwd, file) 解析
  symbol: string    // 必填,要查的标识符
  line?: number     // 可选,1-based,用于消歧
}
```

单个工具 `Lsp`,用 `operation` 枚举分流(对齐「一个工具多操作」的紧凑做法,而非三个独立工具)。`inputSchema` 里 `operation` 用 `enum` 约束,description 说明三种语义与「`line` 帮助定位同名符号」。

## 8. 结果格式化

统一把 LSP 的 `file://` URI 转回路径(相对 cwd 展示),`Position` 转回 1-based 行列。输出整体受 `MAX_OUTPUT` 上限约束(对齐 Bash/WebSearch 的有界输出)。

- **definition**:每条 `相对路径:行:列`,并**读出目标行源码**作摘要:
  ```
  src/foo.ts:42:17
    export function fooBar(x: number): string {
  ```
  无结果(确实查无定义)→ `Definition not found for: <symbol>`,`isError: false`(查无是有效结果)。
- **references**:`Location[]` 按文件分组,每条 `行:列` + 行文本;**条数封顶**(如 100),超出尾部加 `… and N more references`。请求时 `context.includeDeclaration = true`。
- **hover**:取 `Hover.contents`(可能是 `MarkupContent` / `MarkedString` / 其数组),抽出文本(markdown 或 plaintext)拼成串,**长度封顶**。无 hover → `No hover info for: <symbol>`,`isError: false`。

### 8.1 从 bash.ts 抽取共用工具(`util.ts`)

`killTree(pid)` 与 `findOnPath(exe)` 现私有于 [bash.ts](../../../packages/tools/src/bash.ts),LSP 也要用。把这两个函数**移到 `packages/tools/src/util.ts` 并导出**,bash.ts 改为 import。`resolveShell`/`gitBashUnder` 是 Bash 专属,留在 bash.ts。抽取后给 `killTree`/`findOnPath` 补单测(原先无独立测试)。

## 9. 错误处理

| 情况 | 处理 |
| --- | --- |
| 文件类型无对应语言(`lookupLanguage` 返回 null) | `isError`,列出支持的语言/扩展名 |
| 服务器没装(spawn ENOENT) | `isError` + `config.installHint`(直接给安装命令) |
| 符号没找到(`locateSymbol` 返回 null) | `isError` + 提示(文件/行) |
| 服务器返回空结果(确实无定义/无引用/无 hover) | **不算错**,返回友好文本(见 §8) |
| 握手 / 就绪 / 请求超时 | 就绪超时 → 降级开查 + note;请求超时 → `isError` 说明 |
| 服务器进程崩溃(连接关闭) | `isError`;该 client 从池中剔除,下次查会重启 |
| 用户取消(`ctx.signal` aborted) | 返回 `Lsp cancelled.`(取消优先) |
| 文件读取失败(file 不存在等) | `isError` 透出原因 |

类型化错误 `LspError extends Error`(携带可选 `installHint`),工具层 catch 后统一映射为 `ToolResult`。

## 10. 权限

- **`readOnly: true`** —— 纯查询无副作用,`default` 模式自动放行,不进权限闸(对齐 roadmap 与 Read/Glob/Grep)。
- **`specifierFor`** 返回被查文件的绝对路径(与文件类工具一致),为将来可能的「按路径限定」规则留口;但因 readOnly,常态下不会触发 deny。

## 11. 接线

- **工厂模式**:`createLspTool(manager: LspManager): Tool`。工具需要会话级的进程池,而 `ToolContext` 不携带它,故用工厂在构造时注入 `manager`(对齐 `createWebSearchTool(config)` 的闭包注入)。
- **注册**:`createDefaultRegistry` 的 `opts` 增 `lsp?: LspManager`;传入时 `register(createLspTool(opts.lsp))`。LSP 工具**无条件可注册**(不像 WebSearch 依赖 key)—— 没装服务器是查询时才暴露的运行时错误,工具本身总该在。
- **TUI**:`App.tsx` 在 `useMemo` 里 `new LspManager()` 与 registry 同生命周期,传入 `createDefaultRegistry({ lsp: manager, webSearch: ... })`。manager 自注册 `process.on('exit')`/`SIGINT` 兜底(§5)。

## 12. 文件布局

| 文件 | 职责 |
| --- | --- |
| `packages/tools/src/lsp/servers.ts` | `LanguageServerConfig` 类型 + `LANGUAGE_SERVERS` 表 + `lookupLanguage` |
| `packages/tools/src/lsp/symbol.ts` | `locateSymbol`(符号名+行号 → Position),纯函数 |
| `packages/tools/src/lsp/client.ts` | `LspClient`(单进程 + vscode-jsonrpc 连接 + 五阶段生命周期)、`LspError` |
| `packages/tools/src/lsp/manager.ts` | `LspManager`(会话级进程池 + 清理钩子) |
| `packages/tools/src/lsp/index.ts` | `createLspTool(manager)`(单个 `Lsp` 工具)+ 结果格式化 |
| `packages/tools/src/lsp/*.test.ts` | 单测与集成测(见 §14) |
| `packages/tools/src/util.ts` | 接收从 bash.ts 抽出的 `killTree` / `findOnPath` |
| `packages/tools/src/bash.ts` | 改为从 util.ts import `killTree` / `findOnPath` |
| `packages/tools/src/index.ts` | `createDefaultRegistry` 接收并注册 `Lsp` |
| `packages/tui/src/App.tsx` | 构建 `LspManager` 并传入 registry |

## 13. 依赖

运行时依赖加到 `@zuse/tools`:

- `vscode-jsonrpc` —— 传输/RPC 框架。
- `vscode-languageserver-protocol` —— LSP 类型与方法常量。

二者均为纯 ESM/带 ESM 入口、可直接 `import`(契合 zuse 的 no-build / 原始 ./src exports)。实现首步须确认其 `package.json` 的 `exports`/`module` 字段能被 Node ESM 直接解析;若只有 CJS 入口,用 Node 的 CJS-interop 默认导入(`import pkg from '...'`)。

测试依赖(devDependency):

- `typescript-language-server` + `typescript` —— 作为 §14 集成测试的真实服务器基准。

## 14. 测试

**纯函数(常规单测,主力)**:

- `servers.ts`:`lookupLanguage` —— 各扩展名映射到正确语言;大小写不敏感;未知扩展名 → null。
- `symbol.ts`:`locateSymbol` —— 给 line 命中该行;不给 line 命中首次出现并报对 `matchedLine`;词边界(`foo` 不命中 `foobar`);一行多次出现取首个;找不到 → null;symbol 含正则元字符时被正确转义。
- 结果格式化:用样例 `Location[]` / `Hover` 负载断言输出文本(definition 带源码行、references 分组+封顶、hover 抽取+封顶、URI→相对路径、Position→1-based)。

**LspClient / LspManager(spawn 真进程,难纯测)—— 以 TS 作集成基准**:

- 把 `typescript-language-server` 作为 devDependency。集成测试里真起它,对一个 fixture `.ts` 文件跑 definition / references / hover,断言结果命中预期位置/文本。这兑现「TS/JS 走完整自测」,其余 7 门语言靠同一套配置驱动同一套逻辑(配置正确性靠 `servers.ts` 纯测覆盖)。
- 进程清理:dispose 后进程确实退出(或被 killTree)。
- in-flight 去重:并发两次 `getClient(同语言)` 只 spawn 一个进程。
- 集成测标记为可能较慢、依赖本机有该 server;CI 若无 server 二进制则跳过(用例内探测 `findOnPath`,缺失则 skip 而非 fail)。

## 15. 待评审 / 可能微调

- 就绪等待总超时阈值(暂定 30s)、references 条数上限(暂定 100)、hover/输出长度上限的具体取值。
- Vue(Volar)的 `initializationOptions.typescript.tsdk`:需指向本机 typescript 的 lib 目录;如何稳健定位(查 cwd 的 `node_modules/typescript/lib`?缺失时降级?)留待实现时定。
- jdtls 的 `-data` 临时目录位置与清理时机(随进程?随会话?)。
- `vscode-jsonrpc` / `vscode-languageserver-protocol` 的 ESM 可导入性需在实现首步实测确认(见 §13)。
