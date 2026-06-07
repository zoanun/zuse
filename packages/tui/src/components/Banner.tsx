import { Box, Text } from 'ink'
import { useTerminalSize } from '../hooks/useTerminalSize.js'

interface BannerProps {
  /** 当前模型标签（provider/model 或裸模型名），由 App 传入。 */
  model: string
  /** 出站代理地址；未配置则不渲染「代理」行。 */
  proxy?: string
  /** 会话工作目录。 */
  cwd: string
  /** 可选提示行（如检测到 VSCode 系集成终端时的 /terminal-setup 引导）；无则不渲染。 */
  tip?: string
}

// 大写 Z 字形 logo：用实心块字符拼出 7 行（更高更大），块字符在主流终端字体下渲染最稳。
// 上下两道横杠占满 9 列，中间对角线自右上向左下逐行平移；每行补空格到等宽 9，保证列对齐。
const Z_LOGO: readonly string[] = [
  '█████████',
  '      ██ ',
  '     ██  ',
  '    ██   ',
  '   ██    ',
  '  ██     ',
  '█████████',
]

/**
 * 启动横幅（仿 Claude Code 的欢迎框）：随首批 <Static> 内容打进终端滚动区,只渲染一次。
 * 左侧大 Z logo,右侧依次展示模型 / 代理 / 目录与快捷键提示。
 * 因身处 <Static>（渲染一次后冻结），App 须在模型解析完成后再发出本横幅,
 * 否则会定格在初始的 unknown 模型。
 */
export function Banner({ model, proxy, cwd, tip }: BannerProps) {
  // 用上下两条横线代替圆角边框：横线是单行字符，缩放时冻结内容至多换行/留短，不会像
  // 定宽边框那样把四边 │ 错位拆碎（见 InputBox 同样处理）。横幅身处 <Static> 只渲染一次，
  // 故取挂载时列宽即可。
  const { columns } = useTerminalSize()
  const rule = '─'.repeat(Math.max(1, columns))
  return (
    <Box flexDirection="column" width="100%">
      <Text color="cyan" dimColor>
        {rule}
      </Text>
      <Box paddingX={1} alignItems="center">
        {/* 左列：大 Z logo。alignItems=center 让右侧文字相对更高的 Z 上下居中。 */}
        <Box flexDirection="column" marginRight={6}>
          {Z_LOGO.map((line, i) => (
            <Text key={i} bold color="cyan">
              {line}
            </Text>
          ))}
        </Box>
        {/* 右列：5 行信息，与 logo 的 5 行逐行对齐 */}
        <Box flexDirection="column">
          <Box>
            <Text bold color="cyan">
              Zuse
            </Text>
            <Text dimColor>{'  你的小助手'}</Text>
          </Box>
          <Box>
            <Text dimColor>{'模型  '}</Text>
            <Text color="cyan">{model}</Text>
          </Box>
          {/* 仅在配置了出站代理时渲染；未配置则整行省略，不再提示「直连」。 */}
          {proxy && (
            <Box>
              <Text dimColor>{'代理  '}</Text>
              <Text>{proxy}</Text>
            </Box>
          )}
          <Box>
            <Text dimColor>{'目录  '}</Text>
            <Text>{cwd}</Text>
          </Box>
          {/* 仅在检测到 VSCode 系集成终端时出现：引导用户先跑 /terminal-setup。 */}
          {tip && (
            <Box>
              <Text color="yellow">{'Tips  '}</Text>
              <Text dimColor>{tip}</Text>
            </Box>
          )}
          <Text dimColor>Ctrl+C 退出 · Esc 中断 · /help 命令</Text>
        </Box>
      </Box>
      <Text color="cyan" dimColor>
        {rule}
      </Text>
    </Box>
  )
}
