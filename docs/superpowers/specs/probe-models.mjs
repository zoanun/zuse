// 逐个真调一次，确认模型名有效、额度可用。每次只要 1 个 token。
const base = 'https://dashscope.aliyuncs.com/apps/anthropic'
const key = 'sk-158c10cd3b9043d59f3352cf86cfe33a'
const models = [
  'qwen3.8-max',
  'qwen3.8-2.4t-a95b',
  'qwen3.7-flash',
  'qwen3.7-flash-2026-07-15',
  'deepseek-v4-pro-0813',
  'deepseek-v4-flash-0731',
  // 对照组：截图里没有的（应当已耗尽或不存在）
  'qwen3.7-plus-2026-05-26',
  'kimi-k2.6',
]
for (const m of models) {
  const t0 = Date.now()
  try {
    const r = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: m, max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
    })
    const body = await r.text()
    const ms = Date.now() - t0
    if (r.ok) {
      let vision = 'n/a'
      console.log(`✓ ${m.padEnd(28)} ${r.status} ${ms}ms  ${body.slice(0, 80).replace(/\s+/g, ' ')}`)
      void vision
    } else {
      console.log(`✗ ${m.padEnd(28)} ${r.status} ${ms}ms  ${body.slice(0, 160).replace(/\s+/g, ' ')}`)
    }
  } catch (e) {
    console.log(`✗ ${m.padEnd(28)} ERR  ${String(e).slice(0, 120)}`)
  }
}
