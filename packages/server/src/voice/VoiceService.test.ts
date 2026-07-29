import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ResolvedSettings } from '@zuse/core'
import { VoiceService, VoiceNotConfiguredError, UnsupportedAudioTypeError } from './VoiceService.js'

/** 全程离线的 settings 夹具:两个 provider —— 一个 openai 协议、一个 anthropic 协议。 */
const settings = (over: Record<string, unknown> = {}): ResolvedSettings => ({
  providers: {
    sf: { protocol: 'openai', baseURL: 'https://x/v1', apiKey: 'k', models: [] },
    ant: { protocol: 'anthropic', baseURL: 'https://y', apiKey: 'k', models: [] },
  },
  tools: {},
  permissions: { defaultMode: 'default', allow: [], deny: [], ask: [] },
  ...over,
} as unknown as ResolvedSettings)

type TranscribeArgs = { file: unknown; model: string; response_format: 'text' }
type SpeechArgs = { model: string; voice: string; input: string; response_format: 'mp3' }

/** 假 audio client:不发网络请求、不需要 key。 */
function fakeClient() {
  const transcribe = vi.fn(async (_args: TranscribeArgs): Promise<unknown> => 'transcribed text')
  const speech = vi.fn(async (_args: SpeechArgs) => ({
    arrayBuffer: async (): Promise<ArrayBuffer> => new TextEncoder().encode('MP3BYTES').buffer as ArrayBuffer,
  }))
  return { calls: { transcribe, speech }, client: { audio: { transcriptions: { create: transcribe }, speech: { create: speech } } } }
}

afterEach(() => { vi.restoreAllMocks() })

describe('VoiceService.capabilities', () => {
  it('未配置 → 两项都 false', () => {
    const svc = new VoiceService({ loadSettings: () => settings() })
    expect(svc.capabilities()).toEqual({ stt: false, tts: false })
  })

  it('配了 openai 协议 provider → true', () => {
    const svc = new VoiceService({ loadSettings: () => settings({ sttModel: 'sf/m', ttsModel: 'sf/t', ttsVoice: 'v' }) })
    expect(svc.capabilities()).toEqual({ stt: true, tts: true })
  })

  it('配的是 anthropic 协议 provider → 视为未配置(该协议无音频端点),并只 warn 一次', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const svc = new VoiceService({ loadSettings: () => settings({ sttModel: 'ant/m' }) })
    expect(svc.capabilities().stt).toBe(false)
    expect(svc.capabilities().stt).toBe(false)      // 反复探测不该刷屏
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('ant')
  })

  it('指向不存在的 provider → 视为未配置(不抛)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const svc = new VoiceService({ loadSettings: () => settings({ sttModel: 'nope/m' }) })
    expect(svc.capabilities()).toEqual({ stt: false, tts: false })
  })
})

describe('VoiceService.transcribe', () => {
  it('传对 model,按 mime 选扩展名,返回文本', async () => {
    const f = fakeClient()
    const svc = new VoiceService({ loadSettings: () => settings({ sttModel: 'sf/FunAudioLLM/SenseVoiceSmall' }), makeClient: () => f.client })
    const text = await svc.transcribe(Buffer.from('x'), 'audio/webm;codecs=opus')
    expect(text).toBe('transcribed text')
    const arg = f.calls.transcribe.mock.calls[0]![0]
    expect(arg.model).toBe('FunAudioLLM/SenseVoiceSmall')
    expect(arg.response_format).toBe('text')
    // mime 的 `;` 参数先截断再查表 → webm(不是 "webm;codecs=opus")
    expect((arg.file as File).name).toBe('audio.webm')
  })

  it('未知 mime → UnsupportedAudioTypeError', async () => {
    const svc = new VoiceService({ loadSettings: () => settings({ sttModel: 'sf/m' }), makeClient: () => fakeClient().client })
    await expect(svc.transcribe(Buffer.from('x'), 'application/octet-stream')).rejects.toThrow(UnsupportedAudioTypeError)
  })

  it('未配置 → VoiceNotConfiguredError', async () => {
    const svc = new VoiceService({ loadSettings: () => settings() })
    await expect(svc.transcribe(Buffer.from('x'), 'audio/webm')).rejects.toThrow(VoiceNotConfiguredError)
  })

  it('非 openai 协议 provider → VoiceNotConfiguredError(不去打不存在的端点)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const svc = new VoiceService({ loadSettings: () => settings({ sttModel: 'ant/m' }) })
    await expect(svc.transcribe(Buffer.from('x'), 'audio/webm')).rejects.toThrow(VoiceNotConfiguredError)
  })

  it('provider 故障原样冒泡(不伪装成客户端错误)', async () => {
    const f = fakeClient()
    f.calls.transcribe.mockRejectedValueOnce(new Error('upstream 503'))
    const svc = new VoiceService({ loadSettings: () => settings({ sttModel: 'sf/m' }), makeClient: () => f.client })
    await expect(svc.transcribe(Buffer.from('x'), 'audio/webm')).rejects.toThrow('upstream 503')
  })
})

describe('VoiceService.speak', () => {
  it('传对 model/voice/input,返回音频字节', async () => {
    const f = fakeClient()
    const svc = new VoiceService({ loadSettings: () => settings({ ttsModel: 'sf/cosy', ttsVoice: 'nova' }), makeClient: () => f.client })
    const out = await svc.speak('你好')
    expect(out.contentType).toBe('audio/mpeg')
    expect(out.truncated).toBe(false)
    expect(out.audio.toString('utf8')).toBe('MP3BYTES')
    const arg = f.calls.speech.mock.calls[0]![0]
    expect(arg).toMatchObject({ model: 'cosy', voice: 'nova', input: '你好', response_format: 'mp3' })
  })

  it('配了 ttsModel 但没配 ttsVoice → 视为未配置(不留必然 400 的默认音色)', async () => {
    // 实测:OpenAI 要 'alloy' 这类裸名,SiliconFlow 要 '<模型>:<音色>',省略则两边都 400。
    // 任何内置默认值都会在另一边必然失败,所以宁可判为未配置、按钮不出现。
    const f = fakeClient()
    const svc = new VoiceService({ loadSettings: () => settings({ ttsModel: 'sf/cosy' }), makeClient: () => f.client })
    expect(svc.capabilities().tts).toBe(false)
    await expect(svc.speak('hi')).rejects.toThrow(VoiceNotConfiguredError)
    expect(f.calls.speech).not.toHaveBeenCalled()
  })

  it('provider 返回 200 但空音频 → 抛错(不把静默当成功交出去)', async () => {
    // 实测:SiliconFlow CosyVoice2 的部分音色会 200 + 0 字节。
    const empty = {
      audio: {
        transcriptions: { create: async () => 'x' },
        speech: { create: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) },
      },
    }
    const svc = new VoiceService({
      loadSettings: () => settings({ ttsModel: 'sf/cosy', ttsVoice: 'v' }),
      makeClient: () => empty as never,
    })
    await expect(svc.speak('hi')).rejects.toThrow(/空音频/)
  })

  it('超过 4096 字截断并标记', async () => {
    const f = fakeClient()
    const svc = new VoiceService({ loadSettings: () => settings({ ttsModel: 'sf/cosy', ttsVoice: 'v' }), makeClient: () => f.client })
    const out = await svc.speak('字'.repeat(5000))
    expect(out.truncated).toBe(true)
    expect(f.calls.speech.mock.calls[0]![0].input.length).toBe(4096)
  })

  it('未配置 → VoiceNotConfiguredError', async () => {
    const svc = new VoiceService({ loadSettings: () => settings() })
    await expect(svc.speak('hi')).rejects.toThrow(VoiceNotConfiguredError)
  })
})
