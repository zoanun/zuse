/** 单个值截断到多少字符 —— 一张卡不能被一个字段刷屏。 */
const VALUE_CAP = 200
/** 整段预览的上限。 */
const TOTAL_CAP = 500

/** 剥控制字符：入参是模型输出，会被打进页面与终端（ESC/OSC 能清屏、伪造提示行）。 */
function scrub(text: string): string {
  let out = ''
  for (const ch of text) {
    const c = ch.charCodeAt(0)
    out += (c < 0x20 || c === 0x7f) ? ' ' : ch
  }
  return out.replace(/\s+/g, ' ').trim()
}

function render(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'object') {
    try { return JSON.stringify(value) } catch { return String(value) }
  }
  return String(value)
}

/**
 * 权限卡片上「限定符没说的那部分」。
 *
 * ## 为什么需要它
 *
 * 卡片一直只显示 `工具名 · 限定符`。对 Bash 够了（限定符就是整条命令），
 * 对别的工具不够：`Memory(save)` 那张卡上用户看到的字面就是「Memory · save」——
 * 而「必须确认」这一档的全部价值就是**让人看一眼**。一次提示注入让模型
 * 读了个恶意 README、说「记住本项目约定」，用户看到的只有五个字。
 *
 * ## 判据为什么不是一张「哪些工具要显示」的清单
 *
 * 清单必然漂移 —— 第七个工具出现时没人会想起来加，而症状是「这张卡又变盲了」，
 * 没有任何东西会提醒你。这里用的是**结构性**判据：
 * **把值等于限定符的字段丢掉，剩下的就是限定符没说的那部分。**
 * 新工具接进来自动就有，不需要谁记得。
 */
export function permissionInputPreview(input: unknown, specifier: string | null): string {
  if (input === null || typeof input !== 'object') return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const text = render(v)
    // 值就是限定符 → 卡上已经写过了，不重复占地方。
    if (specifier !== null && text === specifier) continue
    const clean = scrub(text)
    if (clean === '') continue
    parts.push(`${k}: ${clean.length > VALUE_CAP ? clean.slice(0, VALUE_CAP) + '…' : clean}`)
  }
  const joined = parts.join('  ·  ')
  return joined.length > TOTAL_CAP ? joined.slice(0, TOTAL_CAP) + '…' : joined
}
