import { request } from './session.js'

const JSON_HEADERS = { 'content-type': 'application/json' }

/** 服务端两项语音能力的探测结果（`GET /api/voice`）。任一为 false → 对应按钮不渲染。 */
export interface VoiceCaps { stt: boolean; tts: boolean }

/** 录音 Blob 没带 type 时的兜底 mime（Chrome/Firefox 的 MediaRecorder 默认就是它）。 */
const FALLBACK_MIME = 'audio/webm'

/** GET /api/voice — 能力探测（前端据此显隐麦克风/朗读按钮）。失败抛错。 */
export async function getVoiceCaps(): Promise<VoiceCaps> {
  return (await (await request('/api/voice', {}, 'voice caps')).json()) as VoiceCaps
}

/** POST /api/voice/stt — 录音 Blob → 文本（内部转 base64，mimeType 取自 Blob）。失败抛错。 */
export async function transcribe(audio: Blob): Promise<string> {
  const body = JSON.stringify({ audio: await blobToBase64(audio), mimeType: audio.type || FALLBACK_MIME })
  const r = await request('/api/voice/stt', { method: 'POST', headers: JSON_HEADERS, body }, 'transcribe')
  return ((await r.json()) as { text: string }).text
}

/** POST /api/voice/tts — 文本 → 音频 Blob。`truncated` 来自 X-Zuse-Tts-Truncated（服务端在
 *  4096 字处截断时置位），调用方据此提示"仅朗读前 4096 字"。失败抛错。 */
export async function synthesize(text: string): Promise<{ blob: Blob; truncated: boolean }> {
  const r = await request('/api/voice/tts', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ text }) }, 'synthesize')
  return { blob: await r.blob(), truncated: r.headers.get('x-zuse-tts-truncated') === '1' }
}

/** Blob → 裸 base64（去掉 data-URL 前缀）。走 FileReader 而不是 btoa(String.fromCharCode(...))：
 *  后者对一段两分钟的录音会把整个字节数组铺进参数列表，直接爆栈。 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onerror = () => reject(new Error('read audio failed'))
    fr.onload = () => {
      const s = typeof fr.result === 'string' ? fr.result : ''
      const comma = s.indexOf(',')
      resolve(comma >= 0 ? s.slice(comma + 1) : s)
    }
    fr.readAsDataURL(blob)
  })
}
