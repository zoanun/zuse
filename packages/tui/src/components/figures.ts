/**
 * 工具/助手标题行的圆点标记。
 * macOS 用 ⏺(终端里垂直对齐更好),其余平台用 ●(Windows/Linux 字体支持更稳)。
 * 对齐 cc-haha 的 figures.ts 取舍。
 */
export const BLACK_CIRCLE: string = process.platform === 'darwin' ? '⏺' : '●'

/** 工具结果行的「拐角」前缀(挂在标题行下方),对齐 cc-haha 的 ⎿ 树枝符。 */
export const L_CORNER: string = '⎿'
