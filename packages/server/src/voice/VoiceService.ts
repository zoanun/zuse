import OpenAI, { toFile, type Uploadable } from 'openai'
import {
  loadSettings as defaultLoadSettings,
  getProviderConfig,
  resolveSttModelSelection,
  resolveTtsModelSelection,
} from '@zuse/core'
import type { ProviderConfig, ResolvedSettings } from '@zuse/core'

/**
 * 没配 sttModel/ttsModel(或配的 provider 不可用)时抛出 —— 路由映射成 400。
 * 具名错误而非裸 Error:让路由能把「用户没配」与「provider/磁盘真故障」区分开,
 * 后者必须原样冒泡成 5xx(镜像 SkillService 的 BuiltinSkillNotEditableError)。
 */
export class VoiceNotConfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VoiceNotConfiguredError'
  }
}

/** 上传音频的 mime 不在白名单里 —— 路由映射成 415。 */
export class UnsupportedAudioTypeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedAudioTypeError'
  }
}

/**
 * 只描述 openai SDK 里我们用到的音频子集 —— 单测注入假实现即可全程离线,
 * 不需要 key、不发请求。真 OpenAI client 结构上满足这个形状。
 */
export interface AudioClient {
  audio: {
    transcriptions: {
      // file 用 SDK 的 Uploadable(而非 unknown):真 OpenAI client 才结构上满足这个接口,
      // 否则 `new OpenAI()` 无法赋给 AudioClient(参数逆变)。
      create(args: { file: Uploadable; model: string; response_format: 'text' }): Promise<unknown>
    }
    speech: {
      create(args: { model: string; voice: string; input: string; response_format: 'mp3' }): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>
    }
  }
}

export interface VoiceServiceDeps {
  /** 注入用:测试传假 client,全程离线。缺省按 settings 现建 OpenAI client。 */
  makeClient?: (baseURL: string | undefined, apiKey: string) => AudioClient
  /** 注入用:测试传假 settings。缺省 loadSettings()。 */
  loadSettings?: () => ResolvedSettings
}

/**
 * mime → 上传文件名后缀。OpenAI 兼容的 /audio/transcriptions 靠文件名后缀判断容器格式,
 * 猜错会被服务端拒收 —— 所以表里没有的 mime 一律拒绝(415),不瞎猜。
 */
const MIME_EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mpga': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
}

/** OpenAI /audio/speech 的契约上限。超出截断(念开头仍有用),并向调用方标记。 */
export const TTS_TEXT_CAP = 4096

/**
 * 朗读**必须**显式配 settings.ttsVoice —— 没有跨 provider 通用的默认音色。
 *
 * 实测(2026-07-29,SiliconFlow `/audio/speech`):`alloy`(OpenAI 的经典默认)→ 400
 * `Invalid voice`;裸音色名 `alex` → 400 同样;整个省略 voice → 400
 * `Voice or reference audio should be set`。只有 `<模型>:<音色>` 形式
 * (如 `FunAudioLLM/CosyVoice2-0.5B:alex`)才 200。而 OpenAI 官方端点要的又是 `alloy`
 * 这类裸名 —— 两边格式互不兼容,任何内置默认值都会在另一边必然失败。
 *
 * 因此:没配 ttsVoice 就把 tts 判为**未配置**(按钮根本不出现),而不是让用户点下去吃一个 400。
 */
const ttsVoiceOf = (settings: { ttsVoice?: string }): string | null => settings.ttsVoice?.trim() || null

/** 解析出的可用目标:openai 协议的 provider + 裸模型名。 */
interface VoiceTarget {
  provider: ProviderConfig
  model: string
}

/** 从 response_format:'text' 的返回里取文本。兼容个别兼容层仍回 JSON {text} 的实现。 */
function extractText(out: unknown): string {
  if (typeof out === 'string') return out.trim()
  if (out !== null && typeof out === 'object' && 'text' in out) {
    const t = (out as { text: unknown }).text
    if (typeof t === 'string') return t.trim()
  }
  // 形状不认识 = provider 行为异常,不是客户端的错 → 冒泡成 5xx。
  throw new Error(`unexpected transcription response shape: ${typeof out}`)
}

/**
 * STT(转写)与 TTS(朗读)的服务端实现,共用「解析 provider → 建 OpenAI 兼容 client」这段。
 *
 * 生产用零参构造(`new VoiceService()`):settings 每次调用现读(与 MCP 同约束:改配置后重启
 * daemon 才最保险,但现读至少不会把启动瞬间的空配置钉死)。测试注入 makeClient/loadSettings。
 */
export class VoiceService {
  private readonly loadSettingsFn: () => ResolvedSettings
  private readonly makeClientFn: (baseURL: string | undefined, apiKey: string) => AudioClient
  /** 已经 warn 过的原因,避免每次能力探测都刷屏(前端每次加载都会打 GET /api/voice)。 */
  private readonly warned = new Set<string>()

  constructor(deps: VoiceServiceDeps = {}) {
    this.loadSettingsFn = deps.loadSettings ?? (() => defaultLoadSettings())
    this.makeClientFn = deps.makeClient ?? defaultMakeClient
  }

  /** 两项能力各自是否可用(前端据此决定按钮显隐)。永不抛 —— 未配置就是 false。 */
  capabilities(): { stt: boolean; tts: boolean } {
    const settings = this.loadSettingsFn()
    return {
      stt: this.resolveTarget(settings, 'stt') !== null,
      // 没配音色 = 未配置:内置默认音色在多数 provider 上必然 400(见 ttsVoiceOf 注释)。
      tts: this.resolveTarget(settings, 'tts') !== null && ttsVoiceOf(settings) !== null,
    }
  }

  /** 音频字节 → 文本。未配置 → VoiceNotConfiguredError;未知 mime → UnsupportedAudioTypeError。 */
  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    const target = this.resolveTarget(this.loadSettingsFn(), 'stt')
    if (!target) {
      throw new VoiceNotConfiguredError('语音转写未配置:请在 settings 里设置 sttModel(需 openai 协议的 provider)')
    }
    // `audio/webm;codecs=opus` 这类带参数的 mime 先按 `;` 截断再查表。
    const base = (mimeType.split(';')[0] ?? '').trim().toLowerCase()
    const ext = MIME_EXT[base]
    if (!ext) throw new UnsupportedAudioTypeError(`不支持的音频类型: ${mimeType}`)

    const client = this.makeClientFn(target.provider.baseURL, target.provider.apiKey)
    const file = await toFile(audio, `audio.${ext}`, { type: base })
    const out = await client.audio.transcriptions.create({ file, model: target.model, response_format: 'text' })
    return extractText(out)
  }

  /** 文本 → 音频字节。超过 TTS_TEXT_CAP 截断并置 truncated(整条拒绝更糟)。 */
  async speak(text: string): Promise<{ audio: Buffer; contentType: string; truncated: boolean }> {
    const settings = this.loadSettingsFn()
    const target = this.resolveTarget(settings, 'tts')
    if (!target) {
      throw new VoiceNotConfiguredError('朗读未配置:请在 settings 里设置 ttsModel(需 openai 协议的 provider)')
    }
    const voice = ttsVoiceOf(settings)
    if (!voice) {
      throw new VoiceNotConfiguredError(
        '朗读未配置:还需设置 ttsVoice —— 各家音色命名不同(OpenAI 如 "alloy";SiliconFlow 需 "<模型>:<音色>",如 "FunAudioLLM/CosyVoice2-0.5B:alex"),没有可用的通用默认值。',
      )
    }
    const truncated = text.length > TTS_TEXT_CAP
    const input = truncated ? text.slice(0, TTS_TEXT_CAP) : text
    const client = this.makeClientFn(target.provider.baseURL, target.provider.apiKey)
    const res = await client.audio.speech.create({
      model: target.model,
      voice,
      input,
      response_format: 'mp3',
    })
    const audio = Buffer.from(await res.arrayBuffer())
    // 实测(SiliconFlow CosyVoice2 的部分音色):会返回 HTTP 200 但 body 是 0 字节。
    // 把这种「成功包装的空音频」原样交出去,前端只会播一段静默、无从排查 —— 当作 provider 故障抛出。
    if (audio.length === 0) {
      throw new Error(`朗读失败:provider 返回了空音频(model=${target.model}, voice=${voice}) —— 多半是该音色不可用,换一个 ttsVoice 再试。`)
    }
    return { audio, contentType: 'audio/mpeg', truncated }
  }

  /**
   * settings → 可用目标,任何一环缺失都返回 null(= 未配置),绝不抛:
   * 没配 model / provider 不存在或缺 key / provider 不是 openai 协议(anthropic 没有音频端点)。
   * 后两种是「配了但用不了」的错配,各 warn 一次说明原因 —— 静默失败更难排查。
   */
  private resolveTarget(settings: ResolvedSettings, kind: 'stt' | 'tts'): VoiceTarget | null {
    const sel = kind === 'stt' ? resolveSttModelSelection(settings) : resolveTtsModelSelection(settings)
    if (!sel) return null
    let provider: ProviderConfig
    try {
      provider = getProviderConfig(settings, sel.providerId)
    } catch (e) {
      this.warnOnce(`${kind}:missing:${sel.providerId}`, `[voice] ${kind}Model 指向的 provider "${sel.providerId}" 不可用:${e instanceof Error ? e.message : String(e)} —— 该能力已禁用。`)
      return null
    }
    if (provider.protocol !== 'openai') {
      this.warnOnce(`${kind}:protocol:${sel.providerId}`, `[voice] ${kind}Model 指向的 provider "${sel.providerId}" 是 ${provider.protocol} 协议,没有 OpenAI 形状的音频端点 —— 该能力已禁用。请改用 protocol:"openai" 的 provider。`)
      return null
    }
    return { provider, model: sel.model }
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    console.warn(message)
  }
}

/** 生产用的 client 工厂。baseURL 缺省时交给 SDK 用官方端点。 */
function defaultMakeClient(baseURL: string | undefined, apiKey: string): AudioClient {
  return new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })
}
