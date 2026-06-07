import { Text } from 'ink'
import type { ReactNode } from 'react'
import type { Token, Tokens } from 'marked'
import { decodeEntities } from './layout.js'

/** 把 marked 行内 token 数组递归映射成嵌套的 <Text>。 */
export function renderInline(tokens: Token[], keyPrefix: string): ReactNode[] {
  return tokens.map((tok, i) => {
    const key = `${keyPrefix}-i${i}`
    switch (tok.type) {
      case 'strong':
        return (
          <Text key={key} bold>
            {renderInline((tok as Tokens.Strong).tokens, key)}
          </Text>
        )
      case 'em':
        return (
          <Text key={key} italic>
            {renderInline((tok as Tokens.Em).tokens, key)}
          </Text>
        )
      case 'del':
        return (
          <Text key={key} strikethrough>
            {renderInline((tok as Tokens.Del).tokens, key)}
          </Text>
        )
      case 'codespan':
        return (
          <Text key={key} backgroundColor="gray" color="white">
            {` ${decodeEntities((tok as Tokens.Codespan).text)} `}
          </Text>
        )
      case 'link': {
        const link = tok as Tokens.Link
        return (
          <Text key={key}>
            <Text underline color="blue">
              {renderInline(link.tokens, key)}
            </Text>
            <Text dimColor>{` (${link.href})`}</Text>
          </Text>
        )
      }
      case 'br':
        return <Text key={key}>{'\n'}</Text>
      default: {
        // text / escape / 其它:有嵌套就递归,否则解码后输出纯文本。
        const t = tok as Tokens.Text
        if (t.tokens && t.tokens.length > 0) {
          return <Text key={key}>{renderInline(t.tokens, key)}</Text>
        }
        return <Text key={key}>{decodeEntities(t.text ?? tok.raw ?? '')}</Text>
      }
    }
  })
}
