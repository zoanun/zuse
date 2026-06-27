import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import type { Message } from './types.js'
import { partsText, replyMarkdown } from '../components/Message.js'

const REMARK = [remarkGfm, remarkBreaks]

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Self-contained styles for the exported file — bubbles, code, tables. Stands alone (no external
// CSS/fonts) so the file opens identically anywhere.
const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: #f5f3ee; color: #2b2b2b; font: 15px/1.6 -apple-system, "Segoe UI", system-ui, sans-serif; }
.chat { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; display: flex; flex-direction: column; gap: 18px; }
h1.title { font-size: 18px; margin: 0 0 8px; color: #555; }
.msg { max-width: 100%; }
.msg.user { align-self: flex-end; max-width: 80%; }
.msg.user .bubble { background: #e7e1d6; border-radius: 18px; padding: 10px 16px; white-space: pre-wrap; word-break: break-word; }
.msg.agent .text { word-break: break-word; }
.msg.agent pre { background: #2b2b2b; color: #f5f3ee; padding: 12px 14px; border-radius: 10px; overflow-x: auto; font: 12.5px/1.5 ui-monospace, "SFMono-Regular", Consolas, monospace; }
.msg.agent code { font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; }
.msg.agent :not(pre) > code { background: #e7e1d6; padding: 1px 5px; border-radius: 5px; font-size: 0.9em; }
.msg.agent table { border-collapse: collapse; }
.msg.agent th, .msg.agent td { border: 1px solid #d8d2c6; padding: 5px 9px; }
.msg.agent blockquote { margin: 0; padding-left: 14px; border-left: 3px solid #d8d2c6; color: #555; }
@media (prefers-color-scheme: dark) {
  body { background: #1c1b19; color: #e6e3dc; }
  .msg.user .bubble { background: #34322d; }
  .msg.agent :not(pre) > code { background: #34322d; }
  .msg.agent th, .msg.agent td, .msg.agent blockquote { border-color: #3a3833; }
}
`

/** One message → an HTML block. User = plain (escaped) bubble; assistant = rendered markdown
 *  prose (think + tool cards already excluded). Returns '' for turns with nothing to show. */
function messageHtml(m: Message): string {
  if (m.role === 'user') {
    const text = partsText(m.parts).trim()
    return text ? `<div class="msg user"><div class="bubble">${esc(text)}</div></div>` : ''
  }
  if (m.role === 'assistant') {
    const md = replyMarkdown(m.parts)
    if (!md) return ''
    const inner = renderToStaticMarkup(<ReactMarkdown remarkPlugins={REMARK}>{md}</ReactMarkdown>)
    return `<div class="msg agent"><div class="text">${inner}</div></div>`
  }
  return '' // system notices aren't part of the shared transcript
}

/** Build a standalone HTML transcript of the conversation (user messages + assistant replies). */
export function buildChatHtml(messages: Message[], title = 'zuse chat'): string {
  const body = messages.map(messageHtml).filter(Boolean).join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="chat">
<h1 class="title">${esc(title)}</h1>
${body}
</div>
</body>
</html>`
}

/** Build the transcript and trigger a browser download as an .html file. */
export function downloadChatHtml(messages: Message[], filename = 'zuse-chat.html'): void {
  const blob = new Blob([buildChatHtml(messages)], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
