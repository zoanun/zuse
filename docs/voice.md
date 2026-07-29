# 语音：说话输入（STT）与朗读回复（TTS）

zuse 的 Web UI 有两个语音入口，都**默认关着**：

- **🎤 语音输入**：输入框左侧的麦克风。录一段 → 转写 → 文本**填进输入框光标处**（不自动发送）。
- **🔊 朗读**：助手回复下方操作行（挨着"复制回复"）。点一下念这条回复，再点停止。

两者都**只在配了对应模型时才出现**。没配 → 按钮根本不渲染，不是灰的、也不是点了报错 ——
和 `imageModel` 同款「没配就没有」。

---

## 配置

三个字段，放在 `~/.zuse/settings.jsonc` 顶层（与 `model` / `smallModel` 并列）：

```jsonc
{
  "sttModel": "siliconflow/FunAudioLLM/SenseVoiceSmall",      // 语音输入（转写）
  "ttsModel": "siliconflow-tts/FunAudioLLM/CosyVoice2-0.5B",  // 朗读
  "ttsVoice": "alloy"                                          // 可选；缺省 "alloy"
}
```

格式是 `provider/模型名`，**按第一个斜杠切分** —— 所以模型名自己带斜杠
（`FunAudioLLM/SenseVoiceSmall`）完全没问题，和现役的
`"smallModel": "siliconflow/Qwen/Qwen2.5-7B-Instruct"` 是同一套解析。

上面这段直接照抄就能用：它指向的两个 provider 你已经配好了 ——

```jsonc
"providers": {
  "siliconflow": {
    "protocol": "openai",
    "baseURL": "https://api.siliconflow.cn/v1",
    "apiKey": "sk-…"
  },
  "siliconflow-tts": {          // 同一个端点/key，单独一个 provider 只为把 TTS 模型归档
    "protocol": "openai",
    "baseURL": "https://api.siliconflow.cn/v1",
    "apiKey": "sk-…",
    "models": [
      { "name": "FunAudioLLM/CosyVoice2-0.5B", "type": "tts" },
      { "name": "IndexTeam/IndexTTS-2", "type": "tts" },
      { "name": "fnlp/MOSS-TTSD-v0.5", "type": "tts" }
    ]
  }
}
```

> **模型名不必出现在 provider 的 `models` 数组里。** 那个数组喂的是模型选择器；语音只用
> provider 的 `baseURL` + `apiKey`，模型名原样发给端点。所以 `sttModel` 填一个没列在
> `siliconflow.models` 里的 ASR 模型（如 `FunAudioLLM/SenseVoiceSmall`）是正常用法。

> ⚠️ **provider 必须是 `"protocol": "openai"`。** 音频走的是 OpenAI 形状的
> `/audio/transcriptions` 与 `/audio/speech`；Anthropic 协议没有对应端点。配成 anthropic 的
> provider 会被**当作未配置**处理（按钮消失），并在 daemon 日志里 warn 一条说明原因 ——
> 静默失败更难查。

### 音色（`ttsVoice`）

缺省是 OpenAI 的 `alloy`。**不同 provider 的音色命名不一样**：硅基流动的预置音色通常写成
`<模型名>:<音色>`（例如 `FunAudioLLM/CosyVoice2-0.5B:alex`），具体取值以其官方文档为准。
如果朗读报「音色不存在」之类的错，八成就是这一项没配对，而不是 zuse 的问题。

### 改完配置怎么生效

- **服务端不缓存**：每次调用都重读 settings 文件，所以 daemon 不用重启。
- **前端每次页面加载只探测一次能力**（`GET /api/voice`），所以改完配置要**刷新页面**，
  按钮才会出现/消失。
- 拿不准就"重启 daemon + 刷新页面"，一定对。

---

## 麦克风需要 secure context

🎤 依赖浏览器的 `navigator.mediaDevices.getUserMedia`，而它**只在 secure context 下存在**：

- `http://localhost` / `http://127.0.0.1` —— 算 secure context，**能用**。
- `http://192.168.x.x:4180`（手机、平板走局域网明文访问）—— **不算**，
  `navigator.mediaDevices` 直接是 `undefined`，麦克风按钮自动消失。

这不是 zuse 的限制，是浏览器的硬规矩。想在别的设备上用语音输入，就得让页面走 https：
见 [`docs/remote-access.md`](./remote-access.md) —— tailscale / Cloudflare 隧道（推荐，真证书、
零配置），或 `mkcert` 直连 TLS。上了 https，🎤 自己就回来了。

> 🔊 朗读**不受**这条限制：它只是播一段服务端返回的音频，明文 http 下照样能用。

---

## 用起来

**语音输入**：点 🎤 开始录（按钮变红 + 计时）→ 再点停止 → 转写完文本插到**当前光标处**
（有选区就替换选区），已经打的字不会被冲掉。录音中和转写中发送按钮是禁用的。
**单次录音上限 2 分钟**，到点自动停 —— 免得误按一次录出个几十兆的文件撞上传上限。

**朗读**：点 🔊 → 服务端合成 mp3 → 播放，按钮变成 ⏹；再点停止。
**同一时刻只播一条**，开新的会自动把上一条停掉。

**朗读上限 4096 字**（OpenAI `/audio/speech` 的契约上限）：超长回复会被**截断**，
只念开头，并在按钮旁提示"仅朗读前 4096 字"。不静默截断，也不整条拒绝 —— 念个开头仍然有用。

---

## 排错

| 现象 | 原因 |
|---|---|
| 两个按钮都不见 | 没配 `sttModel`/`ttsModel`，或 provider 不存在 / 缺 key / 不是 `openai` 协议。看 daemon 日志里的 `[voice]` warn |
| 只有 🔊 没有 🎤 | 多半是**非 secure context**（明文 http 的局域网地址）。见上一节 |
| 改了配置按钮没变 | 刷新页面（能力探测每页一次） |
| 转写返回 400 | 服务端认为「未配置」——`sttModel` 拼错或 provider 解析不到 |
| 转写返回 415 | 浏览器录出的容器格式不在白名单里（webm/mp4/mpeg/wav/ogg/flac） |
| 转写返回 413 | 音频超过 25 MiB。正常情况下 2 分钟硬停撞不到这里 |
| 朗读报音色错误 | `ttsVoice` 用了目标 provider 不认的名字，见上面「音色」 |

---

## 明确不做的事

| 不做 | 为什么 |
|---|---|
| 流式 / 实时 STT（中间结果、VAD、打断） | 那是另一个量级的工程（WS 二进制 + 端点检测 + 部分结果合并）。「录一段 → 转写 → 填进输入框」已覆盖主要用法 |
| 转写后自动发送 | 转写会出错，应该先看一眼再发；也避免误触发一整轮 |
| 自动朗读每条回复 | 太吵，而且每条都要花钱、要等 |
| 浏览器内置 `speechSynthesis` 兜底 | Windows 中文内置音色明显差于 CosyVoice。两条质量差距悬殊的路径并存，只会让人困惑"为什么今天声音不一样"。没配 → 隐藏按钮 + 看这篇文档 |
| 音色选择 UI / 音频缓存 / TUI 支持 | 配置项够用；语音是 Web UI 的能力 |
