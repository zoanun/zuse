# I2 图片上传（混合：直传优先 + 解析兜底）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development（本仓默认）。按 checkbox 逐步。
> 用户偏好：subagent 驱动，**按阶段边界(protocol/core/server/web)停下 review**。

**Goal:** Web 输入框上传图片；视觉主模型直传原生 image 块、非视觉主模型回退到 imageModel 带问题解析；图片存盘、账本只存引用、气泡缩略图 + 路径徽章。

**Architecture:** 见 spec `docs/superpowers/specs/2026-07-09-I2-image-upload-design.md`。关键约束：**账本/持久化的 `Message` 只存 `attachments` 引用，绝不含 base64**；`image` 块只在发送前临时展开的请求副本里出现（`agent.ts` 的 `expandAttachments` 钩子，服务端注入，core 不碰 uploads 目录）。

**Tech Stack:** TS monorepo；vitest；web=React19+Vite；server=node:http；core=引擎（provider 协议 anthropic/openai）。

**测试命令：** core/server 用根 `pnpm exec vitest run <path>`；web 用 `pnpm --filter @zuse/web test` 或 `pnpm -F @zuse/web exec vitest run <file>`。typecheck：`pnpm --filter @zuse/<pkg> typecheck`（server 包名 `@zouyj/zuse-server`）。

---

## 阶段 A — protocol（契约先行）

### Task 1: protocol 图片类型与线缆字段

**Files:** Modify `packages/protocol/src/index.ts`

- [ ] **Step 1: 加公共类型 + 扩展 send / SnapshotMessage**

```ts
/** 一次上传后的图片引用（客户端持有、随 send 上行）。 */
export interface UploadedImageRef {
  id: string
  name: string
  mediaType: string
}

/** 附着在一条消息上的图片（快照投影用；不含 base64）。 */
export interface MessageAttachment {
  id: string
  name: string
  mediaType: string
  /** 该图走了哪条路：直传主模型 / 经解析模型转述。 */
  route?: 'direct' | 'parsed'
  /** 解析路径下模型看到的文字描述（供气泡折叠展示）；直传路径无。 */
  description?: string
}
```

- `ClientMessage` 的 `send` 变体：`{ type: 'send'; text: string; images?: UploadedImageRef[] }`。
- `SnapshotMessage`（`index.ts:20-29`）加 `attachments?: MessageAttachment[]`。

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @zuse/protocol typecheck` → 期望干净。

- [ ] **Step 3: commit** `feat(protocol): image upload refs + message attachments (I2)`

> **阶段 A 结束 → 停下 review。**

---

## 阶段 B — core（多模态管线 + 设置解析）

### Task 2: ContentBlock image 变体 + Message.attachments + 设置字段

**Files:** Modify `packages/core/src/types.ts`, `packages/core/src/settings.ts`

- [ ] **Step 1: types.ts 加变体与字段**

`ContentBlock`（`types.ts:2-7`）加：
```ts
| { type: 'image'; source: { type: 'base64'; mediaType: string; data: string } }
```
`Message`（`types.ts:15`）加可选：`attachments?: MessageAttachment[]`（从 `@zuse/protocol` import type，或在 core 定义同形；本仓 core 不依赖 protocol，故在 core 定义等价 `MessageAttachment` 并在 protocol 侧保持结构一致——**注意二者字段必须对齐**）。
`ModelEntryObject`（`types.ts:99-103`）加 `vision?: boolean`。
`RawProviderConfig`（`types.ts:109-119`）加 `vision?: boolean`。
`ResolvedSettings`（`types.ts:162+`）加 `imageModel?: string`（注释：`<providerId>/<model>`，仅回退路径用）。

- [ ] **Step 2: settings.ts 原始层 + 合并透传**

`RawSettings` 加 `imageModel?: string`（`settings.ts:89` 邻近）；三层合并里像 `smallModel` 一样 passthrough（`settings.ts:158` 邻近）。

- [ ] **Step 3: typecheck（预期两个 client 的 exhaustive 映射会报未处理 image 分支——这是下一 task 的信号，本 task 只需 types.ts/settings.ts 自身编译逻辑正确）**

Run: `pnpm --filter @zuse/core typecheck` → 记录报错点（应仅在 anthropic-client/openai-client 的 map 缺 image 分支）。

- [ ] **Step 4: commit** `feat(core): image ContentBlock, Message.attachments, imageModel+vision settings (I2)`

### Task 3: resolveVision + resolveImageModelSelection（TDD）

**Files:** Modify `packages/core/src/settings.ts`（或 `compaction.ts` 同款位置放 resolveVision，与 resolveContextWindow 并列）, Test `packages/core/src/settings.test.ts`（或对应）

- [ ] **Step 1: 写失败测试**

```ts
// resolveImageModelSelection：配/不配/带斜杠模型名
expect(resolveImageModelSelection({ ...base, imageModel: 'anthropic/claude-opus-4-8' }))
  .toEqual({ providerId: 'anthropic', model: 'claude-opus-4-8' })
expect(resolveImageModelSelection({ ...base })).toBeNull()
expect(resolveImageModelSelection({ ...base, imageModel: 'bare-model' }))
  .toEqual({ providerId: DEFAULT_PROVIDER_ID, model: 'bare-model' })

// resolveVision：模型级 > provider 级 > 默认 false
const s = settings({ p: { vision: false, models: [{ name: 'm', vision: true }, 'n'] } })
expect(resolveVision(s, 'p', 'm')).toBe(true)   // 模型级覆盖
expect(resolveVision(s, 'p', 'n')).toBe(false)  // 回退 provider 级
expect(resolveVision(settings({ p: { vision: true, models: ['n'] } }), 'p', 'n')).toBe(true)
expect(resolveVision(base, 'unknown', 'x')).toBe(false) // 默认
```

- [ ] **Step 2: 跑测试确认失败** — `pnpm exec vitest run packages/core/src/settings.test.ts`

- [ ] **Step 3: 实现**

`resolveImageModelSelection` 复刻 `resolveSmallModelSelection`（`settings.ts:311-316`），只把 `smallModel` 换 `imageModel`。
`resolveVision` 复刻 `resolveContextWindow`（`compaction.ts:37-48`）结构：遍历该 provider 的 models 找对象条目 `entry.name===model && entry.vision!==undefined` → 用之；否则 provider 级 `vision`；否则 `false`。

- [ ] **Step 4: 跑测试确认通过；typecheck**

- [ ] **Step 5: commit** `feat(core): resolveVision + resolveImageModelSelection (I2)`

### Task 4: anthropic-client image 映射（TDD）

**Files:** Modify `packages/core/src/anthropic-client.ts`, Test `packages/core/src/anthropic-client.test.ts`

- [ ] **Step 1: 失败测试** — 构造含 image 块的 Message，断言 `buildAnthropicRequest` 产出 `{type:'image', source:{type:'base64', media_type, data}}`（注意 SDK 是 `media_type` 下划线，内部是 `mediaType`）。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现** — 在 `anthropic-client.ts:24-38` 的 map 链加分支：
```ts
if (block.type === 'image')
  return { type: 'image', source: { type: 'base64', media_type: block.source.mediaType as ..., data: block.source.data } }
```

- [ ] **Step 4: 测试通过 + typecheck**

- [ ] **Step 5: commit** `feat(core): anthropic image block mapping (I2)`

### Task 5: openai-client image 映射（TDD）

**Files:** Modify `packages/core/src/openai-client.ts`, Test `packages/core/src/openai-client.test.ts`

- [ ] **Step 1: 失败测试** — 一条含 image + text 的 user 消息 → `content` 为数组 `[{type:'image_url', image_url:{url:'data:<mime>;base64,<data>'}}, {type:'text', text}]`；纯文本消息仍输出字符串（回归断言）。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现** — `toOpenAIMessages`（`openai-client.ts:13-55`）：当某消息 content 含 image 块时输出数组形态（image_url + text 段），否则维持现有 `.filter(text).join('')` 字符串路径。

- [ ] **Step 4: 测试通过 + typecheck**

- [ ] **Step 5: commit** `feat(core): openai image_url mapping (array content) (I2)`

### Task 6: agent.ts expandAttachments 钩子 + userAttachments（TDD）

**Files:** Modify `packages/core/src/agent.ts`, Test `packages/core/src/agent.test.ts`

- [ ] **Step 1: 失败测试**

- 提供 `expandAttachments`：一条带 `attachments:[{id:'a',...}]` 的 user 消息，钩子把它变成 content 前插 `{type:'image',...}` 的副本；断言传给 `client.sendMessages` 的消息含 image 块，且**原 conversation 未被 mutate**（账本不变）。
- 缺省钩子：带 attachments 的消息照发、无 image 块、不报错。
- `userAttachments` 入参：runAgent 收到后 staged user 消息带上该 attachments。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

- `RunAgentParams`（`agent.ts:70+`）加 `userAttachments?: MessageAttachment[]`；staged user 消息（`agent.ts:159`）带 `attachments: userAttachments`。
- config 或 params 加 `expandAttachments?: (messages: Message[]) => Promise<Message[]>`。每次 `client.sendMessages(...)` 前：`const outbound = expandAttachments ? await expandAttachments(messages) : messages`，发 `outbound`。**不可 mutate 原数组**（返回新副本）。
- 找到 agent.ts 里所有调用 `sendMessages` 的点统一走 `outbound`。

- [ ] **Step 4: 测试通过 + typecheck + 跑全 core 测试确保无回归** — `pnpm exec vitest run packages/core`

- [ ] **Step 5: commit** `feat(core): runAgent expandAttachments hook + userAttachments (I2)`

> **阶段 B 结束 → 停下 review。**

---

## 阶段 C — server（存储 + 端点 + 分流）

### Task 7: UploadService（TDD）

**Files:** Create `packages/server/src/upload/UploadService.ts`, Test `packages/server/src/upload/UploadService.test.ts`

- [ ] **Step 1: 失败测试**

- `save(bytes, mediaType)` → 返回 `{id}`，落盘 `<uploadsDir>/<id><ext>`；`load(id)` 返回 `{abs,size,mediaType}`；`readBase64(id)` 返回 `{data,mediaType}` 且 data 是该文件 base64。
- 非图片 mediaType → 抛 `UnsupportedMediaError`。
- 超 25 MiB → 抛 `TooLargeError`。
- `load`/`readBase64` 传含分隔符或 `..` 的 id → 抛（防穿越）。
- 用临时目录做 uploadsDir（`mkdtemp`）。

- [ ] **Step 2: 跑测试确认失败** — `pnpm exec vitest run packages/server/src/upload/UploadService.test.ts`

- [ ] **Step 3: 实现**

- 构造 `new UploadService(uploadsDir)`；首用 `mkdir(dir,{recursive:true})`。
- mime→ext 表（png/jpeg/jpg/gif/webp）；`save`：校验白名单 + 大小 → `id=randomUUID()` → `writeFile(join(dir, id+ext), bytes)`。
- id 校验正则 `^[0-9a-f-]{36}$`（randomUUID 形），不匹配即抛。`load` 用该 id 直接拼路径（不接受用户名）。
- MIME 由存盘 ext 反推（存的就是白名单，稳定）。
- 错误类 `UnsupportedMediaError`/`TooLargeError`（导出，供 http 层映射状态码）。

- [ ] **Step 4: 测试通过 + typecheck**

- [ ] **Step 5: commit** `feat(server): UploadService (store/load/base64, id-safe) (I2)`

### Task 8: 上传/读取端点（TDD）

**Files:** Modify `packages/server/src/http/server.ts`, Test `packages/server/src/http/server.test.ts`

- [ ] **Step 1: 失败测试**（照现有 server.test 里 files 路由的写法，带鉴权 cookie）

- `POST /api/uploads` JSON `{mediaType:'image/png', dataBase64, name}` → 200 `{id,name,mediaType}`；未鉴权 401；非图片 415/400；超限 413。
- `GET /api/uploads/<id>` → 200 + content-type + 图片字节；非法 id → 400/404。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

- deps 加 `upload: UploadService`。
- `POST /api/uploads`：鉴权 → `readJsonBody` → `Buffer.from(dataBase64,'base64')` → `upload.save` → 200；catch 映射 `UnsupportedMediaError`→415、`TooLargeError`→413、余 400。
- `GET /api/uploads/<id>`（path 形如 `/api/uploads/<id>`，从 path 取 id）：鉴权 → `upload.load(id)` → stream（**照 `/api/files/raw` 保留 `stream.on('error',()=>res.destroy())`**）；非法 id → 400，ENOENT → 404。

- [ ] **Step 4: 测试通过 + typecheck**

- [ ] **Step 5: commit** `feat(server): POST/GET /api/uploads endpoints (I2)`

### Task 9: startServer 接线（imageClient + UploadService + expandAttachments 钩子）

**Files:** Modify `packages/server/src/startServer.ts`, `packages/server/src/session/createSession.ts`（透传）

- [ ] **Step 1: 实现（接线为主，编译 + 冒烟）**

- startServer：`const uploadsDir = join(cfg.authDir, 'uploads')`；`const upload = new UploadService(uploadsDir)`；传入 http deps。
- imageClient（软降级，照 titleClient `createSession.ts:75-87` 模式，但在 **startServer 层建一次**）：`resolveImageModelSelection(settings)` → try `createModelClient(getProviderConfig(...), sel.model)` → `imageClient`+`imageModel`；catch → warn + undefined。
- expandAttachments 钩子：`async (messages) => messages.map(m => m.attachments?.length ? {...m, content:[...await loadImageBlocks(m.attachments), ...m.content]} : m)`，其中 `loadImageBlocks` 用 `upload.readBase64(id)` 造 image 块；读失败的图跳过。把该钩子 + imageClient/imageModel 透传给 SessionManager（经 createSession opts）。

- [ ] **Step 2: typecheck server + 启动冒烟**（起 daemon 不崩）

- [ ] **Step 3: commit** `feat(server): wire UploadService, imageClient, expandAttachments (I2)`

### Task 10: SessionManager.submit 分流 + 回退解析 + 投影剥离（TDD）

**Files:** Modify `packages/server/src/session/SessionManager.ts`, Test `packages/server/src/session/SessionManager.test.ts`（或新增）

- [ ] **Step 1: 失败测试**（注入假 client：视觉/非视觉；假 imageClient；假 upload/readBase64）

- 视觉主模型 + 有图：user 账本消息带 `attachments`（route 未定或 'direct'）、**文本未烘焙描述**、runAgent 收到 userAttachments、expandAttachments 生效路径（可断言 attachments 存在即可）。
- 非视觉主模型 + 有图：`imageClient.sendMessages` 被调（含 image 块 + 用户问题）、描述**烘焙进主模型文本**（`<uploaded-images>`）、attachments.route='parsed'+description 记录。
- 非视觉 + 无 imageClient + 有图：抛/回 error（拒发），不进 runAgent。
- `projectMessages`：把 `<uploaded-images>…</uploaded-images>` 从显示文本剥离；attachments（含 route/description）带进 SnapshotMessage。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

- `submit(text, images?: UploadedImageRef[], opts?)`（启用 `_parts` 位，改名 `images`）。
- 分流：`const vision = resolveVision(settings, selection.providerId, selection.model)`（SessionManager 需能拿到当前 selection + settings；若没有则经构造注入）。
- 视觉：user 消息 `attachments = images.map(...)`（route:'direct'）；`runAgent({..., userAttachments})`；不烘焙。
- 非视觉：对每图 `imageClient.sendMessages([{role:'user',content:[imageBlock(await upload.readBase64), textBlock(IMAGE_PROMPT + '\n用户问题：'+text)]}], {model:imageModel,...})` 收流→description；烘焙进 text；attachments route:'parsed'+description。imageClient 缺失→error 帧、return。
- `projectMessages`（`SessionManager.ts:359-395`）：user 文本剥 `<uploaded-images>` 块；带出 `attachments`。
- `IMAGE_PROMPT` 常量：要求客观完整描述图片、结合用户问题作答。

- [ ] **Step 4: 测试通过 + typecheck + 全 server 测试无回归** — `pnpm exec vitest run packages/server`

- [ ] **Step 5: commit** `feat(server): submit image routing (direct vs parsed fallback) + projection (I2)`

### Task 11: ws 上行透传 images（TDD）

**Files:** Modify `packages/server/src/ws/clientMessage.ts`, Test 对应

- [ ] **Step 1: 失败测试** — `{type:'send', text, images}` → `mgr.submit(text, images)` 被以 images 调用。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现** — `case 'send'`（`clientMessage.ts:35`）：`mgr.submit(msg.text, msg.images)`。
- [ ] **Step 4: 测试通过 + typecheck**
- [ ] **Step 5: commit** `feat(server): ws send passes image refs to submit (I2)`

> **阶段 C 结束 → 停下 review（含起 daemon 手动冒烟一次上传/读取端点）。**

---

## 阶段 D — web（输入框 + 气泡）

### Task 12: manageApi 上传（客户端压缩）+ url（TDD 能测的部分）

**Files:** Modify `packages/web/src/state/manageApi.ts`, Test `packages/web/src/state/manageApi.test.ts`

- [ ] **Step 1: 失败测试** — `uploadedImageUrl(id)` === `/api/uploads/<id>`；`uploadImage`（mock fetch + mock canvas/compress）POST 到 `/api/uploads` 带 base64、返回 `{id,name,mediaType}`；`image_model_unconfigured`/错误抛出。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**
  - `compressImage(file): Promise<{blob, mediaType}>`：canvas 等比缩到长边 ≤1568，导出（透明→png，否则 jpeg 质量 0.85）。jsdom 下 canvas 不可用 → 该函数可从 manageApi 拆到一个可注入/可跳过的小模块，测试对 uploadImage 用 mock。
  - `uploadImage(file)`：compress → blob→base64 → `POST /api/uploads`（复用 `request()`）→ 返回 ref。
  - `uploadedImageUrl(id)` = `/api/uploads/` + encodeURIComponent(id)。
- [ ] **Step 4: 测试通过 + typecheck**
- [ ] **Step 5: commit** `feat(web): uploadImage (client compression) + url (I2)`

### Task 13: reducer/types attachments + Shell.onSend images（TDD）

**Files:** Modify `packages/web/src/state/types.ts`, `packages/web/src/state/reducer.ts`, `packages/web/src/components/Shell.tsx`, Test reducer 测试

- [ ] **Step 1: 失败测试** — web `Part`/消息模型带 `attachments`；reducer 从 `SnapshotMessage.attachments` 带入；`user-send` 乐观消息带 attachments。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现** — web 消息类型加 `attachments?`; reducer applySnapshot/user-send 带上；Shell.onSend 改签名 `(text, images?)` → `send({type:'send', text, images})` + dispatch user-send 带 attachments（由 images 映射）。
- [ ] **Step 4: 测试通过 + typecheck**
- [ ] **Step 5: commit** `feat(web): attachments in state + Shell.onSend images (I2)`

### Task 14: Composer 粘贴/拖拽/回形针 + 待发区（TDD）

**Files:** Modify `packages/web/src/components/Composer.tsx`, Test `packages/web/src/components/Composer.test.tsx`, styles

- [ ] **Step 1: 失败测试** — 粘贴含图片 file 的 paste 事件 → 调 uploadImage（mock）→ 待发区出现缩略图；拖拽 drop 同理；回形针 input change 同理；超 10 张/超 25MiB 前端拦截提示；发送后 `onSend` 带 images 且待发区清空；thinking 态附件禁用。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现** — `onPaste`（`e.clipboardData.files/items` 取 image）、`onDrop`+`onDragOver`（`dataTransfer.files`）、回形针 `<input type=file accept="image/*" multiple>`；上传中/失败状态；待发区（缩略图+删除）；上限校验；`onSend(text, images)`；未配置错误提示并禁用。styles 加待发区样式。
- [ ] **Step 4: 测试通过 + typecheck + build**
- [ ] **Step 5: commit** `feat(web): Composer paste/drop/paperclip image upload (I2)`

### Task 15: Message 气泡缩略图 + 徽章 + 展开描述（TDD）

**Files:** Modify `packages/web/src/components/Message.tsx`, Test `packages/web/src/components/Message.test.tsx`, styles

- [ ] **Step 1: 失败测试** — user 消息带 attachments → 渲染 `<img src=uploadedImageUrl(id)>`；route='direct'→`图·直传` 徽章，'parsed'→`图·解析` 徽章 + 可展开 description；无 attachments 时不渲染。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现** — user 气泡渲染 attachments 缩略图网格 + 徽章 + 折叠描述（`<details>` 或受控展开）；点击缩略图新窗口看大图。styles。
- [ ] **Step 4: 测试通过 + typecheck + build**
- [ ] **Step 5: commit** `feat(web): message image thumbnails + route badge + description (I2)`

> **阶段 D 结束 → 停下。之后走 /ship（simplify→review→test→Playwright→commit→merge）。**

---

## 自查（写完计划对照 spec）

- spec §3 视觉判定 → T3；§4 多模态管线 → T2/T4/T5/T6；§5 存储端点压缩 → T7/T8/T12；§6 回退解析 → T9/T10；§7 协议前端 → T1/T13/T14/T15；§8 持久化 → T2（attachments 引用）天然覆盖。
- 类型一致性：`MessageAttachment`（protocol）与 core 的等价结构字段必须对齐（T1/T2 都定义，注意同步）；`UploadedImageRef` 贯穿 protocol→ws→submit→web。
- 无 base64 入账本：T2（Message 只加 attachments 引用）+ T6（image 块仅临时展开）双重保证。
