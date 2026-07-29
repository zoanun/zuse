import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { Composer } from './Composer.js'
import { Message } from './Message.js'
import { VoiceProvider, useVoice } from '../state/store.js'
import { getVoiceCaps, transcribe, synthesize } from '../state/voiceApi.js'

// 全程离线:语音三个 API 全部 mock。默认两项能力都开,单个用例按需改 getVoiceCaps 的返回。
vi.mock('../state/voiceApi.js', () => ({
  getVoiceCaps: vi.fn(async () => ({ stt: true, tts: true })),
  transcribe: vi.fn(async () => '转写结果'),
  synthesize: vi.fn(async () => ({ blob: new Blob(['MP3'], { type: 'audio/mpeg' }), truncated: false })),
}))

// Composer 顺带 import 了上传 API(与语音无关) —— mock 掉,别让它走网络。
vi.mock('../state/manageApi.js', () => ({
  uploadImage: vi.fn(async (f: File) => ({ id: 'i-' + f.name, name: f.name, mediaType: 'image/png' })),
  uploadedImageUrl: (id: string) => '/api/uploads/' + id,
  uploadFile: vi.fn(async (f: File) => ({ id: 'f-' + f.name, name: f.name, mediaType: 'text/plain' })),
}))

/** 能力探测是异步的,"按钮不存在"在探测落地前是平凡真。渲染这个探针,先等能力落地再断言显隐。 */
function CapsProbe() {
  const { caps } = useVoice()
  return <div data-testid="caps">{caps ? `stt=${caps.stt} tts=${caps.tts}` : 'pending'}</div>
}

/** jsdom 没有 navigator.mediaDevices(与非 secure context 同形)——按用例装/卸。 */
function setMediaDevices(value: unknown): void {
  Object.defineProperty(navigator, 'mediaDevices', { value, configurable: true, writable: true })
}

/** jsdom 没有 MediaRecorder。这个替身把 stop() 变成同步的 dataavailable + onstop。 */
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  state: 'recording' | 'inactive' = 'inactive'
  mimeType = 'audio/webm'
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  constructor(public stream: unknown) { FakeMediaRecorder.instances.push(this) }
  start(): void { this.state = 'recording' }
  stop(): void {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['AUDIO'], { type: 'audio/webm' }) })
    this.onstop?.()
  }
}

const trackStop = vi.fn()
/** 装好一套可录音的环境(mediaDevices + MediaRecorder),返回 getUserMedia 的 spy。 */
function installRecording() {
  FakeMediaRecorder.instances = []
  trackStop.mockClear()
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] }))
  setMediaDevices({ getUserMedia })
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  return getUserMedia
}

const assistantMsg = { id: 'a1', role: 'assistant' as const, parts: [{ kind: 'text' as const, text: '你好世界' }] }

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setMediaDevices(undefined)
})

describe('V1 麦克风(Composer)', () => {
  it('caps.stt=false → 不渲染麦克风(哪怕浏览器支持录音)', async () => {
    vi.mocked(getVoiceCaps).mockResolvedValue({ stt: false, tts: true })
    installRecording()
    render(<VoiceProvider><CapsProbe /><Composer thinking={false} onSend={() => {}} onStop={() => {}} /></VoiceProvider>)
    await screen.findByText('stt=false tts=true')
    expect(screen.queryByLabelText('语音输入')).toBeNull()
  })

  it('navigator.mediaDevices 缺失(非 secure context) → 不渲染麦克风,且不炸', async () => {
    vi.mocked(getVoiceCaps).mockResolvedValue({ stt: true, tts: true })
    setMediaDevices(undefined)
    render(<VoiceProvider><CapsProbe /><Composer thinking={false} onSend={() => {}} onStop={() => {}} /></VoiceProvider>)
    await screen.findByText('stt=true tts=true')
    expect(screen.queryByLabelText('语音输入')).toBeNull()
  })

  it('caps.stt=true 且有 getUserMedia → 渲染麦克风', async () => {
    vi.mocked(getVoiceCaps).mockResolvedValue({ stt: true, tts: false })
    installRecording()
    render(<VoiceProvider><CapsProbe /><Composer thinking={false} onSend={() => {}} onStop={() => {}} /></VoiceProvider>)
    expect(await screen.findByLabelText('语音输入')).toBeInTheDocument()
  })

  it('录一段 → 停止 → 转写文本插入光标处(不覆盖、不自动发送)', async () => {
    vi.mocked(getVoiceCaps).mockResolvedValue({ stt: true, tts: false })
    vi.mocked(transcribe).mockResolvedValue('转写结果')
    const getUserMedia = installRecording()
    const onSend = vi.fn()
    render(<VoiceProvider><CapsProbe /><Composer thinking={false} onSend={onSend} onStop={() => {}} /></VoiceProvider>)

    const ta = screen.getByPlaceholderText('给 zuse 发消息…') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'ab' } })
    ta.setSelectionRange(1, 1) // 光标落在 a 与 b 之间

    const mic = await screen.findByLabelText('语音输入')
    await act(async () => { fireEvent.click(mic) })
    expect(getUserMedia).toHaveBeenCalled()
    // 录音中:发送被禁用
    expect(screen.getByLabelText('发送消息')).toBeDisabled()

    await act(async () => { fireEvent.click(screen.getByLabelText('停止录音')) })
    await waitFor(() => expect(ta.value).toBe('a转写结果b'))
    expect(transcribe).toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()   // 绝不自动发送
    expect(trackStop).toHaveBeenCalled()    // 麦克风轨道已释放
  })

  it('录满 2 分钟自动硬停', async () => {
    vi.mocked(getVoiceCaps).mockResolvedValue({ stt: true, tts: false })
    installRecording()
    render(<VoiceProvider><CapsProbe /><Composer thinking={false} onSend={() => {}} onStop={() => {}} /></VoiceProvider>)
    const mic = await screen.findByLabelText('语音输入')

    vi.useFakeTimers()
    await act(async () => { fireEvent.click(mic) })
    const rec = FakeMediaRecorder.instances[0]
    expect(rec?.state).toBe('recording')
    act(() => { vi.advanceTimersByTime(2 * 60 * 1000) })
    expect(rec?.state).toBe('inactive')
    vi.useRealTimers()
  })

  it('转写失败 → 红字提示,4 秒后自动消失', async () => {
    vi.mocked(getVoiceCaps).mockResolvedValue({ stt: true, tts: false })
    vi.mocked(transcribe).mockRejectedValue(new Error('boom'))
    installRecording()
    render(<VoiceProvider><CapsProbe /><Composer thinking={false} onSend={() => {}} onStop={() => {}} /></VoiceProvider>)
    const mic = await screen.findByLabelText('语音输入')
    await act(async () => { fireEvent.click(mic) })
    await act(async () => { fireEvent.click(screen.getByLabelText('停止录音')) })
    const err = await screen.findByRole('alert')
    expect(err).toHaveTextContent('转写失败')
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull(), { timeout: 5000 })
  })
})

describe('V2 朗读(Message)', () => {
  /** 让 new Audio(url).play()/pause() 在 jsdom 里可断言,并接管 object-URL。 */
  function stubAudio() {
    const play = vi.fn(async () => {})
    const pause = vi.fn()
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(play)
    vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(pause)
    let n = 0
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:zuse-' + ++n)
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    return { play, pause, createUrl, revoke }
  }

  it('caps.tts=false → 助手消息不渲染朗读按钮(操作行其余按钮照旧)', async () => {
    vi.mocked(getVoiceCaps).mockResolvedValue({ stt: true, tts: false })
    render(<VoiceProvider><CapsProbe /><Message msg={assistantMsg} /></VoiceProvider>)
    await screen.findByText('stt=true tts=false')
    expect(screen.queryByLabelText('朗读')).toBeNull()
    expect(screen.getByLabelText('复制回复')).toBeInTheDocument()
  })

  it('caps.tts=true 但是用户消息 → 不渲染朗读按钮', async () => {
    vi.mocked(getVoiceCaps).mockResolvedValue({ stt: false, tts: true })
    render(
      <VoiceProvider>
        <CapsProbe />
        <Message msg={{ id: 'u1', role: 'user', parts: [{ kind: 'text', text: '问题' }] }} />
      </VoiceProvider>,
    )
    await screen.findByText('stt=false tts=true')
    expect(screen.queryByLabelText('朗读')).toBeNull()
  })

  it('点击朗读 → 调 /api/voice/tts 并播放;再点停止并 revokeObjectURL', async () => {
    vi.mocked(getVoiceCaps).mockResolvedValue({ stt: false, tts: true })
    vi.mocked(synthesize).mockResolvedValue({ blob: new Blob(['MP3'], { type: 'audio/mpeg' }), truncated: false })
    const { play, pause, revoke } = stubAudio()
    render(<VoiceProvider><CapsProbe /><Message msg={assistantMsg} /></VoiceProvider>)

    const btn = await screen.findByLabelText('朗读')
    await act(async () => { fireEvent.click(btn) })
    expect(synthesize).toHaveBeenCalledWith('你好世界')
    expect(play).toHaveBeenCalled()

    const stopBtn = await screen.findByLabelText('停止朗读')
    await act(async () => { fireEvent.click(stopBtn) })
    expect(pause).toHaveBeenCalled()
    expect(revoke).toHaveBeenCalledWith('blob:zuse-1')
    await waitFor(() => expect(screen.getByLabelText('朗读')).toBeInTheDocument())
  })

  it('同一时刻只播一条:开播第二条会停掉第一条并释放它的 objectURL', async () => {
    vi.mocked(getVoiceCaps).mockResolvedValue({ stt: false, tts: true })
    const { revoke } = stubAudio()
    render(
      <VoiceProvider>
        <CapsProbe />
        <Message msg={assistantMsg} />
        <Message msg={{ id: 'a2', role: 'assistant', parts: [{ kind: 'text', text: '第二条' }] }} />
      </VoiceProvider>,
    )
    await screen.findByText('stt=false tts=true')
    const [first, second] = screen.getAllByLabelText('朗读')
    await act(async () => { fireEvent.click(first!) })
    expect(screen.getAllByLabelText('停止朗读')).toHaveLength(1)

    await act(async () => { fireEvent.click(screen.getByLabelText('朗读')) }) // 剩下的那个就是第二条
    expect(second).toBeDefined()
    await waitFor(() => expect(screen.getAllByLabelText('停止朗读')).toHaveLength(1))
    expect(revoke).toHaveBeenCalledWith('blob:zuse-1') // 第一条的 URL 已释放
  })

  it('响应带截断标记 → 提示"仅朗读前 4096 字"', async () => {
    vi.mocked(getVoiceCaps).mockResolvedValue({ stt: false, tts: true })
    vi.mocked(synthesize).mockResolvedValue({ blob: new Blob(['MP3'], { type: 'audio/mpeg' }), truncated: true })
    stubAudio()
    render(<VoiceProvider><CapsProbe /><Message msg={assistantMsg} /></VoiceProvider>)
    const btn = await screen.findByLabelText('朗读')
    await act(async () => { fireEvent.click(btn) })
    expect(await screen.findByText('仅朗读前 4096 字')).toBeInTheDocument()
  })
})
