import { loadSettings, resolveModelSelection, getProviderConfig, getDefaultMaxTokens } from '../packages/core/src/settings.js'
import { createModelClient } from '../packages/core/src/model-client.js'
import type { Message } from '../packages/core/src/types.js'

// 用三层 settings 读 key（.env 已退役）。loadSettings 合并用户/项目/本地层，
// ZUSE_API_KEY 环境变量兜底覆盖。createModelClient 按 provider.protocol 选具体实现，
// 所以不论默认 provider 走 anthropic 还是 openai 协议都能正确 ping。
const settings = loadSettings()
const sel = resolveModelSelection(settings)
const provider = getProviderConfig(settings, sel.providerId)
const client = createModelClient(provider, sel.model)

async function main(): Promise<void> {
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: pong' }] }]
  console.log('Provider:', sel.providerId, '| Model:', sel.model)
  let text = ''
  for await (const event of client.sendMessages(messages, { model: sel.model, max_tokens: getDefaultMaxTokens(settings) })) {
    if (event.type === 'text-delta') {
      text += event.text
      process.stdout.write(event.text)
    } else if (event.type === 'message-stop') {
      console.log('\nStop reason:', event.stop_reason)
      console.log('Usage:', event.usage)
    } else if (event.type === 'error') {
      console.error('\nError:', event.message)
      process.exit(1)
    }
  }
  if (!text) console.log('(no text)')
}

main().catch((err) => {
  console.error('Ping failed:', err)
  process.exit(1)
})
