# V1 + V2 语音交互（STT 输入 / TTS 朗读）设计

> **日期**: 2026-07-29
> **性质**: 单个功能 spec（Web UI 路线图 §4.5 的 V1 + V2 合并）
> **依赖**: F3（协议/路由约定）✓、F4（React 前端）✓、A2（TLS —— `getUserMedia` 需 secure context）✓
> **合并理由**: V1/V2 共用同一套脚手架（`provider/model` 解析、OpenAI 兼容音频客户端、能力探测端点、Composer/Message 接线）。分两次做要把这套东西搭两遍。

---

## 1. 现状（已核实）

- 全仓**没有任何音频代码**（grep `MediaRecorder`/`audio`/`speech` 只命中 compaction 与 wsServer 的无关词）。
- 已有可直接镜像的模板：`resolveImageModelSelection`（`packages/core/src/settings.ts:332`）—— `settings.imageModel` 形如 `provider/model`，未配置返回 `null`，调用方据此禁用该能力。`smallModel`/`imageModel` 同款。
- **用户已配好可用的音频 provider**（`~/.zuse/settings.jsonc`，已核实）：
  - `siliconflow`（`protocol: openai`, `https://api.siliconflow.cn/v1`）—— 同一端点提供 OpenAI 兼容的 `/audio/transcriptions`（如 `FunAudioLLM/SenseVoiceSmall` 中文 ASR）
  - `siliconflow-tts` —— 已列 `FunAudioLLM/CosyVoice2-0.5B`、`IndexTeam/IndexTTS-2`、`fnlp/MOSS-TTSD-v0.5`
  - 佐证 `provider/model` 能吃下带斜杠的模型名：现役 `smallModel = siliconflow/Qwen/Qwen2.5-7B-Instruct`（按**第一个**斜杠切分）
- `openai` SDK 已在 `packages/core` deps（`^6.42.0`），`audio.transcriptions.create` / `audio.speech.create` 直接可用 → **零新依赖**。

## 2. 目标与非目标

**目标**
1. **V1**：在 Composer 里按住/点击麦克风录音 → 转写 → 文本**填进输入框**（不自动发送）。
2. **V2**：助手消息上一个 🔊 按钮 → 朗读该条回复；再点停止。
3. 两者都在**未配置对应模型时优雅隐藏**（不是报错），与 `imageModel` 同款。
4. 复用现有 provider/key 体系，零新依赖。

**非目标（明确不做，附理由）**
- **不做流式/实时 STT**（无中间结果、无 VAD、无打断）。那是另一个量级的工程（WS 二进制 + 端点检测 + 部分结果合并），而"录一段 → 转写 → 填进输入框"已覆盖主要用法。
- **不做转写后自动发送**。转写会出错，用户应当先看一眼再发；也避免误触发一整轮。
- **不做 TTS 自动朗读**。每条回复都念会很吵，且每次都要花钱/等待。显式按钮。
- **不做浏览器内置 `speechSynthesis` 兜底**。理由：Windows 中文内置音色明显差于 CosyVoice，两条质量差距悬殊的路径并存只会让人困惑"为什么今天声音不一样"；zuse 本来就是「先配 provider 才能用」的工具。未配置 → 隐藏按钮 + 文档教怎么配。
- **不做音色选择 UI**（配置项即可）、不做音频缓存、不做 TUI 支持（V1/V2 是 Web UI 路线图条目）。

## 3. 配置面

镜像 `imageModel`：

```jsonc
{
  "sttModel": "siliconflow/FunAudioLLM/SenseVoiceSmall",   // 语音输入（转写）
  "ttsModel": "siliconflow-tts/FunAudioLLM/CosyVoice2-0.5B", // 朗读
  "ttsVoice": "alloy"                                       // 可选；缺省用 DEFAULT_TTS_VOICE
}
```

- core 新增 `resolveSttModelSelection` / `resolveTtsModelSelection`（各 3 行，复用 `splitProviderModel`）+ `RawSettings`/`ResolvedSettings` 三个字段 + `mergeLayers` 透传。
- **只支持 `protocol: 'openai'` 的 provider**：音频端点是 OpenAI 形状；配了 anthropic 协议的 provider → 视为未配置并打一条 warn（Anthropic 没有对应端点，静默失败更糟）。

## 4. 服务端

### 4.1 `VoiceService`（新建 `packages/server/src/voice/VoiceService.ts`）

一个类同时承载 STT 与 TTS —— 两者共用「解析 provider → 建 OpenAI client」这段，拆两个类会重复。

```ts
export interface VoiceServiceDeps {
  /** 注入用:测试传假 client,离线不烧钱。缺省按 settings 现建。 */
  makeClient?: (baseURL: string, apiKey: string) => OpenAILike
  loadSettings?: () => ResolvedSettings
}

export class VoiceService {
  /** 两项能力各自是否可用(供前端决定按钮显隐)。 */
  capabilities(): { stt: boolean; tts: boolean }
  /** 音频字节 → 文本。未配置 → 抛 VoiceNotConfiguredError。 */
  transcribe(audio: Buffer, mimeType: string): Promise<string>
  /** 文本 → 音频字节 + content-type。未配置 → 抛 VoiceNotConfiguredError。 */
  speak(text: string): Promise<{ audio: Buffer; contentType: string }>
}
```

- `transcribe`：`toFile(audio, 'audio.<ext>', { type: mimeType })` → `audio.transcriptions.create({ file, model, response_format: 'text' })`。扩展名按 mimeType 映射（`audio/webm`→webm、`audio/mp4`→m4a、`audio/mpeg`→mp3、`audio/wav`→wav），未知 → 拒绝（415）而不是瞎猜。
- `speak`：`audio.speech.create({ model, voice, input, response_format: 'mp3' })` → `arrayBuffer()` → `Buffer`，contentType `audio/mpeg`。
- **文本上限 4096**（OpenAI 契约上限）：超出部分**截断**并在响应头 `X-Zuse-Tts-Truncated: 1` 标记，前端据此提示"仅朗读前 4096 字"。不静默截断、也不整个拒绝（把一条长回复的开头念出来仍有用）。
- 具名 `VoiceNotConfiguredError`（镜像 A2 的 `BuiltinSkillNotEditableError`）→ 路由映射 400/501，其余错误照常 5xx。

### 4.2 路由（`/api/voice*`，遵 §5.1 资源 API 约定，全部鉴权门禁）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/voice` | `{ stt: boolean, tts: boolean }` —— 前端据此显隐按钮 |
| POST | `/api/voice/stt` | body `{ audio: <base64>, mimeType: string }` → `{ text }` |
| POST | `/api/voice/tts` | body `{ text }` → 音频字节（`audio/mpeg`） |

- STT 走 **base64 JSON POST**，与既有 `/api/uploads`（图片）同款，直接复用 `readJsonBody` 的 body cap 机制。**音频上限 25 MiB**（对齐 whisper 家族的常见上限）→ 超限 413。
- **与路线图的偏离**：路线图 §4.5 写的是「WS 二进制帧传音频」。一次性转写本质是**请求/响应**，不是流；`/api/uploads` 已经确立了 base64-POST 的形状，复用它比新开一条二进制帧通道简单得多。WS 二进制真正需要的是**流式** STT —— 那已在非目标里。

## 5. 前端

### 5.1 能力探测
`useVoiceCaps()`：挂载时 `GET /api/voice`，缓存在 store（一次即可，配置改动需重启 daemon —— 与 MCP 同约束）。

### 5.2 V1 麦克风（Composer）
- 输入框左侧加 🎤 按钮，**仅当** `caps.stt && navigator.mediaDevices?.getUserMedia` 存在时渲染。
  - `getUserMedia` 在**非 secure context 下不存在**（局域网明文 http 访问时就是这样）→ 按钮自动消失。文档里指向 A2：走 TLS 或隧道即可恢复。
- 点击开始录音（按钮变红/脉冲 + 计时），再点停止 → `MediaRecorder` 产出 Blob → base64 → `POST /api/voice/stt` → 转写文本**插入输入框光标处**（不覆盖已有内容、不自动发送）。
- 录音中/转写中禁用发送；失败 → 输入框上方一行红字（复用既有 attachment error 样式），4 秒自动消失。
- 每次录音上限 **2 分钟**（前端硬停），避免误按后录出一个巨大文件撞 25 MiB。

### 5.3 V2 朗读（Message）
- 助手消息的操作行（已有"复制回复"/"分享"）加 🔊，**仅当** `caps.tts` 时渲染。
- 点击 → `POST /api/voice/tts` → `Blob` → `URL.createObjectURL` → `new Audio().play()`；按钮切换成 ⏹，再点停止并 `revokeObjectURL`。
- **同一时刻只播一条**：播新的先停旧的（store 里存 `speakingMessageId`）。
- 响应带 `X-Zuse-Tts-Truncated` → 提示"仅朗读前 4096 字"。

## 6. 分期

1. **core**：三个 settings 字段 + 两个 resolve 函数（+ 单测）。
2. **VoiceService**：capabilities / transcribe / speak + 具名错误（注入假 client 的单测，**不联网**）。
3. **路由**：`GET /api/voice`、`POST /api/voice/stt`、`POST /api/voice/tts` + 鉴权 + cap + 错误映射（+ 单测）。
4. **web**：`voiceApi` + 能力探测 + Composer 麦克风 + Message 朗读按钮（+ 单测）。
5. **文档**：`docs/voice.md` —— 怎么配 sttModel/ttsModel（给用户现有 siliconflow provider 的可照抄片段）、secure context 要求、非目标说明。
6. **/ship**（web 有改动 → Playwright）。

## 7. 测试策略

- **core**：`resolveSttModelSelection`/`resolveTtsModelSelection`：未配置 → null；`a/b` 与 `a/b/c`（带斜杠模型名）按第一个斜杠切分。
- **VoiceService**（注入假 client，全程离线）：capabilities 随配置变化；transcribe 传对 model/文件名/mime；未知 mime → 抛；未配置 → `VoiceNotConfiguredError`；anthropic 协议 provider → 视为未配置；speak 传对 model/voice/input；>4096 字截断并标记。
- **路由**：未登录 → 401；未配置 → 400/501（不是 500）；超 25 MiB → 413；happy path 回 `{text}` / 音频字节 + 正确 content-type。
- **web**：`caps.stt=false` 不渲染麦克风；`getUserMedia` 缺失（模拟非 secure context）不渲染麦克风；`caps.tts=false` 不渲染朗读；点击朗读发出 `/api/voice/tts` 请求并调 `Audio.play`（stub）；再点停止。
- **Playwright**：能覆盖的 = 按钮按配置显隐、点击朗读发出请求。**真实录音无法在无头环境可靠自动化**（需要伪造音频设备），这一段**据实说明为手工验证**，不假装自动化过了。

## 8. 已知取舍

- **不做浏览器 TTS 兜底** → 未配置 `ttsModel` 的人看不到朗读按钮。换来的是单一质量基线与单一代码路径。
- **一次性（非流式）STT** → 长录音要等全部转写完；但避免了流式的全部复杂度。
- **TTS 4096 字截断** → 超长回复只念开头。整条拒绝更差。
- ~~配置改动需重启 daemon~~ **更正（实现时核实）**：`loadSettings()` 无缓存、每次调用现读三层配置文件，而 `VoiceService` 在 `capabilities`/`transcribe`/`speak` 里都是现读 —— 所以**服务端不需要重启**。需要的是**刷新页面**：前端每次加载只探测一次 `GET /api/voice`。文档按此写。
- 音频经 base64 传输有 ~33% 体积膨胀；在 25 MiB 上限与本机/隧道场景下可接受，换来复用既有 body-cap 与鉴权路径。
