// 实测哪些模型真的接受图片输入。vision 标错的后果是「上传图片后模型看不见但也不报错」，
// 或者反过来「明明能看却被路由去 imageModel 转文字」——两种都很难查，所以不猜。
const base = 'https://dashscope.aliyuncs.com/apps/anthropic'
const key = 'sk-158c10cd3b9043d59f3352cf86cfe33a'
// 1x1 透明 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const models = ['qwen3.8-max', 'qwen3.8-2.4t-a95b', 'qwen3.7-flash', 'qwen3.7-flash-2026-07-15', 'deepseek-v4-pro-0813', 'deepseek-v4-flash-0731']
for (const m of models) {
  try {
    const r = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: m, max_tokens: 8,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
          { type: 'text', text: 'what color' },
        ] }],
      }),
    })
    const body = await r.text()
    console.log(`${r.ok ? '✓ 吃图' : '✗ 不吃'} ${m.padEnd(28)} ${r.status}  ${body.slice(0, 110).replace(/\s+/g, ' ')}`)
  } catch (e) {
    console.log(`✗ ERR  ${m}  ${String(e).slice(0, 100)}`)
  }
}
