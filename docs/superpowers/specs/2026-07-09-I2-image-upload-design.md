# I2 图片上传（混合：直传优先 + 解析兜底）设计

> 状态：设计待评审 · 2026-07-09 · 前置侦察(CC/OpenCode 均纯直传，无解析模型；本 spec 的接缝已对 zuse 实际源码核实)
> 关联：Web UI roadmap `docs/superpowers/specs/2026-06-22-web-ui-roadmap.md` 的 I2
> 取代：本文件早前的"图转文字单一方案"稿（因细节提问保真天花板问题，改为混合）

## 1. 目标与一句话架构

Web 输入框支持**粘贴 / 拖拽 / 回形针**上传图片。发送时按主模型能力**自动分流**：

- **主模型支持视觉**（Opus 4.8 / GPT-4o / qwen-vl…）→ 图片以原生 `image` 块**直传主模型**（对齐 CC/OpenCode 的做法），主模型亲自看图，**保真最高、无转述天花板**。
- **主模型不支持视觉**（kimi 等）→ 回退：把图片 + **用户当前问题**一起交给独立配置的 `imageModel`（视觉模型），拿到**针对性文字**注入主模型。次一等，但让非视觉模型也能沾图。
- **两者都不满足**（无视觉主模型且未配 imageModel）→ 明确报错，拒绝发送。

图片本体存盘 `~/.zuse/uploads/`，**会话账本只存引用**（不存 base64，JSON 不膨胀）；base64 只在**发送瞬间**从盘读回内联给模型。气泡显示缩略图（走 HTTP 端点），并标注该图走了**直传**还是**解析**。

## 2. 已锁定决策

| 维度 | 决定 |
|------|------|
| 架构 | **混合**：视觉主模型直传 + 非视觉回退带问题解析 |
| 存储 | 存盘 `~/.zuse/uploads/` + 账本只存引用 id；base64 发送时才内联 |
| 入口 | 粘贴 Ctrl+V / 拖拽 / 回形针选文件 |
| 客户端处理 | 上传前**压缩+限尺寸**（照 CC：长边 ≤ 1568、逐级降质），把每图摁在 ~1.6k 视觉 token |
| imageModel | 全局 `settings.imageModel`（照 `smallModel` 范式）——**仅用于回退路径** |
| 视觉能力判定 | provider/模型配置里声明 `vision`（照 `contextWindow` 三级解析），决定分流 |
| 解析时机 | 回退路径在**发送时**带着用户问题解析（不是上传时通用解析；保真更高） |
| 限制 | 单张 ≤ 25 MiB（压缩后更小）、每条 ≤ 10 张 |
| 透明度 | 气泡按图标 `图·直传` / `图·解析` 徽章；解析路径可展开看"模型看到的描述" |
| 失败/未配置 | 非视觉主模型 + 未配 imageModel → 报"当前模型不支持图片，且未配置图片解析模型"，拒发 |

## 3. 视觉能力判定（分流依据）——照抄 contextWindow 范式

现有 `ModelEntryObject`（`core/src/types.ts:99-103`）与 provider 级已有 `contextWindow` 的"模型级条目 → provider 级 → 默认"解析（`compaction.ts:37-48` `resolveContextWindow`）。视觉能力照抄：

- `ModelEntryObject` 加 `vision?: boolean`；`RawProviderConfig` 加 `vision?: boolean`（provider 级回退）。
- `settings.ts`（或 compaction 同款位置）加 `resolveVision(settings, providerId, model): boolean`：模型级条目 `vision` → provider 级 `vision` → 默认 `false`。
- **默认 false = 安全**：未声明的模型走回退/报错，不会把图硬塞给可能不支持的模型而报 API 错。
- 文档/示例 settings 里给 Anthropic、qwen-vl 等标 `vision: true`。

## 4. 核心多模态管线（直传路径要动的部分）

这是"图转文字"当初想绕开、现在为保真绕不开的部分。**关键设计：账本里永远不放 base64**——`image` 块只在发送前的临时请求副本里短暂存在。

### 4.1 `ContentBlock` 加 image 变体（`core/src/types.ts:2-7`）
```ts
| { type: 'image'; source: { type: 'base64'; mediaType: string; data: string } }
```
- 仅出现在**发送前临时展开的请求消息**里；账本/持久化的 `Message` 绝不含它（见 §4.3）。

### 4.2 两个 client 映射
- `anthropic-client.ts:24-38`：image 块 → `{ type:'image', source:{ type:'base64', media_type, data } }`（SDK 原生）。
- `openai-client.ts:13-55`：当某条消息含 image 块时，`content` 输出**数组**（`[{type:'image_url', image_url:{url:'data:<mime>;base64,<data>'}}, {type:'text', text}]`）而非拍平字符串；纯文本消息保持现状。
- 两处都是 exhaustive 映射，加变体后编译器会强制补分支（安全）。

### 4.3 `Message` 加 attachments（账本/持久化的引用载体）（`core/src/types.ts:15`）
```ts
attachments?: { id: string; name: string; mediaType: string }[]
```
- **回合循环与两个 client 只读 `content`，忽略 `attachments`**；它随账本进持久化（`SessionRecord.messages`）与投影。
- 这是让缩略图在刷新/revert 后仍在、且账本不膨胀的关键：账本存引用，不存 base64。

### 4.4 runAgent 发送前展开（`agent.ts`）
- `runAgent` 新增可选入参：`userAttachments?`（当前回合用户图，进 staged user 消息的 `attachments`）+ config 里注入 `expandAttachments?: (messages: Message[]) => Promise<Message[]>` 钩子。
- 每次 `client.sendMessages` **之前**调用 `expandAttachments`（若提供）：把每条消息的 `attachments` 读盘→base64→在该条 `content` 前插入 image 块，产出**请求专用副本**；账本本身不变。
- 未提供钩子（如 TUI）或读盘失败 → 忽略该图，纯文本照发（优雅降级）。
- 服务端提供该钩子（它知道 uploads 目录）；**core 不认识 `~/.zuse/uploads`，只调注入的函数**——保持解耦。
- 分流：视觉主模型才注入 `expandAttachments`；非视觉主模型不注入（走 §6 回退，描述已烘焙进文本）。

## 5. 服务端：存储 + 端点 + 客户端压缩

### 5.1 UploadService（新增 `packages/server/src/upload/UploadService.ts`）
- 目录 `~/.zuse/uploads`（`join(cfg.authDir, 'uploads')`，首用 `mkdir -p`）。
- `save(bytes, mediaType): { id }`：白名单 mime（png/jpeg/gif/webp）、大小 ≤ 25 MiB；id=`randomUUID()`；落盘 `<id><ext>`（**只用生成 id 做路径，绝不用用户文件名**，防穿越）。
- `load(id): { abs, size, mediaType }`：仿 `FileService.statFile`，root 锁定 uploads；id 必须匹配 uuid 形，拒绝任何分隔符。
- `readBase64(id): { data, mediaType }`：供 §4.4 展开钩子与 §6 回退读回字节。

### 5.2 端点（`http/server.ts`，鉴权门禁）
- **`POST /api/uploads`**：JSON `{ mediaType, dataBase64, name }`（复用 `readJsonBody`；localhost 单用户，base64-in-JSON 够用，不引 multipart）→ `save` → `200 { id, name, mediaType }`。**上传不再触发解析**（解析改到发送时按分流决定）。错误：非图片 415/400、超限 413。
- **`GET /api/uploads/<id>`**：stream 原图（仿 `/api/files/raw`：设 content-type/length，`createReadStream(...).on('error', ()=>res.destroy())` **务必保留 error 监听**）。供气泡 `<img>`。id 严格校验。

### 5.3 客户端压缩（照 CC，`web` 侧）
- 上传前用 canvas 把长边 > 1568 的图等比缩小、导出 JPEG/WebP（质量阶梯），把视觉 token 摁在 ~1.6k、请求不过大。透明 PNG 保 PNG。原图不动、只上传压缩版（本期不留原图；follow-up 可选留原图供下载）。

## 6. 回退路径：带问题解析（非视觉主模型）

- imageModel 构造：照 `smallModel` 范式——`settings.imageModel` + `resolveImageModelSelection`（复刻 `resolveSmallModelSelection`），在 **startServer 层建一次** `imageClient`（try/catch 软降级），注入 SessionManager。
- `SessionManager.submit(text, images?, opts?)`（启用 `SessionManager.ts:712` 闲置的 `_parts`）：主模型**非视觉**且有图时——
  1. 对每张图：`imageClient.sendMessages([{role:'user', content:[ imageBlock(base64 from uploads), textBlock(解析提示 + 用户问题 text) ]}], {model: imageModel, max_tokens})` → 收流拼 `description`。**把用户问题一起给视觉模型**，针对性回答。
  2. 把描述**烘焙进发给主模型的 user 文本**（`text + '\n\n<uploaded-images>\n1. {name}：{description}\n…\n</uploaded-images>'`）——必须入账本，否则多轮重发历史时主模型"忘图"。
  3. 记 `attachments`（含 `description` 供展开显示）。
- 复用 §4 的 image 块 + sendMessages，**不需要**单独的 `describeImage` 方法（一次性视觉调用 = 用 imageClient 发一条含 image 块的消息）。
- 投影（`projectMessages`）把 `<uploaded-images>…</uploaded-images>` 从**主显示文本**剥离（类 `stripUserStamp`），只在"展开描述"里显示。

## 7. 协议 + 前端

### 7.1 protocol（`packages/protocol/src/index.ts`）
- `ClientMessage.send` 加 `images?: { id; name; mediaType }[]`（`steer` 本期仍纯文本）。
- `SnapshotMessage` 加 `attachments?: { id; name; mediaType; route?: 'direct'|'parsed'; description?: string }[]`（route/description 供徽章与展开；description 仅解析路径有）。
- 新增 `UploadedImageRef` 等公共类型。

### 7.2 web
- `manageApi`：`uploadImage(file): Promise<{id,name,mediaType}>`（客户端压缩 → base64 → `POST /api/uploads`）、`uploadedImageUrl(id)`。
- `Composer.tsx`：`onPaste`/`onDrop`+`onDragOver`/回形针 `<input type=file accept=image/*>`；待发附件区显示**缩略图 + 删除**（无描述预览——描述改到发送时才生成）；数量/大小前端先拦截；发送 `onSend(text, images)` 后清空；thinking 态 steer 禁附件并提示；首图收到 `image_model_unconfigured` 且主模型非视觉 → 提示并禁用入口。
- `Shell.tsx`：`send({type:'send', text, images})`；乐观渲染带 attachments。
- `Message.tsx` + web 类型：user 气泡渲染 attachments 缩略图 + `route` 徽章（`图·直传`/`图·解析`）；解析路径可折叠展开 `description`。reducer 把 `SnapshotMessage.attachments` 带进 web 模型。
- ws 上行（`ws/clientMessage.ts:35`）：`mgr.submit(msg.text, msg.images)`。

## 8. 持久化

- `SessionRecord.messages` = core `Message[]`，因 §4.3 天然带 `attachments`（引用），**不含 base64，JSON 不膨胀**。回退路径的描述在文本里（已烘焙）。刷新/重连/revert 后缩略图与徽章都在。

## 9. 不改动

- 主回合 `sendMessages` 的调用结构、`runAgent` 主循环骨架（仅加展开钩子 + userAttachments 入参）。
- 账本/压缩/revert/检查点：`attachments` 是被忽略的旁字段、描述是普通文本，全部免费兼容。
- OpenAI/Anthropic 纯文本消息映射（仅新增 image 分支）。

## 10. 测试

- **core**：`resolveVision`（模型级/provider级/默认）；`resolveImageModelSelection`；两个 client 的 image 块映射（mock SDK 断言形态；OpenAI 含图转数组 content、纯文本仍字符串）；`Message.attachments` 不影响映射；`runAgent` 的 `expandAttachments` 钩子（提供→插入 image 块、缺省→忽略、失败→降级）。
- **server**：`UploadService`（存/读/id 防穿越/大小类型校验）；`POST /api/uploads`、`GET /api/uploads/<id>`（stream + error 监听 + 非法 id 拒绝）；`SessionManager.submit`：视觉主模型→attachments 记录 + expandAttachments 被调、无烘焙；非视觉→imageClient 被调 + 描述烘焙 + attachments.route='parsed'；未配置→报错拒发；`projectMessages` 剥 `<uploaded-images>` + 带出 attachments/route/description。
- **web**：Composer 粘贴/拖拽/选文件→压缩→上传（mock）→待发区、超限/超量拦截、发送带 images 清空；Message 渲染缩略图 + 徽章 + 展开描述；未配置禁用入口。
- **Playwright 冒烟**：配一个视觉模型→上传→直传→气泡缩略图 + `图·直传` 徽章→刷新仍在；（可选）配 imageModel + 非视觉主模型→`图·解析` + 展开描述。环境无 key 则以 mock/说明跳过真实模型调用。

## 11. 分期与开放项

- 本期：§3–§8 全链路（直传 + 回退 + 压缩 + 徽章）。
- follow-up（记 roadmap）：uploads 清理/TTL、删会话联动删图、留原图供下载、steer 带图、prompt caching 优化图片重发成本、PDF/文档直传（`document` 块，仿 CC）。

## 附：touch 清单

**改**：`core/src/types.ts`（ContentBlock image、Message.attachments、ModelEntryObject.vision、RawProviderConfig.vision、ResolvedSettings.imageModel）、`core/src/settings.ts`（RawSettings.imageModel、resolveImageModelSelection、resolveVision 或置于 compaction 同款）、`core/src/anthropic-client.ts`、`core/src/openai-client.ts`（image 映射）、`core/src/agent.ts`（expandAttachments 钩子 + userAttachments）、`packages/protocol/src/index.ts`（send.images、SnapshotMessage.attachments、公共类型）、`server/src/startServer.ts`（建 imageClient + UploadService 注入 + 传 expandAttachments 钩子）、`server/src/upload/UploadService.ts`（新）、`server/src/http/server.ts`（两端点 + deps）、`server/src/session/SessionManager.ts`（submit 分流 + 回退解析 + 烘焙 + attachments + projectMessages 剥离 + 视觉判定接线）、`server/src/session/createSession.ts`（透传 expandAttachments/imageClient 到 runAgent/SessionManager）、`server/src/ws/clientMessage.ts`（透传 images）、`web/src/state/manageApi.ts`、`web/src/components/Composer.tsx`、`web/src/components/Shell.tsx`、`web/src/components/Message.tsx`、`web/src/state/*`（reducer/types 带 attachments）。

**不改**：`agent.ts` 主循环骨架（仅加钩子）、`sendMessages` 结构、快照 `SnapshotPart`、`sessionStore` 记录结构（除 Message 多 attachments 旁字段）。
