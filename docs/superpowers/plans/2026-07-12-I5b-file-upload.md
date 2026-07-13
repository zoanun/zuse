# I5b 任意文件上传 + agent/skill 解析 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户上传任意文件（图片/粘贴文本之外的一切）；服务端只存储，发送时给模型一条英文说明 + 文件绝对路径，让模型用 Read/Bash 或 skill/agent 自行处理；顺带按 CC 方式截断过大的粘贴文本。

**Architecture:** 新增 `route:'file'` 的 `MessageAttachment`（只带 name，路径发送时由服务端 `UploadService.filePath` 现算）。文件字节经 base64-in-JSON 传到新端点 `POST /api/uploads/file`，存到 `~/.zuse/uploads/<uuid>/<原名>`。`expandAttachments` 为 `route:'file'` 产出一条英文文本说明块（不进原生块）。前端把非图片文件走独立"文件管道"（上传→卡片→发送），与图片、粘贴文本并列；`files` 数组沿着 I5a 的 `pastedTexts` 完全相同的路径贯穿 protocol/submit/steer/retry/echo。

**Tech Stack:** TypeScript monorepo（pnpm）；packages protocol/core/server/web；测试 core/server 用 `pnpm exec vitest run packages/<pkg>`，web 用 `pnpm --filter @zuse/web test`；Windows + PowerShell（`;` 串接）。

**Spec:** `docs/superpowers/specs/2026-07-12-I5b-file-upload-agentic-parse-design.md`
**Branch:** `i5b-file-upload`（spec 已在此分支）。

**关键复用提示：** 服务端 `files` 的贯穿方式**与已上线的 `pastedTexts` 完全同构**——凡 `pastedTexts` 出现处，`files` 并列加一份。实现时以现有 `pastedTexts` 代码为镜像。

---

## File Structure

| 文件 | 改动 |
|---|---|
| `packages/protocol/src/index.ts` | `UploadedFileRef`；`MessageAttachment.route` 加 `'file'`；`send`/`steer` 帧加 `files?` |
| `packages/core/src/types.ts` | `MessageAttachment.route` 加 `'file'` |
| `packages/server/src/upload/UploadService.ts` | `saveFile`/`filePath`/`FILE_MAX_BYTES`/`FileTooLargeError`/`safeFilename` |
| `packages/server/src/http/server.ts` | `POST /api/uploads/file` + `FILE_BODY_CAP` |
| `packages/server/src/upload/imageExpand.ts` | `route:'file'` 分支 + 粘贴文本 CC 式截断 |
| `packages/server/src/ws/clientMessage.ts` | send/steer 透传 `msg.files` |
| `packages/server/src/session/SessionManager.ts` | `submit`/`steer`/`steerQueue`/`consumeSteer`/`drainSteerAsFollowUp`/`retry`/`echoAttachments` 并列 `files` |
| `packages/web/src/state/manageApi.ts` | `uploadFile` |
| `packages/web/src/components/Composer.tsx` | `otherFilesFrom`、`PendingFile`、文件管道、`accept="*"`、文件卡片、onSend 带 files |
| `packages/web/src/components/Shell.tsx` | `onSend` 加 files（帧 + 乐观 + steer） |
| `packages/web/src/components/Message.tsx` | `route:'file'` 渲染 `📎 <name>` 卡片 |

依赖序 protocol → core → server → web，逐 task 提交，每 task 结束可编译。

---

### Task 1: protocol —— UploadedFileRef + route 'file' + 帧 files

**Files:** Modify `packages/protocol/src/index.ts`

- [ ] **Step 1: 加 `UploadedFileRef`（放在 `PastedTextInput` 定义之后）**

```ts
/** 一次上传后的任意文件引用（客户端持有、随 send 上行）。 */
export interface UploadedFileRef {
  id: string
  name: string
  mediaType: string
}
```

- [ ] **Step 2: `MessageAttachment.route` 加 `'file'`**

把 `route?: 'direct' | 'parsed' | 'pasted'` 改为：
```ts
  /** direct=图直传 / parsed=图解析转述 / pasted=粘贴长文本 / file=上传的任意文件（只带 name，路径发送时服务端现算）。 */
  route?: 'direct' | 'parsed' | 'pasted' | 'file'
```

- [ ] **Step 3: `ClientMessage` 的 send + steer 帧并列加 `files?`**

```ts
  | { type: 'send'; text: string; images?: UploadedImageRef[]; pastedTexts?: PastedTextInput[]; files?: UploadedFileRef[] }
```
```ts
  | { type: 'steer'; text: string; images?: UploadedImageRef[]; pastedTexts?: PastedTextInput[]; files?: UploadedFileRef[] }
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @zuse/protocol exec tsc --noEmit`
Expected: 无输出（exit 0）。protocol 无单测。

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/index.ts
git commit -m "feat(protocol): UploadedFileRef + MessageAttachment route 'file' + send/steer.files (I5b)"
```

---

### Task 2: core —— MessageAttachment route 'file'

**Files:** Modify `packages/core/src/types.ts`

- [ ] **Step 1: 同步 `MessageAttachment.route`**

把 core 里 `MessageAttachment` 的 `route?: 'direct' | 'parsed' | 'pasted'` 改为：
```ts
  route?: 'direct' | 'parsed' | 'pasted' | 'file'
```
（`text?`/`description?` 不变。）

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @zuse/core exec tsc --noEmit`
Expected: 无输出。

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat(core): MessageAttachment route 'file' (I5b)"
```

---

### Task 3: server —— UploadService.saveFile / filePath

**Files:** Modify `packages/server/src/upload/UploadService.ts`; Test `packages/server/src/upload/UploadService.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/server/src/upload/UploadService.test.ts`（若不存在则新建，import 见下）追加：

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UploadService, FileTooLargeError, FILE_MAX_BYTES } from './UploadService.js'

function svc() { return new UploadService(mkdtempSync(join(tmpdir(), 'zuse-up-'))) }

describe('UploadService.saveFile (I5b)', () => {
  it('stores arbitrary bytes under <uuid>/<name> and filePath resolves to it', async () => {
    const s = svc()
    const { id, name } = await s.saveFile(Buffer.from('hello'), 'report.pdf')
    expect(name).toBe('report.pdf')
    const p = s.filePath(id, name)
    expect(existsSync(p)).toBe(true)
    expect(readFileSync(p).toString()).toBe('hello')
    expect(p.replace(/\\/g, '/')).toContain(`/${id}/report.pdf`)
  })

  it('accepts any media type (no image whitelist)', async () => {
    const s = svc()
    const { name } = await s.saveFile(Buffer.from('a,b\n1,2'), 'data.csv')
    expect(name).toBe('data.csv')
  })

  it('sanitizes path-traversal names to a safe basename', async () => {
    const s = svc()
    const { id, name } = await s.saveFile(Buffer.from('x'), '../../etc/passwd')
    expect(name).toBe('passwd')                 // directory parts stripped
    expect(s.filePath(id, name)).toContain('passwd')
    const bad = await s.saveFile(Buffer.from('x'), '..')
    expect(bad.name).toBe('file')               // pure traversal → fallback
  })

  it('rejects oversize files with FileTooLargeError', async () => {
    const s = svc()
    await expect(s.saveFile(Buffer.alloc(FILE_MAX_BYTES + 1), 'big.bin')).rejects.toBeInstanceOf(FileTooLargeError)
  })

  it('filePath is idempotent w.r.t. the stored (already-safe) name', async () => {
    const s = svc()
    const { id, name } = await s.saveFile(Buffer.from('x'), 'a.txt')
    expect(s.filePath(id, name)).toBe(s.filePath(id, name))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/server/src/upload/UploadService.test.ts`
Expected: FAIL —— `saveFile`/`filePath`/`FileTooLargeError`/`FILE_MAX_BYTES` 未导出。

- [ ] **Step 3: 实现**

在 `UploadService.ts`：

3a. import 加 `basename`：把 `import { join } from 'node:path'` 改为 `import { join, basename } from 'node:path'`。

3b. 常量 + 错误类（放在 `MAX_UPLOAD_BYTES` 附近）：
```ts
/** Hard ceiling on a single arbitrary-file upload: 50 MiB (wider than images — docs/archives). */
export const FILE_MAX_BYTES = 50 * 1024 * 1024
```
在 `TooLargeError` 之后：
```ts
/** Thrown when an arbitrary-file upload exceeds FILE_MAX_BYTES. → 413. */
export class FileTooLargeError extends Error {
  constructor() {
    super(`file upload exceeds ${FILE_MAX_BYTES} bytes`)
    this.name = 'FileTooLargeError'
  }
}
```

3c. 模块内 helper（放在 `UUID_RE` 附近，class 外）：
```ts
/** Reduce an arbitrary client filename to a safe basename (no directory parts, no traversal). Runs on
 *  both save and filePath so the two agree. Backslashes are normalized to '/' first so a Windows path
 *  is stripped by posix basename regardless of host. Empty / '.' / '..' fall back to 'file'. */
function safeFilename(name: string): string {
  const b = basename((name ?? '').replace(/[\\/]+/g, '/')).trim()
  return b === '' || b === '.' || b === '..' ? 'file' : b
}
```

3d. class 内新增两个方法（放在 `readBase64` 之后）：
```ts
  /**
   * Persist an arbitrary uploaded file under `<uploadsDir>/<uuid>/<safeName>` — a per-upload uuid dir
   * isolates it (no name collisions, no traversal out of the dir), while the original (sanitized)
   * filename is preserved so its extension survives for the agent/skill that reads it. No MIME check.
   * Written to a `.tmp` sibling then renamed. Returns the id + the actually-stored (safe) name.
   */
  async saveFile(bytes: Buffer, name: string): Promise<{ id: string; name: string }> {
    if (bytes.length > FILE_MAX_BYTES) throw new FileTooLargeError()
    const id = randomUUID()
    const safe = safeFilename(name)
    const dir = join(this.uploadsDir, id)
    await mkdir(dir, { recursive: true })
    const finalPath = join(dir, safe)
    const tmpPath = `${finalPath}.tmp`
    await writeFile(tmpPath, bytes)
    await rename(tmpPath, finalPath)
    return { id, name: safe }
  }

  /** Absolute path of a stored arbitrary file. Validates the id shape (no disk access, no traversal),
   *  re-applies safeFilename so a caller-passed name can't smuggle a separator. Used by
   *  expandAttachments to put the path in the model-facing note. */
  filePath(id: string, name: string): string {
    if (!UUID_RE.test(id)) throw new InvalidUploadIdError(id)
    return join(this.uploadsDir, id, safeFilename(name))
  }
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `pnpm exec vitest run packages/server/src/upload/UploadService.test.ts ; pnpm --filter @zouyj/zuse-server exec tsc --noEmit`
Expected: 全绿；typecheck 无输出。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/upload/UploadService.ts packages/server/src/upload/UploadService.test.ts
git commit -m "feat(server): UploadService.saveFile/filePath for arbitrary files (I5b)"
```

---

### Task 4: server —— POST /api/uploads/file

**Files:** Modify `packages/server/src/http/server.ts`; Test `packages/server/src/http/server.test.ts`（若有；否则在现有 http 测试文件里加）

- [ ] **Step 1: 写失败测试**

在 http server 测试文件里，仿照现有 `POST /api/uploads` 图片上传测试（grep `"/api/uploads"` 找到它，复制其鉴权/请求构造），加一条 `POST /api/uploads/file` 用例：上传任意 base64 → 200 `{id, name, mediaType}`；文件确实落盘（可用注入的 fake/真 UploadService 断言）；缺 `name`/`dataBase64` → 400；超 `FILE_BODY_CAP` → 413。以现有图片上传测试的断言风格为准（用同一个 test harness / request helper），不要新造 harness。

> 若该测试文件用真实 `UploadService`（临时目录），断言 `deps.upload.filePath(id, name)` 存在即可。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/server/src/http/server.test.ts`
Expected: FAIL —— 端点未实现（404 或断言不符）。

- [ ] **Step 3: 实现端点**

3a. 顶部 import 补 `FileTooLargeError`、`FILE_MAX_BYTES`（从 `../upload/UploadService.js`，与现有 `TooLargeError` 等同处导入）。

3b. `FILE_BODY_CAP` 常量（放在现有 `UPLOAD_BODY_CAP` 之后，第 134 行附近）：
```ts
/** Body cap for POST /api/uploads/file: base64 inflates ~4/3 over the raw file, + 1 MiB slack. */
const FILE_BODY_CAP = Math.ceil(FILE_MAX_BYTES * 4 / 3) + 1024 * 1024
```

3c. 在现有 `POST /api/uploads`（第 611-633 行）分支**之后**加新分支：
```ts
    // POST /api/uploads/file — arbitrary (non-image) files. body {name, mediaType?, dataBase64}
    // → 200 {id, name, mediaType}. Server only stores; no MIME whitelist. Same base64-in-JSON
    // transport as /api/uploads.
    if (method === 'POST' && path === '/api/uploads/file') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Not authenticated' } })
      let body: { name?: unknown; mediaType?: unknown; dataBase64?: unknown } | undefined
      try { body = (await readJsonBody(req, FILE_BODY_CAP)) as typeof body } catch (e) {
        if (e instanceof PayloadTooLargeError) return sendJson(res, 413, { error: { code: 'too_large', message: e.message } })
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'Invalid JSON body' } })
      }
      const name = body?.name
      const dataBase64 = body?.dataBase64
      if (typeof name !== 'string' || typeof dataBase64 !== 'string') {
        return sendJson(res, 400, { error: { code: 'bad_request', message: 'name and dataBase64 required' } })
      }
      const mediaType = typeof body?.mediaType === 'string' && body.mediaType ? body.mediaType : 'application/octet-stream'
      try {
        const bytes = Buffer.from(dataBase64, 'base64')
        const { id, name: stored } = await deps.upload.saveFile(bytes, name)
        return sendJson(res, 200, { id, name: stored, mediaType })
      } catch (e) {
        if (e instanceof FileTooLargeError) return sendJson(res, 413, { error: { code: 'too_large', message: e.message } })
        return sendJson(res, 400, { error: { code: 'bad_request', message: (e as Error).message } })
      }
    }
```

- [ ] **Step 4: 跑测试 + typecheck**

Run: `pnpm exec vitest run packages/server/src/http/server.test.ts ; pnpm --filter @zouyj/zuse-server exec tsc --noEmit`
Expected: 全绿；typecheck 无输出。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/http/server.ts packages/server/src/http/server.test.ts
git commit -m "feat(server): POST /api/uploads/file endpoint (I5b)"
```

---

### Task 5: server —— expandAttachments 'file' 分支 + 粘贴截断

**Files:** Modify `packages/server/src/upload/imageExpand.ts`; Test `packages/server/src/upload/imageExpand.test.ts`

- [ ] **Step 1: 写失败测试**

在 `imageExpand.test.ts` 的 `describe('makeExpandAttachments (I2)', ...)` 内追加：

```ts
  it("expands route:'file' attachments into an English note with the absolute path", async () => {
    // fakeUpload only implements readBase64; give it a filePath too for this test.
    const upload = { readBase64: async () => ({ data: '', mediaType: '' }), filePath: (id: string, name: string) => `/up/${id}/${name}` } as unknown as UploadService
    const expand = makeExpandAttachments(upload)
    const msg: Message = {
      ...textMsg('read it'),
      attachments: [{ id: 'f1', name: 'report.pdf', mediaType: 'application/pdf', route: 'file' }],
    }
    const out = await expand([msg])
    const content = out[0]!.content
    expect(content).toHaveLength(2)
    const note = (content[0] as { type: 'text'; text: string }).text
    expect(note).toContain('The user attached a file')
    expect(note).toContain('Read/Bash')
    expect(note).toContain('/up/f1/report.pdf')
    expect(content[1]).toEqual({ type: 'text', text: 'read it' })
  })

  it('multiple route:file attachments list each path under a plural header', async () => {
    const upload = { readBase64: async () => ({ data: '', mediaType: '' }), filePath: (id: string, name: string) => `/up/${id}/${name}` } as unknown as UploadService
    const expand = makeExpandAttachments(upload)
    const msg: Message = {
      ...textMsg('q'),
      attachments: [
        { id: 'a', name: 'x.csv', mediaType: 'text/csv', route: 'file' },
        { id: 'b', name: 'y.zip', mediaType: 'application/zip', route: 'file' },
      ],
    }
    const note = ((await expand([msg]))[0]!.content[0] as { type: 'text'; text: string }).text
    expect(note).toContain('The user attached 2 files')
    expect(note).toContain('▍x.csv — /up/a/x.csv')
    expect(note).toContain('▍y.zip — /up/b/y.zip')
  })

  it('block order is image → parsed → pasted → file → original content', async () => {
    const upload = { readBase64: async (id: string) => ({ data: 'IMG', mediaType: 'image/png' }), filePath: (id: string, name: string) => `/up/${id}/${name}` } as unknown as UploadService
    const expand = makeExpandAttachments(upload)
    const msg: Message = {
      ...textMsg('all'),
      attachments: [
        { id: 'd', name: 'p.png', mediaType: 'image/png', route: 'direct' },
        { id: 'p', name: '粘贴文本 #1', mediaType: 'text/plain', route: 'pasted', text: '段' },
        { id: 'f', name: 'a.bin', mediaType: 'application/octet-stream', route: 'file' },
      ],
    }
    const content = (await expand([msg]))[0]!.content
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'IMG' } })
    expect((content[1] as { type: 'text'; text: string }).text).toContain('段')          // pasted
    expect((content[2] as { type: 'text'; text: string }).text).toContain('/up/f/a.bin') // file
    expect(content[3]).toEqual({ type: 'text', text: 'all' })
  })

  it('truncates an oversized pasted segment CC-style (head 500 + marker + tail 500); attachment.text stays full', async () => {
    const upload = { readBase64: async () => ({ data: '', mediaType: '' }) } as unknown as UploadService
    const expand = makeExpandAttachments(upload)
    const big = 'A'.repeat(600) + '\n'.repeat(7) + 'B'.repeat(600) // 1207 chars, 7 newlines in the middle
    // pad to exceed 10000
    const huge = big + 'C'.repeat(10000)
    const msg: Message = {
      ...textMsg('q'),
      attachments: [{ id: 'p1', name: '粘贴文本 #1', mediaType: 'text/plain', route: 'pasted', text: huge }],
    }
    const note = ((await expand([msg]))[0]!.content[0] as { type: 'text'; text: string }).text
    expect(note.length).toBeLessThan(huge.length)          // truncated
    expect(note).toContain('lines truncated …]')            // marker present
    expect(note.startsWith('[以下是我粘贴的 1 段文本')).toBe(true) // still the pasted header
    // the stored attachment is NOT mutated
    expect(msg.attachments![0]!.text).toBe(huge)
  })

  it('a short pasted segment is not truncated', async () => {
    const upload = { readBase64: async () => ({ data: '', mediaType: '' }) } as unknown as UploadService
    const expand = makeExpandAttachments(upload)
    const msg: Message = { ...textMsg('q'), attachments: [{ id: 'p1', name: '粘贴文本 #1', mediaType: 'text/plain', route: 'pasted', text: 'short' }] }
    const note = ((await expand([msg]))[0]!.content[0] as { type: 'text'; text: string }).text
    expect(note).toContain('short')
    expect(note).not.toContain('truncated')
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/server/src/upload/imageExpand.test.ts`
Expected: FAIL（'file' 分支缺失；截断未实现）。

- [ ] **Step 3: 实现**

> **⚠️ 已废止（2026-07-12）**：下面 3a/3b 的"模型侧截断"（`truncateForModel` + 两个常量）误读了 cc-haha —— cc 的截断只作用于输入框显示，提交时展开成全文喂给模型。本仓库随后删除了这段模型侧截断，pasted 分支改为发全文。3a/3b 保留仅作历史记录，勿照抄。详见 spec 的"2026-07-12 修正"节。

3a. 在 `imageExpand.ts` 顶部（`makeExpandAttachments` 之前）加常量 + 截断 helper：
```ts
/** Pasted text longer than this (chars) is truncated in the model-facing block — matches cc-haha's
 *  TRUNCATION_THRESHOLD. The full text still lives on the attachment (bubble/lightbox show all). */
const PASTE_TRUNCATE_THRESHOLD = 10000
const PASTE_PREVIEW_HALF = 500 // chars kept at head and tail (cc-haha PREVIEW_LENGTH / 2)

/** CC-style truncation: keep head + tail, replace the middle with a line-count marker. */
function truncateForModel(t: string): string {
  if (t.length <= PASTE_TRUNCATE_THRESHOLD) return t
  const head = t.slice(0, PASTE_PREVIEW_HALF)
  const tail = t.slice(-PASTE_PREVIEW_HALF)
  const lines = (t.slice(PASTE_PREVIEW_HALF, -PASTE_PREVIEW_HALF).match(/\r\n|\r|\n/g) || []).length
  return `${head}\n[… ${lines} lines truncated …]\n${tail}`
}
```

3b. 在 pasted 分支里，把每段正文过一遍 `truncateForModel`。找到 pasted body 构造：
```ts
      const body = pasted
        .map((t, i) => (multi ? `▍粘贴文本 ${i + 1}\n${t}` : t))
        .join('\n\n')
```
改为：
```ts
      const body = pasted
        .map((t, i) => { const shown = truncateForModel(t); return multi ? `▍粘贴文本 ${i + 1}\n${shown}` : shown })
        .join('\n\n')
```

3c. 在 pasted 块 push 之后、`return` 之前，加 file 分支：
```ts
    // file (I5b)：上传的任意文件——不读盘、不进原生块，只产出一条英文说明 + 绝对路径，让模型自己用
    // Read/Bash 或 skill/agent 处理（读不了就直说）。路径由 upload.filePath 现算；坏 id 跳过该文件。
    const fileEntries = atts
      .filter((a) => a.route === 'file')
      .map((a) => { try { return `▍${a.name} — ${upload.filePath(a.id, a.name)}` } catch { return null } })
      .filter((s): s is string => s !== null)
    if (fileEntries.length > 0) {
      const multi = fileEntries.length > 1
      const header = multi
        ? `[The user attached ${fileEntries.length} files, saved on this machine. To use their contents, read these paths with the Read/Bash tools or an appropriate skill/agent; if you can't process a file, say so plainly.]\n\n`
        : `[The user attached a file, saved on this machine. To use it, read the path with the Read/Bash tools or an appropriate skill/agent; if you can't process it, say so plainly.]\n\n`
      blocks.push({ type: 'text', text: header + fileEntries.join('\n') })
    }
```

3d. 更新文件顶部 JSDoc：补一条 `route==='file'` 的说明（与 direct/parsed/pasted 并列）：
```
 *  - route==='file'（上传的任意文件）→ 一条英文说明块 + 每个文件的绝对路径（不读盘、不进原生块），
 *    让模型用 Read/Bash 或 skill/agent 自行处理。
```

> 注：`upload` 参数已是 `makeExpandAttachments(upload)` 的既有入参；`filePath` 是 Task 3 加的方法。测试里的 fake 需实现 `filePath`（见 Step 1）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run packages/server/src/upload/imageExpand.test.ts`
Expected: PASS（原有 + 新增全过）。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/upload/imageExpand.ts packages/server/src/upload/imageExpand.test.ts
git commit -m "feat(server): expandAttachments route 'file' note + CC-style pasted truncation (I5b)"
```

---

### Task 6: server —— SessionManager + clientMessage 贯穿 files

**Files:** Modify `packages/server/src/session/SessionManager.ts`, `packages/server/src/ws/clientMessage.ts`; Test `packages/server/src/session/SessionManager.test.ts`, `packages/server/src/ws/clientMessage.test.ts`

> **镜像 `pastedTexts`。** 先 `grep -n "pastedTexts" packages/server/src/session/SessionManager.ts packages/server/src/ws/clientMessage.ts` 列出所有出现点；`files` 在**每一处**并列加一份。以下是逐点说明。

- [ ] **Step 1: 写失败测试**

在 `SessionManager.test.ts` 现有 I5a `pastedTexts` 测试旁追加（复用同一 `makeImageMgr`/`userMsgOf` helper）：
```ts
  it('submit with files attaches route:file attachments', async () => {
    const { mgr } = makeImageMgr({ scripts: [textTurn], vision: true })
    await mgr.submit('看文件', undefined, undefined, [{ id: 'f1', name: 'a.pdf', mediaType: 'application/pdf' }])
    expect(userMsgOf(mgr).attachments).toEqual([
      { id: 'f1', name: 'a.pdf', mediaType: 'application/pdf', route: 'file' },
    ])
  })

  it('retry re-attaches a file-only turn (route-split recovers files, not images)', async () => {
    const { mgr, calls } = makeImageMgr({ scripts: [textTurn, textTurn], vision: true })
    await mgr.submit('', undefined, undefined, [{ id: 'f1', name: 'a.pdf', mediaType: 'application/pdf' }])
    expect(calls).toHaveLength(1)
    await mgr.retry()
    expect(calls).toHaveLength(2)
    expect(userMsgOf(mgr).attachments).toEqual([
      { id: 'f1', name: 'a.pdf', mediaType: 'application/pdf', route: 'file' },
    ])
  })
```
在 `clientMessage.test.ts` 追加：
```ts
  it('send forwards files to submit', () => {
    const mgr = fakeMgr()
    const err = vi.fn()
    const files = [{ id: 'f1', name: 'a.pdf', mediaType: 'application/pdf' }]
    applyClientMessage(mgr, JSON.stringify({ type: 'send', text: 'hi', files }), err)
    expect(mgr.submit).toHaveBeenCalledWith('hi', undefined, undefined, files, undefined)
  })
```

> 注：`submit` 签名将变成 `(text, images?, pastedTexts?, files?, opts?)`，故上面 send 断言里 `opts` 位是第 5 个 `undefined`。现有 send 测试（`toHaveBeenCalledWith('hi', undefined, undefined)` 之类）需相应补一个 `undefined`——这是签名变更的必然连带，改这些断言时一并处理。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/server/src/session/SessionManager.test.ts packages/server/src/ws/clientMessage.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现（逐点镜像 pastedTexts）**

3a. `submit` 签名（当前 `async submit(text, images?, pastedTexts?, opts?)`）→ 插入 `files` 为第 4 参：
```ts
  async submit(text: string, images?: UploadedImageRef[], pastedTexts?: PastedTextInput[], files?: UploadedFileRef[], opts?: { isResend?: boolean; echo?: boolean }): Promise<void> {
```
顶部 `@zuse/protocol` import 补 `UploadedFileRef`。

3b. 在 pasted attachments 构造之后，加 file attachments 构造（route:'file'，无读盘/描述）：
```ts
    if (files && files.length > 0) {
      const fileAtts: MessageAttachment[] = files.map((f) => ({ id: f.id, name: f.name, mediaType: f.mediaType, route: 'file' as const }))
      userAttachments = [...(userAttachments ?? []), ...fileAtts]
    }
```
（放在 `if (pastedTexts && ...) { ... }` 块之后、`buildContextView()` 之前。）

3c. 更新**每一处** `this.submit(...)` 调用为新签名（grep 确认；与 I5a 同样的点）：
- failover resend：`await this.submit(text, images, pastedTexts, files, { isResend: true })`
- 其它带 opts 的调用：opts 移到第 5 位，第 4 位补 `files`（resend 场景）或 `undefined`（echo 场景）。

3d. `echoAttachments(images?, pastedTexts?)` helper（模块函数）→ 加第 3 参 `files?`：
```ts
function echoAttachments(images?: UploadedImageRef[], pastedTexts?: PastedTextInput[], files?: UploadedFileRef[]): MessageAttachment[] | undefined {
  const atts: MessageAttachment[] = [
    ...(images ?? []).map((i) => ({ id: i.id, name: i.name, mediaType: i.mediaType })),
    ...(pastedTexts ?? []).map((p, idx) => ({ id: p.id, name: `粘贴文本 #${idx + 1}`, mediaType: 'text/plain', route: 'pasted' as const, text: p.text })),
    ...(files ?? []).map((f) => ({ id: f.id, name: f.name, mediaType: f.mediaType, route: 'file' as const })),
  ]
  return atts.length > 0 ? atts : undefined
}
```
调用点（submit 的 echo、drain、retry）都补上 `files` 实参（见下）。

3e. submit 的 echo：`this.emit({ type: 'user-echo', text, attachments: echoAttachments(images, pastedTexts, files) })`。

3f. `steer(text, images?, pastedTexts?)` → 加 `files?`：
```ts
  steer(text: string, images?: UploadedImageRef[], pastedTexts?: PastedTextInput[], files?: UploadedFileRef[]): void {
    const trimmed = text.trim()
    const hasAttachments = (images?.length ?? 0) > 0 || (pastedTexts?.length ?? 0) > 0 || (files?.length ?? 0) > 0
    if (trimmed === '' && !hasAttachments) return
    this.steerQueue.push({ text: trimmed, echoed: false, images, pastedTexts, files })
  }
```
`steerQueue` 字段类型加 `files?: UploadedFileRef[]`。

3g. `consumeSteer` 的 `isFoldable` 加 files 判定：
```ts
          const isFoldable = (s: { images?: unknown[]; pastedTexts?: unknown[]; files?: unknown[] }) => !(s.images?.length || s.pastedTexts?.length || s.files?.length)
```

3h. `drainSteerAsFollowUp`：merge files 并传给 submit + echo：
```ts
      const echoImages = unechoed.flatMap((s) => s.images ?? [])
      const echoPasted = unechoed.flatMap((s) => s.pastedTexts ?? [])
      const echoFiles = unechoed.flatMap((s) => s.files ?? [])
      this.emit({ type: 'user-echo', text: echoText, attachments: echoAttachments(echoImages, echoPasted, echoFiles) })
```
```ts
    const images = items.flatMap((s) => s.images ?? [])
    const pastedTexts = items.flatMap((s) => s.pastedTexts ?? [])
    const files = items.flatMap((s) => s.files ?? [])
    await this.submit(text, images.length ? images : undefined, pastedTexts.length ? pastedTexts : undefined, files.length ? files : undefined)
```

3i. `retry` 的 route 拆分加 files：
```ts
    const filesR: UploadedFileRef[] | undefined = (() => {
      const fs = atts.filter((a) => a.route === 'file').map((a) => ({ id: a.id, name: a.name, mediaType: a.mediaType }))
      return fs.length > 0 ? fs : undefined
    })()
```
更新 images 的 filter 排除 file（`a.route !== 'pasted' && a.route !== 'file'`），空文本 bail 也算上 files：
```ts
    if (text.trim() === '' && !images && !pastedTexts && !filesR) return
    ...
    this.emit({ type: 'user-echo', text, attachments: echoAttachments(images, pastedTexts, filesR) })
    await this.submit(text, images, pastedTexts, filesR)
```

3j. `clientMessage.ts`：
- send：`mgr.submit(msg.text, msg.images, msg.pastedTexts, msg.files)`
- steer busy：`mgr.steer(msg.text, msg.images, msg.pastedTexts, msg.files)`
- steer idle→submit(echo)：`mgr.submit(msg.text, msg.images, msg.pastedTexts, msg.files, { echo: true })`

- [ ] **Step 4: 跑测试 + typecheck**

Run: `pnpm exec vitest run packages/server/src/session/SessionManager.test.ts packages/server/src/ws/clientMessage.test.ts ; pnpm --filter @zouyj/zuse-server exec tsc --noEmit`
Expected: 全绿；typecheck 无输出。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/session/SessionManager.ts packages/server/src/ws/clientMessage.ts packages/server/src/session/SessionManager.test.ts packages/server/src/ws/clientMessage.test.ts
git commit -m "feat(server): thread files through submit/steer/drain/retry/echo (I5b)"
```

---

### Task 7: web —— uploadFile + send 管道接线

**Files:** Modify `packages/web/src/state/manageApi.ts`, `packages/web/src/components/Composer.tsx`(仅 onSend 类型), `packages/web/src/components/Shell.tsx`; Test `packages/web/src/state/manageApi.test.ts`

- [ ] **Step 1: `manageApi.uploadFile`**

在 `uploadImage` 之后加（复用 `blobToBase64`/`request`/`JSON_HEADERS`）：
```ts
/** 上传任意文件（非图片）：base64-in-JSON → POST /api/uploads/file → {id,name,mediaType}。无压缩。 */
export async function uploadFile(file: File): Promise<UploadedFileRef> {
  const dataBase64 = await blobToBase64(file)
  const r = await request('/api/uploads/file', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: file.name, mediaType: file.type || 'application/octet-stream', dataBase64 }) }, 'upload file')
  return (await r.json()) as UploadedFileRef
}
```
顶部 import 补 `UploadedFileRef`（从 `@zuse/protocol`，与 `UploadedImageRef` 同处）。

- [ ] **Step 2: `ComposerProps.onSend` 类型加 files**

`Composer.tsx`：
```ts
  onSend: (text: string, images?: UploadedImageRef[], pastedTexts?: PastedTextInput[], files?: UploadedFileRef[]) => void
```
import 补 `UploadedFileRef`。（Composer 本 task 不产出 files，submit 仍传现有实参——可选参，编译通过。）

- [ ] **Step 3: `Shell.onSend` 贯穿 files（帧 + 乐观 + steer）**

`Shell.tsx`：签名加 `files?: UploadedFileRef[]`；import 补 `UploadedFileRef`。在 onSend 里，把乐观 attachments 构造扩展并把 files 带进帧：
```ts
    const fileAtts = files?.map((f) => ({ id: f.id, name: f.name, mediaType: f.mediaType, route: 'file' as const })) ?? []
    const attachments = imageAtts.length || pastedAtts.length || fileAtts.length ? [...imageAtts, ...pastedAtts, ...fileAtts] : undefined
```
（`imageAtts`/`pastedAtts` 是现有的；加 `fileAtts` 并入 `attachments`。）
thinking 分支：`send({ type: 'steer', text, images, pastedTexts, files })`。
正常分支：`send({ type: 'send', text, images, pastedTexts, files })`。

- [ ] **Step 4: 测试 + typecheck + build**

`manageApi.test.ts` 加一条 `uploadFile` 用例（mock fetch/`request`，仿现有 `uploadImage` 测试断言 POST body 带 `name`+`dataBase64`、返回 ref）。
Run: `pnpm --filter @zuse/web test ; pnpm --filter @zuse/web exec tsc --noEmit ; pnpm --filter @zuse/web build`
Expected: 全绿；tsc 无输出；build exit 0。

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/state/manageApi.ts packages/web/src/components/Composer.tsx packages/web/src/components/Shell.tsx packages/web/src/state/manageApi.test.ts
git commit -m "feat(web): uploadFile + send pipeline threads files (I5b)"
```

---

### Task 8: web —— Composer 文件管道

**Files:** Modify `packages/web/src/components/Composer.tsx`, `packages/web/src/styles.css`; Test `packages/web/src/components/Composer.test.tsx`

- [ ] **Step 1: 写失败测试**

在 `Composer.test.tsx` 追加（复用现有 `uploadImage` mock 方式——同一个 `vi.mock('../state/manageApi.js', ...)` 需补 `uploadFile`）：

先确保 mock 覆盖 `uploadFile`（在文件顶部现有 `vi.mock('../state/manageApi.js', () => ({...}))` 里加：`uploadFile: vi.fn(async (f: File) => ({ id: 'fid-' + f.name, name: f.name, mediaType: f.type || 'application/octet-stream' }))`）。

```ts
  function dropFile(name: string, type: string) {
    const file = new File(['data'], name, { type })
    return { dataTransfer: { files: [file], items: [{ kind: 'file', type, getAsFile: () => file }] } }
  }

  it('a dropped non-image file becomes a 📎 file card (not an image, not textarea text)', async () => {
    render(<Composer thinking={false} onSend={() => {}} onStop={() => {}} />)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.drop(ta, dropFile('report.pdf', 'application/pdf'))
    expect(await screen.findByText(/report\.pdf/)).toBeTruthy()
    expect(ta.value).toBe('')
  })

  it('sends files and clears them after submit', async () => {
    const onSend = vi.fn()
    render(<Composer thinking={false} onSend={onSend} onStop={() => {}} />)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.drop(ta, dropFile('a.bin', 'application/octet-stream'))
    await screen.findByText(/a\.bin/)
    fireEvent.change(ta, { target: { value: '解析这个' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('解析这个', undefined, undefined, [expect.objectContaining({ name: 'a.bin' })])
    expect(screen.queryByText(/a\.bin/)).toBeNull()
  })

  it('× removes a file card', async () => {
    render(<Composer thinking={false} onSend={() => {}} onStop={() => {}} />)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.drop(ta, dropFile('x.zip', 'application/zip'))
    await screen.findByText(/x\.zip/)
    fireEvent.click(screen.getByLabelText(/移除 x\.zip/))
    expect(screen.queryByText(/x\.zip/)).toBeNull()
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zuse/web test`
Expected: FAIL（无文件卡片；onSend 无 files）。

- [ ] **Step 3: 实现 Composer 文件管道**

3a. import 补 `uploadFile` + `UploadedFileRef`（Task 7 已加 `UploadedFileRef`；这里加 `uploadFile`）。

3b. 类型 + 状态（`PendingPaste` 附近）：
```ts
/** A locally-staged non-image file: uploaded async, sent (as ref) on submit. */
interface PendingFile { key: string; name: string; status: 'uploading' | 'done' | 'error'; ref?: UploadedFileRef }
```
```ts
  const [files, setFiles] = useState<PendingFile[]>([])
```

3c. 非图片文件提取 helper（`imageFilesFrom` 附近，导出以便 Shell 整屏拖拽复用）：
```ts
/** Non-image files from a paste/drop payload (files that imageFilesFrom would NOT take). */
export function otherFilesFrom(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return []
  const out: File[] = []
  for (const f of Array.from(dt.files ?? [])) if (f && !f.type.startsWith('image/')) out.push(f)
  if (out.length === 0 && dt.items) {
    for (const it of Array.from(dt.items)) {
      if (it.kind === 'file' && !it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) out.push(f) }
    }
  }
  return out
}
```

3d. 上传 + 暂存函数（`addFiles`/`uploadInto` 附近）：
```ts
  function stageFiles(picked: File[]) {
    for (const file of picked) {
      const key = 'file-' + ++keySeq.current
      setFiles((p) => [...p, { key, name: file.name, status: 'uploading' }])
      uploadFile(file).then(
        (ref) => setFiles((p) => p.map((it) => (it.key === key ? { ...it, status: 'done', ref } : it))),
        () => setFiles((p) => p.map((it) => (it.key === key ? { ...it, status: 'error' } : it))),
      )
    }
  }
  function removeFile(key: string) { setFiles((p) => p.filter((it) => it.key !== key)) }
```

3e. 分流：`onPaste`/拖拽/回形针都要把非图片文件交给 `stageFiles`。
- `onPaste`：在图片分支之后、长文本分支之前，加：
```ts
    const otherFiles = otherFilesFrom(e.clipboardData)
    if (otherFiles.length > 0) { e.preventDefault(); stageFiles(otherFiles); return }
```
- 文件选择 input（回形针）：`accept` 由 `image/*` 改为不设 accept（接受任意）；`aria-label` 改 `添加附件`；`onChange` 里把选中的文件按 image/非image 分流：`const picked=[...]; const imgs=picked.filter(f=>f.type.startsWith('image/')); const others=picked.filter(f=>!f.type.startsWith('image/')); if(imgs.length)stage(imgs); if(others.length)stageFiles(others)`（沿用现有 input onChange 结构，找到它改）。
- `useImperativeHandle`：Shell 整屏拖拽目前只转发图片（`addImages`）。加一个 `addFiles` 到 handle 供 Shell 传非图片文件——见 Task 说明；若嫌 Shell 改动大，本 task 先只接 onPaste + 回形针，整屏拖拽非图片留到 Shell task。**本 task 至少覆盖 onPaste + 回形针分流。**

3f. `uploading` 纳入文件上传中：
```ts
  const uploadingFiles = files.some((f) => f.status === 'uploading')
```
`canSend`：
```ts
  const doneFileRefs = files.filter((f) => f.status === 'done' && f.ref).map((f) => f.ref!)
  const canSend = (value.trim() !== '' || doneRefs.length > 0 || pastes.length > 0 || doneFileRefs.length > 0) && !uploading && !uploadingFiles
```

3g. `clearPending` 加 `setFiles([])`。

3h. `submit`：
```ts
    if (uploading || uploadingFiles) { setAttachError('附件上传中，请稍候'); return }
    ...
    const fileRefs = doneFileRefs.length ? doneFileRefs : undefined
    onSend(v, doneRefs.length ? doneRefs : undefined, pastedTexts, fileRefs)
```
（发送判空条件也加 `doneFileRefs.length === 0`。）

3i. 渲染文件卡片托盘（pasted 卡片托盘之后）：
```tsx
      {files.length > 0 ? (
        <div className="attach-tray">
          {files.map((f) => (
            <div key={f.key} className={'paste-card' + (f.status === 'error' ? ' error' : '')} title={f.name}>
              <span className="paste-card-icon" aria-hidden="true">📎</span>
              <span className="paste-card-label">{f.name}{f.status === 'uploading' ? ' …' : ''}{f.status === 'error' ? ' (失败)' : ''}</span>
              <button className="attach-remove" aria-label={`移除 ${f.name}`} onClick={() => removeFile(f.key)}>×</button>
            </div>
          ))}
        </div>
      ) : null}
```

- [ ] **Step 4: styles.css**

文件卡片复用 `.paste-card`；错误态复用现有 `.error`（`.attach-thumb.error` 有 border-color，`.paste-card.error` 需要一条）：
```css
.paste-card.error { border-color: var(--bad); }
```

- [ ] **Step 5: 跑测试 + typecheck + build**

Run: `pnpm --filter @zuse/web test ; pnpm --filter @zuse/web exec tsc --noEmit ; pnpm --filter @zuse/web build`
Expected: 全绿；tsc 无输出；build exit 0。

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/Composer.tsx packages/web/src/styles.css packages/web/src/components/Composer.test.tsx
git commit -m "feat(web): composer file pipeline — stage/upload non-image files as 📎 cards (I5b)"
```

---

### Task 9: web —— Message 渲染 file 卡片 + 整屏拖拽非图片

**Files:** Modify `packages/web/src/components/Message.tsx`, `packages/web/src/components/Shell.tsx`; Test `packages/web/src/components/Message.test.tsx`

- [ ] **Step 1: 写失败测试**

`Message.test.tsx` 追加：
```ts
  it('renders a route:file attachment as a 📎 file card (no lightbox)', () => {
    const msg = {
      id: 'u1', role: 'user' as const,
      parts: [{ kind: 'text' as const, text: '解析' }],
      attachments: [{ id: 'f1', name: 'report.pdf', mediaType: 'application/pdf', route: 'file' as const }],
    }
    render(<Message msg={msg} />)
    expect(screen.getByText(/report\.pdf/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /查看/ })).toBeNull() // no preview button for a file
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zuse/web test`
Expected: FAIL（file 附件走了 MessageImage/PastedTextChip 分支或崩）。

- [ ] **Step 3: Message.tsx —— 加 file 分支**

在 user 分支 attachments map 的三元里加 file 判定（现有：pasted→PastedTextChip / else→MessageImage）：
```tsx
              {msg.attachments.map((a) => (
                a.route === 'pasted' ? <PastedTextChip key={a.id} a={a} />
                : a.route === 'file' ? <FileChip key={a.id} a={a} />
                : <MessageImage key={a.id} a={a} />
              ))}
```
在 `PastedTextChip` 之后加：
```tsx
/** One uploaded-file attachment: a folded 📎 card (name only). No preview — the file lives on the
 *  server and the model reads it via tools; there's no generic client-side viewer. */
function FileChip({ a }: { a: MessageAttachment }) {
  return (
    <div className="paste-card" title={a.name}>
      <span className="paste-card-icon" aria-hidden="true">📎</span>
      <span className="paste-card-label">{a.name}</span>
    </div>
  )
}
```

- [ ] **Step 4: Shell 整屏拖拽转发非图片文件**

`Shell.tsx` 的整屏 drop 处理目前把 `imageFilesFrom` 的图片交给 `composerRef.current.addImages`。加：从同一 drop 的 `otherFilesFrom` 取非图片文件交给 composer。需要 `ComposerHandle` 暴露 `addFiles`：
- `Composer.tsx`：`ComposerHandle` 加 `addFiles: (files: File[]) => void`；`useImperativeHandle` 里 `addFiles: stageFiles`（thinking 时也允许，沿用 I5a 放开守卫的结论——stageFiles 不拦 thinking）。
- `Shell.tsx` drop handler：`import { otherFilesFrom } from './Composer.js'`；drop 时 `const imgs = imageFilesFrom(dt); const others = otherFilesFrom(dt); if (imgs.length) composerRef.current?.addImages(imgs); if (others.length) composerRef.current?.addFiles(others)`。（找到现有 onDrop 里调用 addImages 的位置改。）

- [ ] **Step 5: 跑测试 + typecheck + build**

Run: `pnpm --filter @zuse/web test ; pnpm --filter @zuse/web exec tsc --noEmit ; pnpm --filter @zuse/web build`
Expected: 全绿；tsc 无输出；build exit 0。

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/Message.tsx packages/web/src/components/Shell.tsx packages/web/src/components/Composer.tsx packages/web/src/components/Message.test.tsx
git commit -m "feat(web): render file attachment as 📎 card + whole-page drop for non-image files (I5b)"
```

---

### Task 10: Playwright 端到端冒烟

- [ ] **Step 1: 重建 web + 重启 daemon**

```
pnpm --filter @zuse/web build
```
杀 4180 的进程，`pnpm exec tsx packages/server/src/bin.ts` 后台重起（**不要传 ZUSE_WEBDIR**——用内置 defaultWebDir，正斜杠会触发 dev 页回退）。`curl -s http://127.0.0.1:4180/ | grep -o 'assets/index-[a-z0-9-]*\.js'` 确认服真 SPA。

- [ ] **Step 2: 驱动 UI 验证（Playwright MCP）**

- 打开页面。
- 用 `browser_evaluate` 在 textarea 上派发一个带**非图片文件**的 `drop`（`DataTransfer` + `File(['pdf-bytes'], 'note.md', {type:'text/markdown'})`）→ 断言出现 `📎 note.md` 卡片、textarea 为空。
- 输入"读一下这个文件说说内容",回车发送。
- 断言用户气泡出现 `📎 note.md` 卡片（`browser_evaluate` 查 `.msg.you .paste-card`）。
- 等模型回复;断言回复里**引用了该文件路径或其内容**（说明 expandAttachments 的路径说明送达、且模型据此用工具读了）。截图存证。
- （可选）验证粘贴 >1 万字符时模型侧被截断——发一条粘贴超长文本,回复中模型只能看到首尾(难以直接断言,可跳过或人工核)。

- [ ] **Step 3: 记录结果**

如实记录断言的实际输出。任一失败 = 红门,停下修复,不合并。

---

## Self-Review

**1. Spec coverage：**
- 上传存储 `~/.zuse/uploads/<id>/<name>` + 只存不解析 → Task 3 ✓
- `POST /api/uploads/file` → Task 4 ✓
- `route:'file'` + 英文说明块 + 路径 → Task 1/2/5 ✓
- 块顺序 image→parsed→pasted→file→原文 → Task 5（测试断言）✓
- files 贯穿 submit/steer/retry/drain/echo + clientMessage → Task 6 ✓
- 前端上传/卡片/分流/mid-turn/整屏拖拽 → Task 7/8/9 ✓
- 气泡 📎 卡片 → Task 9 ✓
- 粘贴 CC 式截断（10000/500/marker，全文不动）→ Task 5 ✓
- "无法解析"=模型的话（说明文案含"say so plainly"）→ Task 5 文案 ✓
- 不建注册表/不建选择器 → 计划未引入 ✓

**2. Placeholder scan：** 无 TBD/TODO；每步给了确切代码/命令。Task 4/6/7 的测试步骤明确要求"以现有同类测试为镜像"并给了断言骨架（因这些 harness 是仓库既有、需就地复用，不宜臆造全文）——实现者按现有测试补全。

**3. Type consistency：**
- `UploadedFileRef {id,name,mediaType}`：protocol(T1)、submit/steer 参(T6)、web onSend/Shell(T7)、Composer(T8) 一致。
- `submit(text, images?, pastedTexts?, files?, opts?)`：T6 定义，所有调用点(drain/retry/failover/clientMessage)一致更新。
- `route:'file'` attachment `{id,name,mediaType,route:'file'}`：server(T6)、echoAttachments(T6)、Shell 乐观(T7)、Message FileChip 读 `a.name`(T9) 一致。
- `safeFilename` 幂等：save 存 safe name → ref.name → attachment.name → filePath(id,name) 再 safeFilename 得同值 → 路径一致（T3 测试锁定）。
- `otherFilesFrom` 导出（T8）→ Shell import（T9）一致。

自检未发现缺口。
