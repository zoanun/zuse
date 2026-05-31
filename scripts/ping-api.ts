import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// Minimal .env loader — no dotenv dependency needed for one-off script.
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (!(key in process.env)) {
      process.env[key] = value
    }
  }
}

loadDotEnv(resolve(process.cwd(), '.env'))

const apiKey = process.env.DASHSCOPE_API_KEY
const baseUrl = process.env.DASHSCOPE_BASE_URL

if (!apiKey || !baseUrl) {
  console.error('DASHSCOPE_API_KEY or DASHSCOPE_BASE_URL not set. Copy .env.example to .env and fill it in.')
  process.exit(1)
}

const client = new Anthropic({
  apiKey,
  baseURL: baseUrl,
})

async function main() {
  const response = await client.messages.create({
    model: 'qwen3-coder-plus', // Qwen Coder via DashScope Anthropic endpoint
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