/**
 * 工具/助手标题行的圆点标记。
 * macOS 用 ⏺(终端里垂直对齐更好),其余平台用 ●(Windows/Linux 字体支持更稳)。
 * 对齐 cc-haha 的 figures.ts 取舍。
 */
export const BLACK_CIRCLE: string = process.platform === 'darwin' ? '⏺' : '●'
