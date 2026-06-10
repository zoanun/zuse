# 输入层重构 + 文本粘贴折叠 设计文档

- 日期:2026-06-10
- 状态:待评审
- 范围:`packages/tui`(zuse TUI)
- 相关参考实现:`e:/ai-study/cc-haha`(termio + parse-keypress 输入栈)

## 1. 背景与动机

当前 zuse 用官方 **stock Ink** 的 `useInput`,有两个长期痛点:

1. **Shift+Enter 换行靠 hack**。普通终端把 Enter/Shift+Enter 编成同一字节,stock Ink 无法区分,现在只能靠 `/terminal-setup` 在 VSCode 系集成终端里重映射(见 `inputKeymap.ts` 注释)。
2. **粘贴无法可靠识别**。stock Ink 不提供 `isPasted` 标志,大段粘贴还会被 node 的 stdin 缓冲在任意位置切碎,无法稳定地把"粘贴"与"逐字输入"区分开。

需求起点:用户向输入栏粘贴多行文本后,应把这段文字**折叠成一个紧凑的标签**(显示行数/字数),而不是把整片文字铺在输入框里。

经评估,可靠的 `isPasted` 必须**自己接管 stdin 做 bracketed paste 解析**,无法在 stock Ink 之上轻量获得;而一旦接管 stdin,顺带就能用 CSI-u / modifyOtherKeys 协议**原生识别 Shift+Enter**,根治痛点 1。故本设计一次性重构输入层,并在其上实现粘贴折叠。

### 决策记录:为什么不走"启发式 + 合并"的轻量方案

曾考虑留在 stock Ink、用启发式("一次 input 含 `\n` 即判为粘贴")+ 定时器合并切碎的块。它能覆盖**文本粘贴折叠**与**拖拽文件附件**(终端把文件路径当文本发进 stdin),但:

- 做不到 **Ctrl+V 剪贴板位图/截图**——这种粘贴 stdin 上没有任何信号,只有 bracketed paste 的空粘贴标记能侦测;
- 不能根治 Shift+Enter。

用户后续明确想要剪贴板图片 / 多模态附件,故选择现在就铺设可复用的输入层地基(本设计),把附件本身留作**独立的后续一期**(数据模型 + 多模态送 provider + 附件标签,与本设计正交)。

## 2. 目标与非目标

### 目标
- 在 `packages/tui` 内自建输入子系统,独占 `process.stdin`,Ink 退化为纯渲染器。
- 移植裁剪版 termio tokenizer + parse-keypress,获得跨 chunk 稳定的按键/序列解析与 `isPasted`。
- 根治 Shift+Enter:现代终端原生换行;保留旧兜底路径。
- 实现文本粘贴折叠:多行粘贴折叠为占位符标签,原子编辑,提交时展开为全文发给模型,滚动区保留折叠标签。

### 非目标(本设计不做)
- 剪贴板位图 / 图片粘贴、文件附件、音视频附件(独立后续一期;本期仅**预留** `isPasted`/空粘贴事件钩子)。
- 鼠标事件(x10 / SGR)、OSC 查询/回包解析、终端能力探测回包解析。
- 完整终端仿真。

## 3. 总体架构

**核心决策:Ink 只做渲染,我们独占真实 stdin。**

入口 `render(<App/>, { stdin: dummyStream })` 给 Ink 喂一个非 TTY 哑流,使 Ink 的 `useInput`/焦点管理永不触发、不碰键盘。我们自己的输入子系统接管 `process.stdin`(自管 raw mode),解析后经 React Context 派发。Ink 仍正常渲染到 stdout,resize 走 stdout 不受影响。

```
真实 process.stdin (raw mode, 子系统管)
        │  .on('data') 独占
        ▼
  termio tokenizer (跨 chunk 缓冲)  ──►  tokens: text / sequence
        ▼
  parseKeypress (裁剪)             ──►  ParsedKey { name, ctrl, shift, …, isPasted }
        ▼
  InputProvider.dispatch
        ├─►  useInput(compat shim)  ──►  App / InputBox / ModelSelect / SelectList
        └─►  (isPasted 事件)         ──►  InputBox 粘贴折叠(第二期)

Ink  ◄── 哑 stdin(输入永不触发)、正常渲染 stdout
```

为什么用"哑 stdin 喂 Ink"而非加第二个 stdin 监听器:Ink 自身会为焦点管理/Ctrl+C 接管 stdin,再加一个监听器会双重处理转义序列。把哑流交给 Ink 后,Ink 彻底不碰真实 stdin,我们唯一持有,隔离最干净。代价是 **4 个 `useInput` 调用点必须同期迁移**(否则它们读哑流、永不触发);compat shim 让迁移近乎机械替换。

## 4. 模块布局

新增目录 `packages/tui/src/input/`:

| 文件 | 职责 | 来源 |
|---|---|---|
| `termio/ansi.ts` | C0 控制字符、`ESC_TYPE`、`isEscFinal`、`ESC`/`BEL`/`SEP` 常量 | 移植 cc-haha(原样,体量小) |
| `termio/csi.ts` | `isCSIParam/Intermediate/Final`、`csi()` 生成器、`PASTE_START`/`PASTE_END` 常量 | 移植,裁掉用不到的 CSI 名表 |
| `termio/tokenize.ts` | 跨 chunk 状态机,切 text/sequence,缓冲半截序列 | 移植,**去掉 `x10Mouse` 分支** |
| `parseKeypress.ts` | sequence → `ParsedKey`;CSI-u / modifyOtherKeys 解 Shift+Enter | 移植,**去掉鼠标、终端响应(DA1/DA2/OSC/kitty 回包)分支** |
| `protocol.ts` | 进出时开/关 bracketed paste(`?2004`)、推送/还原 Kitty keyboard + modifyOtherKeys | 新写 |
| `stdin.ts` | 接管 `process.stdin`、raw mode 生命周期、退出/信号清理、把 chunk 喂 tokenizer | 新写 |
| `InputProvider.tsx` | React Context:持有派发器,向订阅者广播 `ParsedInput` | 新写 |
| `useInput.ts` | 与 Ink `useInput((input,key)=>void,{isActive})` **同签名**的 shim;额外导出 `usePaste` 订阅粘贴事件 | 新写 |

`inputKeymap.ts` 的 `KeyState` 子集与 `keyToEvent` **保留不变**:由 `ParsedKey` 映射出 Ink 风格的 `key` 对象后照旧喂给它,既有单测继续有效。

## 5. 关键接口

### ParsedKey(parseKeypress 产物,内部)
```ts
interface ParsedKey {
  kind: 'key'
  name: string | undefined   // 'return' | 'enter' | 'backspace' | 'up' | … | 单字符
  ctrl: boolean
  meta: boolean              // Alt/Option
  shift: boolean
  sequence: string | undefined
  isPasted: boolean
}
// 粘贴内容由 tokenizer 在 PASTE_START..PASTE_END 间聚合,产出一个 isPasted=true、
// name='' 、sequence=完整粘贴文本 的 ParsedKey(空粘贴也产出,供将来图片侦测)。
```

### Ink 兼容的 key 形状(shim 暴露给调用点)
映射出 stock Ink 已被各调用点使用的字段,保证 4 处零行为改动:
`return, escape, tab, backspace, delete, leftArrow, rightArrow, upArrow, downArrow, ctrl, meta, shift`,外加 `input: string`。

### useInput shim
```ts
function useInput(
  handler: (input: string, key: InkKey) => void,
  opts?: { isActive?: boolean },
): void
// 行为对齐 Ink:isActive=false 时不收键;多个 useInput 并存时由各自 isActive 门控
// (与现状 SelectList/ModelSelect 的互斥逻辑一致)。
```

### usePaste(第二期 InputBox 使用)
```ts
function usePaste(handler: (text: string) => void, opts?: { isActive?: boolean }): void
// 当 ParsedKey.isPasted 且 text 非空时触发。空粘贴事件本期忽略(留给附件期)。
```

## 6. 数据流

### 普通按键
stdin chunk → `tokenize.feed()` → tokens → 每个 sequence/text 经 `parseKeypress` → `ParsedKey` → 映射成 InkKey → `InputProvider` 广播 → 各 `useInput` handler。

### Shift+Enter
进入时 `protocol.ts` 推送 Kitty keyboard(`CSI > 1 u`)+ modifyOtherKeys(`CSI > 4 ; 2 m`)。现代终端遂把 Shift+Enter 编为 `ESC[13;2u`(CSI-u),`parseKeypress` 解出 `{name:'return', shift:true}`。
- InputBox 映射:`return && shift` → 换行(`newline`);`return && !shift` → 提交。
- **兜底**:不支持上述协议的终端,旧路径仍在——裸 `\r`(无 return 标志)/ 裸 `\n` 仍判为换行(保留 `inputKeymap` 现有分支),`/terminal-setup` 配置继续可用。

### 粘贴(第二期)
tokenizer 在 `PASTE_START` 后进入粘贴态,聚合 `PASTE_END` 前的所有内容(跨 chunk 由 tokenizer 缓冲)为一个 `isPasted` 事件 → `usePaste` → InputBox 折叠逻辑(见 §7)。

## 7. 文本粘贴折叠(第二期细节)

### 触发
粘贴文本 **行数 ≥ 2(含 `\n`)即折叠**。单行粘贴照常按文本插入。

### 存储模型
`TextBuffer` 仍是扁平 `{ text, cursor }`,不改其纯函数体系。折叠后:
- 在光标处插入一个**占位符 token**,形如 `{id}`(用私有区哨兵字符包裹 id,避免与用户文本冲突);渲染时识别为标签。
- InputBox 维护一张 `pastes: Map<number, string>`(id → 全文)。id 自增。

> 备选(待实现时定):占位符用可见文本 `[#1 粘贴 23 行]` 直接内嵌。哨兵字符方案渲染/光标计算更干净,倾向哨兵方案;具体编码在实现计划里敲定。

### 原子编辑
占位符当**不可分割单元**:
- 左/右移:光标整体跨过占位符 token,不停在内部。
- 退格/删除:命中占位符边缘时一次删整块,并从 `pastes` Map 移除对应 id。
- 这要求在 `textBuffer.ts` 增加"占位符感知"的移动/删除变体,或在 reduce 层包一层占位符边界处理。纯函数、可单测。

### 渲染
`splitForRender` 识别占位符 token,渲染为深色块状标签,文案暂定:`[粘贴 23 行 · 1.2k 字符]`(行数取 `\n` 计数+1;字数取字符数,≥1000 显示 `x.xk`)。

### 提交与回显(向 cc 靠齐)
- **发给模型**:提交时把所有占位符替换回 `pastes` 里的全文 → 模型收到完整内容。
- **滚动区回显**:已发送的用户消息**仍显示折叠标签**,不铺全文。
- 这要求 message 模型同时携带「展示文本(含占位符/标签)」与「真实全文」两份。**此改造放在第二期**(第一期不碰 message 模型,缩小回归面)。
  - 落地方式(实现计划细化):用户消息结构新增可选 `attachments`/`pastes` 旁路字段,或携带 `displayText` + `text` 两字段;渲染层用 display,送 provider 用全文。

## 8. 分期与交付物

### 第一期 —— 输入层地基(可独立交付)
1. 移植裁剪 `termio/*` + `parseKeypress.ts`。
2. 新写 `protocol.ts` / `stdin.ts` / `InputProvider.tsx` / `useInput.ts`。
3. 入口 `index.tsx` 改为给 Ink 喂哑 stdin,在 `App` 外层包 `InputProvider`。
4. 迁移 4 个 `useInput` 调用点(`App.tsx`、`InputBox.tsx`、`ModelSelect.tsx`、`SelectList.tsx`):`from 'ink'` → `from '../input/useInput.js'`。
5. 根治 Shift+Enter(协议推送 + InputBox 映射 + 兜底)。
6. 粘贴此期仍按纯文本插入(检测来源换为可靠 `isPasted`,但不折叠)。

**验收**:Shift+Enter 在现代终端原生换行、旧终端兜底可用;4 个调用点行为不回归;粘贴边界稳定。退出/Ctrl+C 双击/Esc 中断/模型选择器/命令菜单全部照旧。

### 第二期 —— 文本粘贴折叠 UI
1. `usePaste` 订阅粘贴事件,≥2 行折叠。
2. 占位符 token + `pastes` Map + 原子编辑(textBuffer 扩展)+ 标签渲染。
3. message 模型携带双份文本;提交展开全文、回显折叠。

**验收**:多行粘贴显示为标签;光标整体跨过、退格整体删除;提交后模型收到全文、滚动区显示标签。

## 9. 错误处理与终端兼容

- **raw mode 生命周期**:`stdin.ts` 在挂载设 raw mode、推送协议;卸载/退出/`SIGINT`/异常时**务必**还原(关 bracketed paste、还原 Kitty/modifyOtherKeys、关 raw mode),否则用户终端会留在坏状态。复用现有退出路径,集中清理。
- **非 TTY / 不支持 raw mode**:`stdin.isTTY` 为假时降级——不推协议、不接管,给出与现状一致的处理(本就主要面向交互式 TTY)。
- **协议不被支持**:推送的 Kitty/modifyOtherKeys 在老终端被忽略即可,不报错;Shift+Enter 自动回落到裸 `\r`/`\n` 兜底。
- **半截序列**:tokenizer 的 `buffer()` 跨 chunk 保留未完成序列;进程退出前 `flush()` 一次,避免吞字符。
- **跨平台**:Windows(Windows Terminal/PowerShell/VSCode 集成终端)、macOS、Linux 均需覆盖;协议推送对不支持者无害,兜底保证基本可用。Windows 下注意 `process.stdin` 在 raw 模式的 `data` 编码(utf8)。

## 10. 测试策略

延续 zuse"纯模块单测 + 组件薄分发"的风格:
- `tokenize.test.ts`:文本/序列切分、跨 chunk 半截序列缓冲、bracketed paste 聚合(含粘贴内容里嵌 `\n`、粘贴被切成多块、空粘贴)。
- `parseKeypress.test.ts`:Enter/Shift+Enter(CSI-u `ESC[13;2u`)、方向键、退格、Ctrl 组合、裸 `\r`/`\n` 兜底。
- `useInput`/InputProvider:isActive 门控、多订阅者互斥(对齐现有 SelectList/ModelSelect 行为)。
- 第二期 `textBuffer`:占位符原子移动/删除、提交展开、行数/字数标签格式。
- 端到端冒烟(手动):真实终端里验 Shift+Enter、多行粘贴折叠、提交回显、退出后终端状态干净。

## 11. 已解决的开放项

- Shift+Enter 协议:**Kitty keyboard(`CSI > 1 u`)+ modifyOtherKeys(`CSI > 4 ; 2 m`)双保险**,保留裸 `\r`/`\n` 兜底。
- 折叠触发:**≥2 行**。
- 编辑语义:**整体原子**。
- 提交/回显:**模型收全文、滚动区显标签**,message 携双份文本,放第二期。
- message 双份文本改造:**第一期不做,留第二期**。

## 12. 实现计划中再敲定的细节(非阻塞)

- 占位符编码:用私有区(PUA)哨兵字符成对包裹 id(如 `U+E000 {id} U+E001`)vs 直接内嵌可见文本 `[#1 粘贴 23 行]`——倾向哨兵方案(渲染/光标计算更干净)。
- message 携带双份文本的具体字段命名与序列化(localStorage/会话存储里如何持久化展示态)。
- 折叠标签的精确文案与样式(颜色、是否带序号 `#1`)。
- 裁剪后 `parseKeypress` 保留哪些 nav-key 表项(按 zuse 实际用到的键裁)。
