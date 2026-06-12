import { Box, Text } from 'ink'
import type { Usage } from '@zuse/core'

interface UsageFooterProps {
  totalUsage?: Usage
  contextTokens?: number // 上一回合的完整输入规模（新输入 + 缓存命中）—— 实时上下文大小
  /** 当前模型的上下文窗口(resolveContextWindow 解析,模型级 → provider 级 → 缺省)。 */
  contextWindow?: number
  isThinking: boolean
}

/** 1234 → "1.2k",1000000 → "1M":footer 空间紧,token 数用人类可读短格式。 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  if (n >= 1_000) {
    const k = n / 1_000
    return `${k >= 100 ? String(Math.round(k)) : k.toFixed(1)}k`
  }
  return String(n)
}

/**
 * 上下文占比着色(故障模式②的软警戒线,随窗口大小自适应):
 * ≥80% 红 —— 下一条消息将触发自动压缩(对齐 COMPACTION_THRESHOLD);
 * ≥60% 黄 —— 预警;其余沿用暗色。
 */
export function contextRatioColor(ratio: number): string | undefined {
  if (ratio >= 0.8) return 'red'
  if (ratio >= 0.6) return 'yellow'
  return undefined
}

/**
 * 用量页脚：无边框，紧贴输入框下方靠右显示（见 App 布局）。不再展示模型——
 * 模型在启动横幅里已给出，页脚只留实时的用量/上下文/缓存命中。
 * 分隔符用 ` · `，各段缺省时整段省略，避免出现空悬的分隔符。
 */
export function UsageFooter({ totalUsage, contextTokens, contextWindow, isThinking }: UsageFooterProps) {
  // input_tokens 已归一为「不含缓存」，故累计显式加回缓存读写，否则开缓存时会少计。
  const total =
    totalUsage &&
    totalUsage.input_tokens +
      totalUsage.output_tokens +
      (totalUsage.cache_read_input_tokens ?? 0) +
      (totalUsage.cache_creation_input_tokens ?? 0)

  const cacheHit = (totalUsage?.cache_read_input_tokens ?? 0) > 0

  // 上下文段:有窗口时显示「已用 / 窗口 (占比%)」,颜色随占比走(数字+百分比已够
  // 表达,不再放占用图形);无窗口退化为裸数字。
  const ratio =
    contextTokens !== undefined && contextWindow ? contextTokens / contextWindow : undefined
  const ctxColor = ratio !== undefined ? contextRatioColor(ratio) : undefined
  const ctxText =
    contextTokens === undefined
      ? undefined
      : ratio !== undefined
        ? `上下文 ${formatTokens(contextTokens)} / ${formatTokens(contextWindow!)} (${Math.round(ratio * 100)}%)`
        : `上下文 ${formatTokens(contextTokens)}`

  return (
    <Box justifyContent="flex-end" paddingX={1}>
      {total !== undefined && <Text dimColor>累计 {total} tokens</Text>}
      {ctxText !== undefined && (
        <>
          {total !== undefined && <Text dimColor> · </Text>}
          <Text dimColor color={ctxColor}>
            {ctxText}
          </Text>
        </>
      )}
      {cacheHit && (
        <Text dimColor>
          {' · 缓存命中 '}
          {((totalUsage?.cache_read_input_tokens ?? 0) / 1000).toFixed(1)}k
        </Text>
      )}
      {isThinking && (
        <Text dimColor color="yellow">
          {' · '}思考中…
        </Text>
      )}
    </Box>
  )
}
