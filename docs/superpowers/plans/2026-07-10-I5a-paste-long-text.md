# I5a 粘贴长文本 → 附件卡片 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Web Composer 粘贴超阈值长文本时转成折叠卡片（像 I2 图片），发送时带编号标签拼在问题前发给模型，气泡（含刷新后）折叠成同款卡片、点击看全文。

**Architecture:** 复用 I2 的 attachment 管道——粘贴文本是 `MessageAttachment` 的新 `route:'pasted'`，全文内联在 `text` 字段随消息落盘；发送物化沿用 `makeExpandAttachments` 加 'pasted' 分支产出带编号前置文本块；快照投影原样透传 attachment，刷新后从持久化 `text` 重建卡片。

**Tech Stack:** TypeScript monorepo（pnpm workspaces）；packages: protocol（DTO）/ core（类型+纯函数）/ server（Node，tsx from source）/ web（React + Vite + Vitest + @testing-library/react）。测试：core/server 用 `pnpm exec vitest run packages/<pkg>`，web 用 `pnpm --filter @zuse/web test`。Windows + PowerShell（命令串接用 `;`）。

**Spec:** `docs/superpowers/specs/2026-07-10-I5a-paste-long-text-design.md`

**Branch:** `i5a-paste-long-text`（spec 已提交于此分支）。

---

## File Structure

| 文件 | 职责 | 改动 |
|---|---|---|
| `packages/protocol/src/index.ts` | 跨端 DTO 权威源 | `MessageAttachment` 加 `route:'pasted'` + `text?`；`ClientMessage.send` 加 `pastedTexts?`；新增 `PastedTextInput` |
| `packages/core/src/types.ts` | core 侧 Message/Attachment 类型 | `MessageAttachment` 同步 `route:'pasted'` + `text?` |
| `packages/core/src/compaction.ts` | 模型/文本纯函数集 | 新增 `pastedLineCount(text)` |
| `packages/server/src/upload/imageExpand.ts` | 发送前把 attachments 物化成 content 块 | 加 `route==='pasted'` 分支 |
| `packages/server/src/ws/clientMessage.ts` | WS 上行帧派发 | `send` 分支透传 `msg.pastedTexts` |
| `packages/server/src/session/SessionManager.ts` | 会话/回合编排 | `submit` 加 `pastedTexts` 参；build route:'pasted' attachments；failover resend + retry 按 route 拆分重建 |
| `packages/web/src/components/Composer.tsx` | 输入框 + 附件暂存 | `onSend` 签名加 pastedTexts；`onPaste` 文本分支；pastedTexts 状态 + 卡片托盘 |
| `packages/web/src/components/Shell.tsx` | 顶层容器，onSend 编排 | 透传 pastedTexts 到乐观 dispatch + WS 帧 |
| `packages/web/src/components/Message.tsx` | 消息气泡渲染 | 新增 `PastedTextChip`（route:'pasted'） |
| `packages/web/src/components/TextLightbox.tsx` | 全文查看弹层（新建） | 仿 ImageLightbox |
| `packages/web/src/styles.css` | 样式 | 粘贴卡片 + TextLightbox 样式 |

依赖顺序：protocol → core → server → web，逐 task 提交，每 task 结束后代码可编译。

---

### Task 1: protocol —— 扩展 DTO

**Files:**
- Modify: `packages/protocol/src/index.ts`

- [ ] **Step 1: 扩展 `MessageAttachment`（现位于第 41-49 行）**

把现有定义替换为：

```ts
/** 附着在一条消息上的附件（图片或粘贴文本；快照投影用）。图片不含 base64（字节在磁盘）；
 *  粘贴文本的全文内联在 `text` 字段。 */
export interface MessageAttachment {
  id: string
  name: string
  mediaType: string
  /** 该附件走了哪条路：direct=图直传主模型 / parsed=图经解析模型转述 / pasted=粘贴长文本。 */
  route?: 'direct' | 'parsed' | 'pasted'
  /** 解析路径下模型看到的文字描述（供气泡折叠展示）；direct 无。 */
  description?: string
  /** route==='pasted' 时的粘贴全文（内联持久化 + 随 snapshot 下发；图片路径无此字段）。 */
  text?: string
}
```

同时把 `SnapshotMessage.attachments` 的注释（第 29 行）由「图片」改为「附件（图片或粘贴文本）」。

- [ ] **Step 2: 新增 `PastedTextInput` 并扩展 send 帧**

在 `UploadedImageRef` 定义（第 34-38 行）之后新增：

```ts
/** 一段随 send 内联上行的粘贴文本（客户端持有，不经 HTTP 预上传）。 */
export interface PastedTextInput {
  id: string    // 客户端生成，用于卡片 key / 删除 / attachment id
  text: string  // 粘贴全文，已规范化 \r→\n（入栈即规范化，展示/计数/发送口径统一）
}
```

把 `ClientMessage` 的 send 分支（第 291 行）由

```ts
  | { type: 'send'; text: string; images?: UploadedImageRef[] }
```

改为

```ts
  | { type: 'send'; text: string; images?: UploadedImageRef[]; pastedTexts?: PastedTextInput[] }
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @zuse/protocol exec tsc --noEmit`
Expected: 无输出（exit 0）。protocol 是纯类型包，无单测。

- [ ] **Step 4: Commit**

```bash
git add packages/protocol/src/index.ts
git commit -m "feat(protocol): MessageAttachment route 'pasted' + text; send.pastedTexts (I5a)"
```

---

### Task 2: core —— 类型同步 + `pastedLineCount`

**Files:**
- Modify: `packages/core/src/types.ts`（`MessageAttachment` 第 33-39 行）
- Modify: `packages/core/src/compaction.ts`
- Test: `packages/core/src/compaction.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/core/src/compaction.test.ts` 顶部 import 块（`from './compaction.js'`）里加入 `pastedLineCount`，然后在文件末尾追加：

```ts
describe('pastedLineCount', () => {
  it('counts newline occurrences (CC semantics: "a\\nb\\nc" → 2)', () => {
    expect(pastedLineCount('')).toBe(0)
    expect(pastedLineCount('one line')).toBe(0)
    expect(pastedLineCount('a\nb\nc')).toBe(2)
    expect(pastedLineCount('a\nb\nc\n')).toBe(3) // trailing newline counts
  })
  it('handles \\r\\n and lone \\r', () => {
    expect(pastedLineCount('a\r\nb')).toBe(1)   // \r\n = one break
    expect(pastedLineCount('a\rb\rc')).toBe(2)  // lone \r
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/core/src/compaction.test.ts`
Expected: FAIL —— `pastedLineCount is not a function` / 导入报错。

- [ ] **Step 3: 实现 `pastedLineCount`**

在 `packages/core/src/compaction.ts` 的 `isNonChatModel` 函数之后新增：

```ts
/** 粘贴文本的行数标记 M（= 换行符个数，"a\nb\nc" → 2）。与 cc-haha getPastedTextRefNumLines
 *  同义；client 卡片与气泡共用，保证 "+M 行" 口径一致。 */
export function pastedLineCount(text: string): number {
  return (text.match(/\r\n|\r|\n/g) || []).length
}
```

（`export * from './compaction.js'` 已在 `packages/core/src/index.ts:17`，无需改导出。）

- [ ] **Step 4: 同步 `MessageAttachment`（`packages/core/src/types.ts` 第 33-39 行）**

替换为：

```ts
/** 附着在一条消息上的附件（图片或粘贴文本；与 protocol 的 MessageAttachment 结构对齐；图片不含 base64）。 */
export interface MessageAttachment {
  id: string
  name: string
  mediaType: string
  route?: 'direct' | 'parsed' | 'pasted'
  description?: string
  /** route==='pasted' 时的粘贴全文。 */
  text?: string
}
```

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run: `pnpm exec vitest run packages/core/src/compaction.test.ts ; pnpm --filter @zuse/core exec tsc --noEmit`
Expected: 测试全绿（含新增 2 个 pastedLineCount 用例）；typecheck 无输出。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/compaction.ts packages/core/src/compaction.test.ts
git commit -m "feat(core): pastedLineCount + MessageAttachment route 'pasted'/text (I5a)"
```

---

### Task 3: server —— `makeExpandAttachments` 加 'pasted' 分支

**Files:**
- Modify: `packages/server/src/upload/imageExpand.ts`
- Test: `packages/server/src/upload/imageExpand.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/server/src/upload/imageExpand.test.ts` 末尾（最后一个 `})` 之前的合适位置，`describe` 块内追加：

```ts
  it("expands a single route:'pasted' attachment into a labeled text block (no numbering)", async () => {
    const expand = makeExpandAttachments(fakeUpload({}))
    const msg: Message = {
      ...textMsg('分析这段日志'),
      attachments: [{ id: 'p1', name: 'Pasted text #1', mediaType: 'text/plain', route: 'pasted', text: 'ERROR foo\nERROR bar' }],
    }

    const out = await expand([msg])

    const content = out[0]!.content
    expect(content).toHaveLength(2) // one pasted-text block + the user text
    const block = (content[0] as { type: 'text'; text: string }).text
    expect(block).toContain('以下是我粘贴的 1 段文本')
    expect(block).toContain('ERROR foo\nERROR bar')
    expect(block).not.toContain('▍粘贴文本 1') // single → not numbered
    expect(content[1]).toEqual({ type: 'text', text: '分析这段日志' })
  })

  it('merges MULTIPLE pasted texts into ONE numbered block, material before the question', async () => {
    const expand = makeExpandAttachments(fakeUpload({}))
    const msg: Message = {
      ...textMsg('对比这两段'),
      attachments: [
        { id: 'p1', name: 'Pasted text #1', mediaType: 'text/plain', route: 'pasted', text: '第一段内容' },
        { id: 'p2', name: 'Pasted text #2', mediaType: 'text/plain', route: 'pasted', text: '第二段内容' },
      ],
    }

    const out = await expand([msg])

    const content = out[0]!.content
    expect(content).toHaveLength(2) // ONE combined block + user text
    const block = (content[0] as { type: 'text'; text: string }).text
    expect(block).toContain('以下是我粘贴的 2 段文本')
    expect(block).toContain('▍粘贴文本 1')
    expect(block).toContain('第一段内容')
    expect(block).toContain('▍粘贴文本 2')
    expect(block).toContain('第二段内容')
    expect(block.indexOf('粘贴文本 1')).toBeLessThan(block.indexOf('粘贴文本 2'))
    expect(content[1]).toEqual({ type: 'text', text: '对比这两段' })
  })

  it('orders blocks image → parsed-image-desc → pasted-text → original content', async () => {
    const upload = fakeUpload({ d1: { data: 'IMG', mediaType: 'image/png' } })
    const expand = makeExpandAttachments(upload)
    const msg: Message = {
      ...textMsg('看图和文本'),
      attachments: [
        { id: 'd1', name: 'pic.png', mediaType: 'image/png', route: 'direct' },
        { id: 'p1', name: 'Pasted text #1', mediaType: 'text/plain', route: 'pasted', text: '一段文字' },
      ],
    }

    const out = await expand([msg])

    const content = out[0]!.content
    expect(content).toHaveLength(3)
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'IMG' } })
    expect((content[1] as { type: 'text'; text: string }).text).toContain('一段文字')
    expect(content[2]).toEqual({ type: 'text', text: '看图和文本' })
  })

  it("skips a route:'pasted' attachment whose text is empty/whitespace", async () => {
    const expand = makeExpandAttachments(fakeUpload({}))
    const msg: Message = {
      ...textMsg('q'),
      attachments: [{ id: 'p1', name: 'Pasted text #1', mediaType: 'text/plain', route: 'pasted', text: '   ' }],
    }

    const out = await expand([msg])

    expect(out[0]).toBe(msg) // nothing to prepend → untouched original
    expect(out[0]!.content).toEqual([{ type: 'text', text: 'q' }])
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/server/src/upload/imageExpand.test.ts`
Expected: FAIL —— 新增 4 个用例断言不通过（'pasted' 分支未实现，pasted 附件被忽略）。

- [ ] **Step 3: 实现 'pasted' 分支**

编辑 `packages/server/src/upload/imageExpand.ts`。在 `parsed` 段构造之后、`const blocks: Block[] = [...imageBlocks]` 这一段里，把 parsed 块 push 之后紧接着加入 pasted 块。将现有的

```ts
    const blocks: Block[] = [...imageBlocks]
    if (parsed.length > 0) {
      const multi = parsed.length > 1
      const header = `[本条消息附带 ${parsed.length} 张图片，以下是${multi ? '每张' : '其'}内容描述（由图像解析模型转述，非用户原话）：]\n\n`
      const body = parsed
        .map((a, i) => (multi ? `▍图片 ${i + 1}（${a.name}）\n${a.desc}` : a.desc))
        .join('\n\n')
      blocks.push({ type: 'text', text: header + body })
    }
    return blocks.length ? { ...m, content: [...blocks, ...m.content] } : m
```

替换为（在 parsed 块之后追加 pasted 块的构造）：

```ts
    const blocks: Block[] = [...imageBlocks]
    if (parsed.length > 0) {
      const multi = parsed.length > 1
      const header = `[本条消息附带 ${parsed.length} 张图片，以下是${multi ? '每张' : '其'}内容描述（由图像解析模型转述，非用户原话）：]\n\n`
      const body = parsed
        .map((a, i) => (multi ? `▍图片 ${i + 1}（${a.name}）\n${a.desc}` : a.desc))
        .join('\n\n')
      blocks.push({ type: 'text', text: header + body })
    }
    // pasted：粘贴长文本合并成单个前置 text 块（材料在前、问题在后）；空/纯空白项跳过。
    const pasted = atts
      .filter((a) => a.route === 'pasted')
      .map((a) => (a.text ?? ''))
      .filter((t) => t.trim() !== '')
    if (pasted.length > 0) {
      const multi = pasted.length > 1
      const header = `[以下是我粘贴的 ${pasted.length} 段文本：]\n\n`
      const body = pasted
        .map((t, i) => (multi ? `▍粘贴文本 ${i + 1}\n${t}` : t))
        .join('\n\n')
      blocks.push({ type: 'text', text: header + body })
    }
    return blocks.length ? { ...m, content: [...blocks, ...m.content] } : m
```

同时更新文件顶部 JSDoc：在描述里补一句 pasted 路径（保持与 direct/parsed 说明并列）：

```
 *  - route==='pasted'（粘贴长文本）→ 全部非空段合并成**一个带编号标签的前置 text 块**，
 *    形如「[以下是我粘贴的 N 段文本：] ▍粘贴文本1\n<全文>…」，插在原 content 之前（材料在前）。
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run packages/server/src/upload/imageExpand.test.ts`
Expected: PASS —— 全部用例（原有 + 新增 4 个）通过。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/upload/imageExpand.ts packages/server/src/upload/imageExpand.test.ts
git commit -m "feat(server): expandAttachments handles route 'pasted' (I5a)"
```

---

### Task 4: server —— `submit` 接收 pastedTexts + failover/retry 按 route 拆分

**Files:**
- Modify: `packages/server/src/session/SessionManager.ts`
- Modify: `packages/server/src/ws/clientMessage.ts`
- Test: `packages/server/src/session/SessionManager.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/server/src/session/SessionManager.test.ts` 里，仿照现有 attachments 用例（约第 1850、1934 行附近的 `userMsgOf(mgr).attachments` 断言风格）新增。找到现有 attachments 测试所在的 `describe` 块，追加：

```ts
  it('submit with pastedTexts attaches route:pasted attachments (name #N, inline text)', async () => {
    const mgr = makeManagerForImages() // 复用本文件里构造带 expandAttachments 的 manager 的现有 helper
    await mgr.submit('看这两段', undefined, [
      { id: 'pa', text: '第一段' },
      { id: 'pb', text: '第二段' },
    ])
    expect(userMsgOf(mgr).attachments).toEqual([
      { id: 'pa', name: 'Pasted text #1', mediaType: 'text/plain', route: 'pasted', text: '第一段' },
      { id: 'pb', name: 'Pasted text #2', mediaType: 'text/plain', route: 'pasted', text: '第二段' },
    ])
  })

  it('projectMessages carries pasted attachments (with text) into the snapshot', async () => {
    const mgr = makeManagerForImages()
    await mgr.submit('分析', undefined, [{ id: 'pa', text: '日志内容' }])
    const snap = mgr.snapshot() // 复用现有获取 snapshot 的方式（本文件其它用例已用）
    const userSnap = snap.messages.find((m) => m.role === 'user')!
    expect(userSnap.attachments).toEqual([
      { id: 'pa', name: 'Pasted text #1', mediaType: 'text/plain', route: 'pasted', text: '日志内容' },
    ])
  })
```

> 说明：`makeManagerForImages` / `userMsgOf` / `mgr.snapshot()` 是本测试文件里已有的 helper（现有 I2 attachments 用例正在用）。实现前先在文件里确认它们的确切名字，若不同则用等价 helper。若现有 manager helper 没接 `expandAttachments`，pasted 附件的挂载不依赖 expand 也应成立（submit 只是把 pastedTexts 转成 attachments 挂到消息上）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/server/src/session/SessionManager.test.ts`
Expected: FAIL —— `submit` 尚不接受第三参 pastedTexts / 用户消息无 route:'pasted' attachments。

- [ ] **Step 3: 扩展 `submit` 签名与 attachments 构造**

在 `packages/server/src/session/SessionManager.ts`：

3a. 把 `submit` 签名（第 811 行）由

```ts
  async submit(text: string, images?: UploadedImageRef[], opts?: { isResend?: boolean; echo?: boolean }): Promise<void> {
```

改为（新增第三参 `pastedTexts`，opts 顺延为第四参）：

```ts
  async submit(text: string, images?: UploadedImageRef[], pastedTexts?: PastedTextInput[], opts?: { isResend?: boolean; echo?: boolean }): Promise<void> {
```

3b. 在文件顶部 import 里，从 `@zuse/protocol` 补 `PastedTextInput` 类型（找到现有 `import type { ... UploadedImageRef ... } from '@zuse/protocol'` 那行，加入 `PastedTextInput`）。

3c. 在图片路由块结束（第 911 行 `}` 之后、`const conversation = this.buildContextView()` 之前）插入 pasted 附件构造：

```ts
    // Pasted long text (I5a): each staged segment becomes a route:'pasted' attachment carrying the
    // full text inline. No vision/imageClient branching — expandAttachments materializes them as a
    // labeled text block at send time (same pipeline as images). Merge onto any image attachments.
    if (pastedTexts && pastedTexts.length > 0) {
      const pastedAtts: MessageAttachment[] = pastedTexts
        .filter((p) => (p.text ?? '').trim() !== '')
        .map((p, idx) => ({
          id: p.id, name: `Pasted text #${idx + 1}`, mediaType: 'text/plain', route: 'pasted' as const, text: p.text,
        }))
      if (pastedAtts.length > 0) userAttachments = [...(userAttachments ?? []), ...pastedAtts]
    }
```

3d. 修正内部两处递归 `submit` 调用，把 pastedTexts 透传下去：

- 第 1095 行 failover resend：`await this.submit(text, images, { isResend: true })` → `await this.submit(text, images, pastedTexts, { isResend: true })`
- 若文件内还有其它带 `{ isResend: true }` 或 `{ echo: true }` 的 `this.submit(...)` 调用（grep `this.submit(` 确认），一律把 opts 移到第四参、并在第三参补 `pastedTexts`（resend 场景）或 `undefined`（echo 场景本就无粘贴文本）。

- [ ] **Step 4: retry 路径按 route 拆分 attachments**

`retry`（约第 1268-1288 行）当前把**所有** attachments 映射回 `images`。pasted 附件不能当图片（会触发 readImageBase64 找不到磁盘文件）。把第 1278-1281 行的 images 重建替换为按 route 拆分：

```ts
    // #3 / I5a: recover the turn's attachments so retry re-attaches them. Split by route: image
    // attachments (direct/parsed) → images param (re-routed via resolveVision); pasted → pastedTexts
    // param (never sent through the image path — no disk file exists for them).
    const atts = userMsg.attachments ?? []
    const images: UploadedImageRef[] | undefined = (() => {
      const imgs = atts.filter((a) => a.route !== 'pasted').map((a) => ({ id: a.id, name: a.name, mediaType: a.mediaType }))
      return imgs.length > 0 ? imgs : undefined
    })()
    const pastedTexts: PastedTextInput[] | undefined = (() => {
      const ps = atts.filter((a) => a.route === 'pasted').map((a) => ({ id: a.id, text: a.text ?? '' }))
      return ps.length > 0 ? ps : undefined
    })()
```

并把该函数末尾（第 1287 行）`await this.submit(text, images)` 改为 `await this.submit(text, images, pastedTexts)`。

- [ ] **Step 5: clientMessage 透传 pastedTexts**

`packages/server/src/ws/clientMessage.ts` 第 37 行 send 分支：

```ts
        mgr.submit(msg.text, msg.images).catch((err) => sendError(err instanceof Error ? err.message : String(err)))
```

改为：

```ts
        mgr.submit(msg.text, msg.images, msg.pastedTexts).catch((err) => sendError(err instanceof Error ? err.message : String(err)))
```

第 49 行的 steer→normal-turn 分支（`mgr.submit(msg.text, undefined, { echo: true })`）改为：

```ts
        else mgr.submit(msg.text, undefined, undefined, { echo: true }).catch((err) => sendError(err instanceof Error ? err.message : String(err)))
```

- [ ] **Step 6: 跑测试确认通过 + typecheck**

Run: `pnpm exec vitest run packages/server/src/session/SessionManager.test.ts ; pnpm --filter @zouyj/zuse-server exec tsc --noEmit`
Expected: 新增 2 个用例通过；typecheck 无输出。若 SessionService.test.ts 那条落盘时序用例在全量下偶发失败，单跑该文件应通过（与本改无关，见 CLAUDE.md：以实际命令输出为准）。

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/session/SessionManager.ts packages/server/src/ws/clientMessage.ts packages/server/src/session/SessionManager.test.ts
git commit -m "feat(server): submit accepts pastedTexts → route:pasted attachments; retry/failover split by route (I5a)"
```

---

### Task 5: web —— send 管道接线（onSend 签名 + Shell 乐观 dispatch + WS 帧）

**Files:**
- Modify: `packages/web/src/components/Composer.tsx`（仅 `ComposerProps.onSend` 类型）
- Modify: `packages/web/src/components/Shell.tsx`（`onSend` 编排）
- Test: `packages/web/src/state/reducer.test.ts`（乐观 attachments 已有覆盖，补 pasted 一例）

> 本 task 只改「发送管道」；Composer 内部暂不产出 pastedTexts（Task 6 做）。改完后 Composer 的 `submit()` 仍只传 `(v, images)`，pastedTexts 走可选参 → 编译通过。

- [ ] **Step 1: 扩展 `ComposerProps.onSend` 类型（`Composer.tsx` 第 9 行）**

```ts
  onSend: (text: string, images?: UploadedImageRef[], pastedTexts?: PastedTextInput[]) => void
```

并在 `Composer.tsx` 顶部 import（第 2 行）补 `PastedTextInput`：

```ts
import type { UploadedImageRef, PastedTextInput } from '@zuse/protocol'
```

- [ ] **Step 2: Shell.onSend 接收并透传（`Shell.tsx` 第 106-130 行）**

把 `onSend` 由

```ts
  const onSend = (text: string, images?: UploadedImageRef[]) => {
```

改为

```ts
  const onSend = (text: string, images?: UploadedImageRef[], pastedTexts?: PastedTextInput[]) => {
```

在 steer 分支（第 118-124 行）：steer 仍是纯文本（不带附件），保持原样丢弃 pastedTexts（与丢弃 images 一致）。在正常发送分支（第 128-129 行）替换为：

```ts
    // Optimistic image attachments carry only id/name/mediaType (route/description filled by the
    // authoritative snapshot). Pasted-text attachments are fully known now (route + full text), so
    // include them so the bubble shows the folded card immediately.
    const imageAtts = images?.map((i) => ({ id: i.id, name: i.name, mediaType: i.mediaType })) ?? []
    const pastedAtts = pastedTexts?.map((p, idx) => ({
      id: p.id, name: `Pasted text #${idx + 1}`, mediaType: 'text/plain', route: 'pasted' as const, text: p.text,
    })) ?? []
    const attachments = [...imageAtts, ...pastedAtts]
    dispatch({ kind: 'user-send', id: nextId('u'), text, attachments: attachments.length ? attachments : undefined })
    send({ type: 'send', text, images, pastedTexts })
```

在 `Shell.tsx` 顶部 import 补 `PastedTextInput`（找到从 `@zuse/protocol` 导入 `UploadedImageRef` 的那行加入）。

> 编号一致性：Shell 乐观 dispatch 与 server submit 都用「本条消息内 pasted 项顺序 `#idx+1`」编号，两边一致；快照回来后 attachments 被权威覆盖，编号仍一致。

- [ ] **Step 3: 写并跑 reducer 测试（乐观 pasted attachment）**

`packages/web/src/state/reducer.test.ts` 已有 `user-send` 带 attachments 的用例（约第 125 行）。仿照追加一条断言 pasted attachment 能进 state 的用例：

```ts
  it('user-send carries pasted-text attachments onto the optimistic user message', () => {
    const s = reduce(initialState, { kind: 'user-send', id: 'u1', text: '分析', attachments: [
      { id: 'pa', name: 'Pasted text #1', mediaType: 'text/plain', route: 'pasted', text: '日志' },
    ] })
    const msg = s.messages.find((m) => m.id === 'u1')!
    expect(msg.attachments).toEqual([
      { id: 'pa', name: 'Pasted text #1', mediaType: 'text/plain', route: 'pasted', text: '日志' },
    ])
  })
```

Run: `pnpm --filter @zuse/web test`
Expected: 全绿（含新用例）。若 reducer 的 `user-send` action 类型未含 route:'pasted'/text，因 `MessageAttachment` 来自 protocol（Task 1 已扩展）应自动兼容；如报类型错，确认 `reducer.ts:11` 的 `attachments?: MessageAttachment[]` 用的是 protocol 的类型。

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @zuse/web exec tsc --noEmit`
Expected: 无输出。

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/Composer.tsx packages/web/src/components/Shell.tsx packages/web/src/state/reducer.test.ts
git commit -m "feat(web): send pipeline threads pastedTexts + optimistic pasted attachments (I5a)"
```

---

### Task 6: web —— Composer 粘贴长文本 → 卡片

**Files:**
- Modify: `packages/web/src/components/Composer.tsx`
- Modify: `packages/web/src/styles.css`
- Test: `packages/web/src/components/Composer.test.tsx`

- [ ] **Step 1: 写失败测试**

在 `packages/web/src/components/Composer.test.tsx` 的 `describe('Composer', ...)` 内追加。构造一个超阈值文本（>2 换行）与一个不超阈值文本：

```ts
  function pasteEvent(text: string) {
    return { clipboardData: { getData: (t: string) => (t === 'text' || t === 'text/plain' ? text : ''), files: [], items: [] } }
  }

  it('paste exceeding threshold becomes a card, NOT textarea text', () => {
    render(<Composer thinking={false} onSend={() => {}} onStop={() => {}} />)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.paste(ta, pasteEvent('l1\nl2\nl3\nl4')) // 3 newlines > 2 → card
    expect(screen.getByText(/Pasted text #1/)).toBeTruthy()
    expect(ta.value).toBe('') // not inserted into textarea
  })

  it('short paste (<=800 chars, <=2 newlines) is left to the browser (no card)', () => {
    render(<Composer thinking={false} onSend={() => {}} onStop={() => {}} />)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.paste(ta, pasteEvent('a\nb')) // 1 newline, short → no card
    expect(screen.queryByText(/Pasted text #/)).toBeNull()
  })

  it('sends pastedTexts and clears them after submit', () => {
    const onSend = vi.fn()
    render(<Composer thinking={false} onSend={onSend} onStop={() => {}} />)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.paste(ta, pasteEvent('x\ny\nz\nw'))
    fireEvent.change(ta, { target: { value: '分析这段' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('分析这段', undefined, [expect.objectContaining({ text: 'x\ny\nz\nw' })])
    expect(screen.queryByText(/Pasted text #/)).toBeNull() // cleared
  })

  it('can send with only a pasted card and no typed text', () => {
    const onSend = vi.fn()
    render(<Composer thinking={false} onSend={onSend} onStop={() => {}} />)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.paste(ta, pasteEvent('big\nblock\nof\ntext'))
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('', undefined, [expect.objectContaining({ text: 'big\nblock\nof\ntext' })])
  })

  it('× removes a pasted card', () => {
    render(<Composer thinking={false} onSend={() => {}} onStop={() => {}} />)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.paste(ta, pasteEvent('one\ntwo\nthree\nfour'))
    fireEvent.click(screen.getByLabelText(/移除 Pasted text #1/))
    expect(screen.queryByText(/Pasted text #1/)).toBeNull()
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zuse/web test`
Expected: FAIL —— 无卡片、onSend 未收到 pastedTexts。

- [ ] **Step 3: 实现 Composer 粘贴分支 + 卡片状态**

在 `Composer.tsx`：

3a. 顶部 import 补 `pastedLineCount`：

```ts
import { pastedLineCount } from '@zuse/core'
```

（`@zuse/core` 已是 web 依赖；若 import 报错，确认 web 已依赖 `@zuse/core`——它在 Message 等处已用到该包类型。）

3b. 新增本地类型与阈值常量（放在 `PendingImage` interface 之后、`MAX_IMAGES` 附近）：

```ts
/** A locally-staged pasted-text segment: shown as a card, sent inline on submit. */
interface PendingPaste { id: string; text: string }

const PASTE_CHAR_THRESHOLD = 800
const PASTE_NEWLINE_THRESHOLD = 2
```

3c. 在组件内、`const [pending, setPending] = useState<PendingImage[]>([])`（第 62 行）附近新增粘贴状态：

```ts
  const [pastes, setPastes] = useState<PendingPaste[]>([])
  const pasteSeqRef = useRef(0)
```

3d. 把 `onPaste`（第 153-158 行）替换为「先图片、后文本」：

```ts
  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = imageFilesFrom(e.clipboardData)
    if (files.length > 0) {
      e.preventDefault() // don't also paste the image as a data-URL string
      stage(files)
      return
    }
    // Long-text paste → card (CC threshold: >800 chars OR >2 newlines). Shorter paste: let it through.
    const raw = e.clipboardData.getData('text') || e.clipboardData.getData('text/plain')
    if (!raw) return
    const text = raw.replace(/\r\n?/g, '\n') // normalize \r\n and lone \r → \n
    if (text.length > PASTE_CHAR_THRESHOLD || pastedLineCount(text) > PASTE_NEWLINE_THRESHOLD) {
      e.preventDefault()
      const id = `pasted-${pasteSeqRef.current++}`
      setPastes((prev) => [...prev, { id, text }])
    }
    // else: no preventDefault → browser inserts it into the textarea normally.
  }
```

3e. `canSend`（第 166 行）纳入 pastes：

```ts
  const canSend = (value.trim() !== '' || doneRefs.length > 0 || pastes.length > 0) && !uploading
```

3f. `clearPending`（第 168-172 行）里一并清空 pastes：

```ts
  function clearPending() {
    for (const p of pending) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl)
    setPending([])
    setPastes([])
    setAttachError('')
  }
```

3g. `submit`（第 174-183 行）纳入 pastes：把发送条件与 onSend 调用改为：

```ts
  function submit() {
    if (uploading) { setAttachError('图片上传中，请稍候'); return }
    const v = value.trim()
    if (!v && doneRefs.length === 0 && pastes.length === 0) return
    const pastedTexts = pastes.length ? pastes.map((p) => ({ id: p.id, text: p.text })) : undefined
    onSend(v, doneRefs.length ? doneRefs : undefined, pastedTexts)
    clearPending()
    setValue(''); setHistIdx(null)
    taRef.current?.focus()
  }
```

3h. 增加移除函数（放在 `clearPending` 附近）：

```ts
  function removePaste(id: string) { setPastes((prev) => prev.filter((p) => p.id !== id)) }
```

3i. 渲染卡片：在附件托盘处（第 224-237 行的 `{pending.length > 0 ? ...}` 块）之后，追加 pasted 卡片托盘：

```tsx
      {pastes.length > 0 ? (
        <div className="attach-tray">
          {pastes.map((p, i) => {
            const m = pastedLineCount(p.text)
            const label = m === 0 ? `Pasted text #${i + 1}` : `Pasted text #${i + 1} (+${m} 行)`
            return (
              <div key={p.id} className="paste-card" title={label}>
                <span className="paste-card-icon" aria-hidden="true">📄</span>
                <span className="paste-card-label">{label}</span>
                <button className="attach-remove" aria-label={`移除 Pasted text #${i + 1}`} onClick={() => removePaste(p.id)}>×</button>
              </div>
            )
          })}
        </div>
      ) : null}
```

- [ ] **Step 4: 加卡片样式（`styles.css`，`.attach-remove` 规则之后，约第 303 行后）**

```css
.paste-card { position: relative; display: flex; align-items: center; gap: 6px; height: 60px; padding: 0 26px 0 10px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface-2); flex: none; max-width: 220px; }
.paste-card-icon { font-size: 18px; line-height: 1; }
.paste-card-label { font-size: 12px; color: var(--fg-2, var(--fg)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
```

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run: `pnpm --filter @zuse/web test ; pnpm --filter @zuse/web exec tsc --noEmit`
Expected: 全绿；typecheck 无输出。

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/Composer.tsx packages/web/src/styles.css packages/web/src/components/Composer.test.tsx
git commit -m "feat(web): paste long text → folded card in composer (I5a)"
```

---

### Task 7: web —— 气泡卡片 `PastedTextChip` + `TextLightbox`

**Files:**
- Create: `packages/web/src/components/TextLightbox.tsx`
- Modify: `packages/web/src/components/Message.tsx`
- Modify: `packages/web/src/styles.css`
- Test: `packages/web/src/components/Message.test.tsx`

- [ ] **Step 1: 写失败测试**

在 `packages/web/src/components/Message.test.tsx` 追加（仿现有 MessageImage 用例风格；`msg` 的确切构造照该文件已有 helper）：

```ts
  it('renders a pasted-text attachment as a card and opens full text on click', () => {
    const msg = {
      id: 'u1', role: 'user' as const,
      parts: [{ kind: 'text' as const, text: '分析' }],
      attachments: [{ id: 'pa', name: 'Pasted text #1', mediaType: 'text/plain', route: 'pasted' as const, text: 'LINE A\nLINE B' }],
    }
    render(<Message msg={msg} />)
    // card label with line count (1 newline → +1 行)
    expect(screen.getByText(/Pasted text #1 \(\+1 行\)/)).toBeTruthy()
    // click opens the lightbox with the full text
    fireEvent.click(screen.getByRole('button', { name: /查看 Pasted text #1/ }))
    expect(screen.getByText('LINE A\nLINE B')).toBeTruthy()
  })
```

> `<Message>` 的必填 props 以该测试文件现有用例为准（可能需要传 `showActions` 等）；照抄同文件里最简单的一条 user-message 用例的 props 组合。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zuse/web test`
Expected: FAIL —— pasted 附件被 `MessageImage` 当图片渲染（`<img>` 空 src），无卡片、无全文。

- [ ] **Step 3: 新建 `TextLightbox.tsx`**

```tsx
import { useEffect } from 'react'
import { createPortal } from 'react-dom'

/**
 * In-app full-text viewer for a pasted-text attachment: a portaled full-screen overlay showing the
 * text in a scrollable monospace panel (mirrors ImageLightbox). Click the backdrop or press Escape
 * to close; clicking the panel does not close. Escape is capture-phase + stopPropagation so it beats
 * other window Escape handlers (e.g. the composer's stop-turn).
 */
export function TextLightbox({ text, title, onClose }: { text: string; title?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return createPortal(
    <div className="lightbox-overlay" onClick={onClose}>
      <div className="textbox-panel" onClick={(e) => e.stopPropagation()}>
        {title ? <div className="textbox-title">{title}</div> : null}
        <pre className="textbox-pre">{text}</pre>
      </div>
      <button className="lightbox-close" aria-label="关闭" onClick={onClose}>×</button>
    </div>,
    document.body,
  )
}
```

- [ ] **Step 4: Message.tsx —— 拆分 pasted 与图片渲染**

在 `Message.tsx`：

4a. 顶部 import 补 `TextLightbox` 与 `pastedLineCount`：

```ts
import { TextLightbox } from './TextLightbox.js'
```

在从 `@zuse/core` 导入的行补 `pastedLineCount`（若 Message.tsx 尚未从 core 导入，则新增 `import { pastedLineCount } from '@zuse/core'`）。

4b. 把 user 分支的 attachments 渲染（第 82-86 行）按 route 分流：

```tsx
          {msg.attachments?.length ? (
            <div className="msg-imgs">
              {msg.attachments.map((a) => (
                a.route === 'pasted'
                  ? <PastedTextChip key={a.id} a={a} />
                  : <MessageImage key={a.id} a={a} />
              ))}
            </div>
          ) : null}
```

4c. 在 `MessageImage` 函数（第 130 行）之后新增 `PastedTextChip`：

```tsx
/** One pasted-text attachment: a folded card (📄 Pasted text #N (+M 行)) that opens the full text in
 *  a TextLightbox on click. Full text comes from the persisted attachment.text, so it renders the same
 *  live and after reload. */
function PastedTextChip({ a }: { a: MessageAttachment }) {
  const [open, setOpen] = useState(false)
  const m = pastedLineCount(a.text ?? '')
  const label = m === 0 ? a.name : `${a.name} (+${m} 行)`
  return (
    <div className="paste-card">
      <button type="button" className="paste-card-btn" onClick={() => setOpen(true)} aria-label={`查看 ${a.name}`}>
        <span className="paste-card-icon" aria-hidden="true">📄</span>
        <span className="paste-card-label">{label}</span>
      </button>
      {open ? <TextLightbox text={a.text ?? ''} title={a.name} onClose={() => setOpen(false)} /> : null}
    </div>
  )
}
```

> `useState` 已在 Message.tsx 顶部 import（`MessageImage` 用了 `zoom` 状态）；`MessageAttachment` 类型亦已在文件内使用。

- [ ] **Step 5: 样式（`styles.css`）**

在 TextLightbox 相关样式区（`.lightbox-close` 之后，约第 133 行后）加：

```css
.textbox-panel { max-width: 90vw; max-height: 90vh; display: flex; flex-direction: column; background: var(--surface, #1e1e1e); border-radius: 8px; box-shadow: 0 12px 48px rgba(0,0,0,0.5); cursor: default; overflow: hidden; }
.textbox-title { padding: 10px 14px; font-size: 13px; border-bottom: 1px solid var(--line); color: var(--fg); }
.textbox-pre { margin: 0; padding: 14px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; line-height: 1.5; color: var(--fg); }
```

并给气泡内卡片按钮补样式（`.paste-card` 已在 Task 6 定义；此处加按钮内联形态）：

```css
.paste-card-btn { display: flex; align-items: center; gap: 6px; background: none; border: none; padding: 0; cursor: pointer; color: inherit; overflow: hidden; }
```

- [ ] **Step 6: 跑测试确认通过 + typecheck**

Run: `pnpm --filter @zuse/web test ; pnpm --filter @zuse/web exec tsc --noEmit`
Expected: 全绿；typecheck 无输出。

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/components/TextLightbox.tsx packages/web/src/components/Message.tsx packages/web/src/styles.css packages/web/src/components/Message.test.tsx
git commit -m "feat(web): render pasted-text attachment as card + TextLightbox (I5a)"
```

---

### Task 8: Playwright 端到端冒烟

**Files:**
- （无源码改动；操作运行中的 UI，验证整链路）

- [ ] **Step 1: 重建 web + 重启 daemon**

```bash
pnpm --filter @zuse/web build
```

然后重启 daemon（core/server 从源码经 tsx 加载，本批改了 server/core，必须重启才生效）：找到监听 127.0.0.1:4180 的进程 PID 并结束，重新在后台起 `pnpm exec tsx packages/server/src/bin.ts`（带 `$env:ZUSE_WEBDIR` 指向 web dist）。

- [ ] **Step 2: 驱动 UI 验证（Playwright MCP）**

- 打开页面、必要时登录。
- 在输入框粘贴一大段多行文本（>2 换行或 >800 字符）——用 `browser_evaluate` 触发 textarea 的 paste 事件并带 clipboardData，或用 `browser_fill_form` 无法模拟粘贴时，改用 `browser_evaluate` 派发一个带 `clipboardData` 的 `ClipboardEvent`。
- 断言：出现 `📄 Pasted text #1 (+M 行)` 卡片，且 textarea 值为空。
- 输入一句问题，回车发送。
- 断言：用户气泡里出现折叠的 `📄 Pasted text #1` 卡片（用 `browser_evaluate` 查 DOM），且**不是** 5000 行铺开。
- 点击卡片 → 断言出现 `.textbox-panel` 且含粘贴全文。
- 刷新页面（`browser_navigate` 重新加载 session）→ 断言历史里该用户气泡仍是同款折叠卡片、可再次点开看全文。
- 截图存证。

- [ ] **Step 3: 记录结果**

把上述断言的实际结果（含关键 `browser_evaluate` 探针输出）如实记录。任一失败 = 红门，停下修复，不得合并。

---

## Self-Review

**1. Spec coverage（逐节核对）：**
- 触发规则（>800 或 >2 换行、`\r`→`\n` 规范化）→ Task 6 Step 3d ✓
- 行数 helper `pastedLineCount` → Task 2 ✓
- 数据模型（MessageAttachment route:'pasted' + text、send.pastedTexts、PastedTextInput）→ Task 1 + Task 2 ✓
- 发送物化（'pasted' 分支、单/多编号、材料在前、块顺序、空跳过）→ Task 3 ✓
- 后端会话（submit 第三参、build attachments、clientMessage 透传、failover/retry 按 route）→ Task 4 ✓
- 前端 Composer（onPaste 文本分支、卡片托盘、canSend/submit/clear）→ Task 5 + Task 6 ✓
- 前端 Message（PastedTextChip、TextLightbox、点击看全文）→ Task 7 ✓
- 刷新/重载一致渲染 → Task 4（投影透传）+ Task 7（从 attachment.text 渲染）+ Task 8（Playwright 验证）✓
- YAGNI（不配置阈值、不排序、不落盘、不做内联占位符）→ 计划未引入这些 ✓

**2. Placeholder scan：** 无 TBD/TODO；每个改动步骤都给了完整代码与确切行号锚点。测试步骤均含实际断言代码。

**3. Type consistency：**
- `MessageAttachment`：protocol（Task 1）与 core（Task 2）字段一致：`route?: 'direct'|'parsed'|'pasted'`、`text?: string`。
- `PastedTextInput { id, text }`：protocol 定义（Task 1）、server submit 参（Task 4）、web onSend/Shell（Task 5）、Composer submit（Task 6）一致。
- `submit(text, images?, pastedTexts?, opts?)`：Task 4 定义，clientMessage（Task 4 Step 5）、内部 resend/retry（Task 4 Step 3d/4）调用一致。
- pasted attachment 形状 `{ id, name:'Pasted text #N', mediaType:'text/plain', route:'pasted', text }`：server（Task 4）与 web 乐观 dispatch（Task 5）一致。
- `pastedLineCount`：core 定义（Task 2），Composer（Task 6）与 Message（Task 7）共用，"+M 行" 口径统一。

自检未发现缺口。
