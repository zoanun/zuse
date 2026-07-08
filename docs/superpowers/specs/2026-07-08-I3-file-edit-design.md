# I3 — 文件预览/编辑 设计

> **日期**: 2026-07-08
> **归属**: Web UI 程序（见 `2026-06-22-web-ui-roadmap.md` §4.4 交互增强 I3）
> **范围**: `packages/server`（FileService 写/删/原始字节 + HTTP 路由）、`packages/protocol`（类型）、`packages/web`（FilesPanel 编辑器 + 富预览）
> **依赖**: M7 文件树浏览器（已完成）

---

## 1. 背景与目标

M7 的文件面板（`packages/web/src/components/FilesPanel.tsx` + 后端 `packages/server/src/file/FileService.ts`）目前**只读、且只处理文本**：左侧懒加载树，点文件在下方看大小截断、去 ANSI 的只读文本预览；二进制（含图片/PDF/Office）一律 `binary:true` 不显示内容。

I3 把它升级成一个**能编辑文本、能预览常见文件**的面板：

1. **文本文件 → 可编辑**（CodeMirror，多语言高亮），显式保存（按钮 + Ctrl/Cmd+S）落盘。
2. **新建**文本文件、**删除**文件。
3. **图片 / PDF → 富预览**（只读）：图片 `<img>`、PDF 浏览器内置查看器 `<iframe>`。
4. **其它/不支持的类型 → "无法展示" + 下载按钮**。
5. **轻量并发保护**：加载后文件被别的进程改动，保存时提醒并可强制覆盖。

**非目标**
- 不做 Office（Excel/Word/PPT）**内容渲染**——评估后代价高、保真差（客户端重库 + 老格式差 + 本地文件无法用外部查看器）；Office 走"无法展示 + 下载"。**用户已确认此档**。想要 Office 预览另开 spec。
- 不做重命名/移动、不做目录的创建/删除（只操作文件）。
- 不做多用户隔离/沙箱（沿用 roadmap 非目标：单用户、信任本机、写操作仅限项目 cwd 内）。
- 不编辑二进制或超大（>256KiB 截断）文本文件——只读或"无法展示"。

---

## 2. 架构与数据流

沿用 M7 的**注入**模式：`FilesPanel` 通过注入的异步函数与后端通信；后端在 root 锁定 cwd 的 `FileService` 上加写/删方法 + 一个"原始字节"HTTP 端点，全部复用现有路径穿越防护（`resolveInRoot`）与 `?cwd=` 覆盖逻辑。

```
FilesPanel ──inject──> loadDir / loadFile / writeFile / deleteFile   (+ rawUrl(path) 拼 URL)
     │                          │ (manageApi.ts REST 客户端)
     │        GET  /api/files             树(懒加载一层)
     │        GET  /api/files/content     文本预览(含 mtimeMs)
     │        PUT  /api/files/content      写(编辑/新建)
     │        DELETE /api/files/content    删
     │        GET  /api/files/raw?path=    原始字节(正确 Content-Type，供 <img>/<iframe>/下载)
     │                          │
     └──────> FileService.list / read / write / remove / statFile   (root-locked cwd, 路径守卫)
```

**视图模式在前端按扩展名分流**（避免给图片/PDF 白拉一遍文本内容）：
- 文本类扩展（或 content 探测非二进制）→ **CodeMirror 编辑器**（拉 `/content`）。
- 图片扩展（png/jpg/jpeg/gif/webp/bmp/svg/ico/avif）→ **`<img src=raw>`**（不拉 content）。
- `.pdf` → **`<iframe src=raw>`**（不拉 content）。
- 其它 → **"无法展示" + 下载**（`<a href=raw download>`）。

`/api/files/raw` 同源、浏览器自动带鉴权 cookie，故 `<img>/<iframe>/<a>` 可直接加载。

---

## 3. 后端

### 3.1 protocol（`packages/protocol/src`）
- `FilePreview` 增字段 `mtimeMs: number`（`stat().mtimeMs`，冲突比对用）。
- 新增：
  ```ts
  export interface WriteFileResult { path: string; size: number; mtimeMs: number }
  export interface WriteFileBody { path: string; content: string; expectMtimeMs?: number; force?: boolean }
  ```
  （`expectMtimeMs` 缺省=新建/不校验；`force` 跳过冲突检查。）
- 原始字节端点走裸 HTTP 流、不经 JSON DTO，无需新协议类型。

### 3.2 `FileService`（`packages/server/src/file/FileService.ts`）
- 新增 `FileChangedError`（HTTP→409）。
- `read()` 追加返回 `mtimeMs: st.mtimeMs`。
- `async write(rel, content, opts?: { expectMtimeMs?: number; force?: boolean }): Promise<WriteFileResult>`：
  1. `abs = resolveInRoot(rel)`（越界抛 `PathOutsideRootError`）。
  2. 目标已存在且是目录 → 抛 `Error('path is a directory')`。
  3. 冲突检查：`opts.expectMtimeMs != null && !opts.force` 且目标存在，当前 `mtimeMs` ≠ `expectMtimeMs` → 抛 `FileChangedError`。
  4. `writeFile(abs, content, 'utf8')`（父目录不存在则 ENOENT 上抛，不自动 mkdir）。
  5. 返回 `{ path: toRel(abs), size, mtimeMs }`（写后 stat）。
- `async remove(rel): Promise<void>`：守卫；`stat` 是目录则抛错（只删文件）；`unlink`。
- `async statFile(rel): Promise<{ abs: string; size: number; mime: string }>`：守卫；拒目录；按扩展名推断 `mime`（见 3.4）；供 raw 端点用（也做大小上限判断）。

### 3.3 HTTP（`packages/server/src/http/server.ts`）
现有 `/api/files` / `/api/files/content` GET 旁边加：
- `PUT /api/files/content`：JSON body `WriteFileBody` → `fileSvc.write(...)` → 200 `WriteFileResult`。
- `DELETE /api/files/content?path=<rel>` → `fileSvc.remove(path)` → 200 `{ ok: true }`。
- `GET /api/files/raw?path=<rel>`：`statFile`；若 `size > RAW_CAP`(如 50 MiB) → 413；否则 `Content-Type: mime` + `Content-Length: size` + `createReadStream(abs).pipe(res)`（流式、不全量入内存）。默认 **inline**（供 img/iframe 内联）；下载由前端 `<a download>` 触发，无需 attachment 头。
- 错误映射沿用现风格：`PathOutsideRootError→400`、`FileChangedError→409`、其它→500；均 auth-gated、复用 `?cwd=` → `new FileService(cwd)`。

### 3.4 MIME 映射
后端一张扩展名→MIME 小表（`image/png|jpeg|gif|webp|bmp|avif|x-icon`、`image/svg+xml`、`application/pdf`），命中给对应类型，未命中 `application/octet-stream`。仅 raw 端点用。

---

## 4. 前端（`packages/web`）

### 4.1 依赖（CodeMirror + 多语言）
新增 `@uiw/react-codemirror`（受控 value+onChange）。语言分两来源，按扩展名挑，命中高亮、未命中回退纯文本：
- **专用 lang 包**（主流语言）：`@codemirror/lang-javascript`(js/jsx/ts/tsx)、`-json`、`-css`、`-html`、`-markdown`、`-python`、`-java`、`-cpp`(c/h/cc/cpp/hpp)、`-rust`、`-go`、`-php`、`-sql`、`-xml`、`-yaml`。
- **`@codemirror/legacy-modes`**（StreamLanguage 覆盖长尾）：`shell`(sh/bash/zsh/**cmd/bat** 归此)、`properties`(properties/ini/env/conf)、`toml`、`dockerfile`、`ruby`、`lua`、`powershell`。
- **txt/.log/未知** → 无 language，纯文本编辑（仍可编辑保存）。
> 扩展名→语言映射集中在 `fileLang.ts`（纯函数、可单测），编辑器只调它拿扩展。**代价**：CodeMirror + 这些语言包给 bundle 加约 300–500KB（当前 ~596KB）；编辑器是唯一可替换件，接口不变，日后可换回 textarea。

### 4.2 `manageApi.ts`
新增（复用现有 `request()`）：
- `writeFile(path, content, cwd?, opts?: { expectMtimeMs?; force? }): Promise<WriteFileResult>` → `PUT /api/files/content`。
- `deleteFile(path, cwd?): Promise<void>` → `DELETE /api/files/content`。
- `rawFileUrl(path, cwd?): string` → 拼 `/api/files/raw?path=…&cwd=…`（供 `<img>/<iframe>/<a>`；同源带 cookie）。

### 4.3 视图分流（`fileView.ts` 纯函数）
`classify(path): 'text' | 'image' | 'pdf' | 'other'`（按扩展名；图片/pdf 集合见 §2）。`FilesPanel` 点文件时：
- `image` → 渲染 `<img src={rawUrl(path)}>`（含 onError 兜底 → "无法展示 + 下载"）。
- `pdf` → 渲染 `<iframe src={rawUrl(path)} title=…>`。
- `other` → "无法展示（不支持预览此类型）" + `<a href={rawUrl(path)} download>下载</a>`。
- `text` → 拉 `loadFile(path)`：若 `binary`（扩展名没归类但内容是二进制）或 `truncated` → "无法展示 + 下载"（截断文本禁编辑，防存回截断）；否则进 CodeMirror 编辑器。

### 4.4 文本编辑器（CodeMirror）
- 受控 `value`（编辑缓冲），初值 = `preview.content`；`baseMtimeMs`、`saving`、`saveError` 状态；脏 = `buffer !== preview.content`。
- **保存**：脏时"保存"按钮高亮；点按钮或编辑器 keymap 绑 `Mod-s`(Ctrl/Cmd+S，`preventDefault`) → `save()`：`writeFile(path, buffer, { expectMtimeMs: baseMtimeMs })`。
  - 成功 → 更新 `baseMtimeMs`、同步 `preview.content=buffer`（清脏）。
  - 409 → "文件已变更，确认覆盖？"确认条 → `writeFile(..., { force: true })` 重存。
  - 其它错误 → 显 `saveError`。
- 主题跟随 app `data-theme`（明/暗）。语言由 `fileLang(path)` 挂上。

### 4.5 新建 / 删除
- **新建**：树区顶部"＋ 新建文件"→ 输入相对 root 路径 → `writeFile(path, '')` → 刷新所在目录、选中进编辑器；父目录不存在/路径非法 → 显错。
- **删除**：文件行（或预览区头部）删除入口 → 内联 ✓/✕ 确认（复用 Memory/Personas 面板风格）→ `deleteFile(path)` → 从树移除、清空预览。

### 4.6 未保存守卫
切换到别的文件 / 折叠导致离开当前编辑时，若脏，弹一次"有未保存修改，放弃？"，确认才切换。

### 4.7 接线
新增注入 props：`writeFile`、`deleteFile`、`rawUrl`（=`rawFileUrl`）。`ManageDrawer` 用 `manageApi` 接线（带当前 cwd）。保持面板可脱网单测（rawUrl 传桩函数）。

---

## 5. 边界与错误处理
- **越界路径**：后端 `resolveInRoot` 拒绝 → 400。
- **目录**：write/remove/raw 遇目录报错（不写/删/流目录）。
- **截断文本 / 内容型二进制**：前端不进编辑器 → "无法展示 + 下载"，杜绝存回截断。
- **raw 过大**：> RAW_CAP(50 MiB) → 413，前端 "无法展示 + 下载"（浏览器直接拉流下载仍可）。
- **冲突**：`expectMtimeMs` 不符 → 409 → 确认覆盖(force)；新建不带 `expectMtimeMs`，不误报。
- **父目录缺失（新建）**：ENOENT 上抛 → 前端显错（不自动建目录）。
- **图片/PDF 加载失败**（损坏/超限）：`<img>/<iframe>` onError/兜底显示 "无法展示 + 下载"。

---

## 6. 测试
- **后端** `FileService.test.ts`：write 正常/拒目录/路径穿越拒绝/冲突(FileChangedError)/force 覆盖/新建；remove 删文件/拒目录/路径穿越拒绝；statFile mime 推断/拒目录/越界。
- **后端** HTTP：`PUT`(200/400/409)、`DELETE`(200/400)、`GET /raw`(200 + Content-Type、413 超限、400 越界)。
- **前端** `fileView.test.ts`（classify 按扩展名）+ `fileLang.test.ts`（扩展名→语言，含 shell/cmd/properties/txt 回退）。
- **前端** `FilesPanel.test.tsx`：文本进编辑器、脏标记、保存调用注入 writeFile、Mod-s 保存、409→确认覆盖、图片渲染 `<img>` 用注入 rawUrl、pdf 渲染 `<iframe>`、other→"无法展示"+下载链接、截断/二进制→"无法展示"、新建流程、删除内联确认、切文件未保存确认。

---

## 7. 涉及文件
- `packages/protocol/src/*.ts` — `FilePreview.mtimeMs`、`WriteFileResult`、`WriteFileBody`。
- `packages/server/src/file/FileService.ts` — `write`/`remove`/`statFile`、`FileChangedError`、`read` 加 mtimeMs、MIME 表。
- `packages/server/src/http/server.ts` — PUT/DELETE/GET(raw) `/api/files/*` 路由 + 错误映射。
- `packages/web/src/state/manageApi.ts` — `writeFile`/`deleteFile`/`rawFileUrl`。
- `packages/web/src/components/fileLang.ts` + `fileView.ts` — 扩展名→语言 / →视图模式（纯函数）。
- `packages/web/src/components/FilesPanel.tsx` — 视图分流、编辑器、保存、新建、删除、冲突、未保存守卫、图片/PDF/无法展示。
- `packages/web/src/components/ManageDrawer.tsx` — 接线新注入函数。
- `packages/web/package.json` — CodeMirror + 语言包依赖。
- 测试：`FileService.test.ts`、server http 测试、`fileLang.test.ts`、`fileView.test.ts`、`FilesPanel.test.tsx`。
