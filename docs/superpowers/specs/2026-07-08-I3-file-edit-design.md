# I3 — 文件预览/编辑 设计

> **日期**: 2026-07-08
> **归属**: Web UI 程序（见 `2026-06-22-web-ui-roadmap.md` §4.4 交互增强 I3）
> **范围**: `packages/server`（FileService 写/删 + HTTP 路由）、`packages/protocol`（类型）、`packages/web`（FilesPanel 编辑器）
> **依赖**: M7 文件树浏览器（已完成）

---

## 1. 背景与目标

M7 的文件面板（`packages/web/src/components/FilesPanel.tsx` + 后端 `packages/server/src/file/FileService.ts`）目前**只读**：左侧懒加载文件树，点文件在下方看大小截断、去 ANSI 的只读预览。

I3 把只读预览升级成"能改能存"，并补上新建/删除：在浏览器（尤其手机/平板远程连入时）直接编辑项目里的文本文件、保存落盘，无需切回终端或本地编辑器。

**目标**
1. 预览区变可编辑（CodeMirror），显式保存（按钮 + Ctrl/Cmd+S）落盘。
2. 新建文本文件、删除文件。
3. 轻量并发保护：加载后文件在磁盘被别的进程改动，保存时提醒并可强制覆盖。

**非目标**
- 不做重命名/移动（YAGNI；如需另开）。
- 不做目录的创建/删除（只操作文件）。
- 不做多用户隔离/沙箱（沿用 roadmap 非目标：单用户、信任本机、写操作仅限项目 cwd 内）。
- 不编辑二进制或超大（>256KiB 截断）文件——只读展示。

---

## 2. 架构与数据流

沿用 M7 已确立的**注入**模式：`FilesPanel` 通过注入的异步函数与后端通信，从只读的 `loadDir/loadFile` 扩展到读写。后端在 root 锁定 cwd 的 `FileService` 上加写/删方法，HTTP 加对应路由，全部复用现有路径穿越防护（`resolveInRoot`）与 `?cwd=` 覆盖逻辑。

```
FilesPanel ──inject──> loadDir / loadFile / writeFile / deleteFile
     │                          │ (manageApi.ts REST 客户端)
     │                 GET  /api/files            树(懒加载一层)
     │                 GET  /api/files/content    预览(含 mtimeMs)
     │                 PUT  /api/files/content     写(编辑/新建)
     │                 DELETE /api/files/content   删
     │                          │
     └────────────────> FileService.list/read/write/remove  (root-locked cwd, 路径守卫)
```

创建 = 对一个不存在的路径 `write`（父目录须已存在）。所有写/删操作与读一样，先过 `resolveInRoot` 守卫，越出 cwd 一律 400。

---

## 3. 后端

### 3.1 protocol（`packages/protocol/src`）
- `FilePreview` 增字段 `mtimeMs: number`（`stat().mtimeMs`，冲突比对用）。
- 新增：
  ```ts
  export interface WriteFileResult { path: string; size: number; mtimeMs: number }
  export interface WriteFileBody { path: string; content: string; expectMtimeMs?: number; force?: boolean }
  ```
  （REST body DTO；`expectMtimeMs` 缺省表示新建/不校验，`force` 跳过冲突检查。）

### 3.2 `FileService`（`packages/server/src/file/FileService.ts`）
- 新增错误类型 `FileChangedError`（供 HTTP 映射到 409）。
- `async write(rel: string, content: string, opts?: { expectMtimeMs?: number; force?: boolean }): Promise<WriteFileResult>`：
  1. `abs = resolveInRoot(rel)`（越界抛 `PathOutsideRootError`）。
  2. 若目标已存在且是目录 → 抛 `Error('path is a directory')`。
  3. 冲突检查：若 `opts.expectMtimeMs != null && !opts.force` 且目标存在，`stat` 当前 `mtimeMs`，与 `expectMtimeMs` 不等 → 抛 `FileChangedError`。
  4. `writeFile(abs, content, 'utf8')`。
  5. `st = await stat(abs)`；返回 `{ path: toRel(abs), size: st.size, mtimeMs: st.mtimeMs }`。
  - **新建**：目标不存在时 `expectMtimeMs` 应为空，直接写；父目录不存在则 `writeFile` 自然抛 ENOENT（不自动 mkdir，交由错误上抛 → 400/500）。
- `async remove(rel: string): Promise<void>`：
  1. `abs = resolveInRoot(rel)`。
  2. `st = await stat(abs)`；若是目录 → 抛 `Error('path is a directory')`（只删文件）。
  3. `unlink(abs)`。
- `read()` 追加返回 `mtimeMs: st.mtimeMs`。

### 3.3 HTTP（`packages/server/src/http/server.ts`）
在现有 `/api/files` / `/api/files/content` GET 块旁边加：
- `PUT /api/files/content`：读 JSON body（`WriteFileBody`），`fileSvc.write(body.path, body.content, { expectMtimeMs, force })`，200 回 `WriteFileResult`。
- `DELETE /api/files/content?path=<rel>`：`fileSvc.remove(path)`，200 回 `{ ok: true }`。
- 错误映射（与现有风格一致）：`PathOutsideRootError → 400`、`FileChangedError → 409`、其它 → 500（沿用现有 try/catch→sendJson 错误处理）。
- 均 auth-gated，复用现有 `?cwd=` → `new FileService(cwd)` 分支。

---

## 4. 前端（`packages/web`）

### 4.1 依赖
新增 `@uiw/react-codemirror` + 语言扩展包（`@codemirror/lang-javascript`、`-json`、`-css`、`-html`、`-markdown`、`-python`）。按文件扩展名挑语言，命中则语法高亮，未命中回退纯文本。**代价**：约 200–400KB bundle 增量（当前 ~596KB）。编辑器是唯一可替换件，接口（受控 value+onChange）不变，日后可换回 textarea。

### 4.2 `manageApi.ts`
新增（复用现有 `request()`）：
- `writeFile(path, content, cwd?, opts?: { expectMtimeMs?; force? }): Promise<WriteFileResult>` → `PUT /api/files/content`。
- `deleteFile(path, cwd?): Promise<void>` → `DELETE /api/files/content`。

### 4.3 `FilesPanel`
新增注入 props：`writeFile(path, content, opts) => Promise<WriteFileResult>`、`deleteFile(path) => Promise<void>`。`ManageDrawer` 用 `manageApi` 的新函数接线（带当前 cwd）。

预览/编辑区分流：
- `preview.binary` 或 `preview.truncated` → **只读**：显示现有只读预览 + 一行提示（"二进制文件，不可编辑" / "文件过大（>256KiB），仅显示前部，不可编辑"）。
- 否则 → **CodeMirror 编辑器**：受控 `value`（编辑缓冲），初值 = `preview.content`。
  - 状态：`buffer`（编辑内容）、`baseMtimeMs`（已加载版本的 mtime）、`saving`、`saveError`。脏 = `buffer !== preview.content`。
  - **保存**：脏时"保存"按钮高亮；点按钮或 CodeMirror keymap 里绑 `Mod-s`（Ctrl/Cmd+S，`preventDefault`）触发 `save()`。`save()` 调 `writeFile(path, buffer, { expectMtimeMs: baseMtimeMs })`：
    - 成功 → 用返回的 `{ mtimeMs }` 更新 `baseMtimeMs`、把 `preview.content` 同步为 `buffer`（清脏）。
    - 409（`FileChangedError`）→ 置"文件已变更，确认覆盖？"确认条；点确认 → `writeFile(..., { force: true })` 重存。
    - 其它错误 → 显示 `saveError`。
  - 主题：CodeMirror 主题跟随 app 的 `data-theme`（明/暗各一套或用可切换主题）。
- **新建**：文件树区顶部"＋ 新建文件"按钮 → 输入相对路径（相对 root）→ `writeFile(path, '')` → 成功后刷新所在目录、选中并进入编辑器。父目录不存在或路径非法 → 显错。
- **删除**：文件行（或编辑区头部）一个删除入口，内联确认（复用现有 Memory/Personas 面板的 ✓/✕ 图标确认风格）→ `deleteFile(path)` → 从 `children` 移除该项、若正在预览则清空预览。

### 4.4 切换文件时的未保存保护
选中另一文件 / 折叠目录导致离开当前编辑时，若有未保存脏改动，弹一次确认（"有未保存修改，放弃？"）；确认才切换，否则留在当前文件。（简单守卫，避免静默丢改动。）

---

## 5. 边界与错误处理
- **越界路径**：后端 `resolveInRoot` 拒绝，HTTP 400。
- **目录**：write/remove 遇目录报错（不写、不删目录）。
- **截断/二进制**：前端不进入编辑器（只读），根上杜绝"存回截断内容截断文件"。
- **冲突**：`expectMtimeMs` 不符 → 409 → 前端确认覆盖（force）。新建（目标不存在）不带 `expectMtimeMs`，不误报冲突。
- **父目录缺失（新建）**：`writeFile` ENOENT 上抛 → 500/400，前端显错（不自动建目录）。
- **保存中**：按钮禁用，防重复提交。

---

## 6. 测试
- **后端** `FileService.test.ts`：write 正常（返回 size/mtimeMs）、write 拒目录、write 路径穿越拒绝、write 冲突（expectMtimeMs 不符→FileChangedError）、write force 覆盖、新建（不存在路径）、remove 删文件、remove 拒目录、remove 路径穿越拒绝。
- **后端** HTTP：`PUT /api/files/content` 200/400（越界）/409（冲突）；`DELETE` 200/400。
- **前端** `FilesPanel.test.tsx`：文本文件进入编辑器、脏标记随输入变化、点保存调用注入 `writeFile` 并清脏、Mod-s 触发保存、二进制/截断只读（无编辑器）、保存 409 → 确认覆盖走 force、新建文件流程、删除内联确认调用 `deleteFile`、切文件未保存确认。

---

## 7. 涉及文件
- `packages/protocol/src/*.ts` — `FilePreview.mtimeMs`、`WriteFileResult`、`WriteFileBody`。
- `packages/server/src/file/FileService.ts` — `write`/`remove`、`FileChangedError`、`read` 加 mtimeMs。
- `packages/server/src/http/server.ts` — PUT/DELETE `/api/files/content` 路由 + 错误映射。
- `packages/web/src/state/manageApi.ts` — `writeFile`/`deleteFile`。
- `packages/web/src/components/FilesPanel.tsx` — 编辑器、保存、新建、删除、冲突、未保存守卫。
- `packages/web/src/components/ManageDrawer.tsx` — 接线新注入函数。
- `packages/web/package.json` — CodeMirror 依赖。
- 测试：`FileService.test.ts`、server http 测试、`FilesPanel.test.tsx`。
