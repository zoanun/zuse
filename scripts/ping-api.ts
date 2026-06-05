import Anthropic from '@anthropic-ai/sdk'
import { loadSettings, getClientConfig } from '../packages/core/src/settings.js'

// 改用三层 settings 读 key（.env 已退役）。loadSettings 会合并
// 用户层/项目层/本地层，并让 ZUSE_API_KEY 环境变量兜底覆盖。
const settings = loadSettings()
const { apiKey, baseURL } = getClientConfig(settings)

const client = new Anthropic({ apiKey, baseURL })

async function main() {
  const response = await client.messages.create({
    model: settings.model || 'qwen3-coder-plus',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
  })
  const textBlock = response.content.find((block) => block.type === 'text')
  const text = textBlock && textBlock.type === 'text' ? textBlock.text : '(no text)'
  console.log('Model:', response.model)
  console.log('Stop reason:', response.stop_reason)
  console.log('Usage:', response.usage)
  console.log('Response text:', text)
}

main().catch((err) => {
  console.error('Ping failed:', err)
  process.exit(1)
})
