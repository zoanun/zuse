import stringWidth from 'string-width'

/**
 * 把用户消息回显行补齐到终端宽度,让底色铺满整行(Ink 5 的 Text backgroundColor
 * 只染实际字符,Box 不支持 backgroundColor,只能用带样式的空格填充)。
 * visible 必须是「可见文本」——OSC-8 链接的转义序列不占列宽,调用方传 seg.text 拼出的纯文本。
 * 行宽 ≥ 终端宽度时返回空串:恰好满行再补会多 1 格触发折行,超宽行由 Ink 自行折行。
 */
export function padToWidth(visible: string, columns: number): string {
  return ' '.repeat(Math.max(0, columns - stringWidth(visible)))
}
