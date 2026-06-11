import { writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 把超出行内展示上限的工具完整输出落盘到系统临时目录,返回绝对路径,供终端 ctrl+点击打开。
 * 写盘失败(磁盘满 / 无权限等)返回 undefined,调用方据此回落到仅展示截断预览,不影响主流程。
 *
 * 写进 os.tmpdir()(跨平台:Windows %TEMP% / POSIX /tmp 等);启动时由 pruneOldTempFiles 主动清理 7 天前的旧文件。
 */
export function writeToolOutputFile(toolName: string, output: string): string | undefined {
  try {
    const dir = join(tmpdir(), 'zuse')
    mkdirSync(dir, { recursive: true })
    // 时间戳 + 随机后缀避免同一秒内多次调用撞名;统一 .txt 让编辑器以纯文本安全打开。
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const path = join(dir, `${toolName.toLowerCase()}-${stamp}.txt`)
    writeFileSync(path, output, 'utf8')
    return path
  } catch {
    return undefined
  }
}

const ESC = String.fromCharCode(27) // OSC 8 转义引导符(ESC)
const BEL = String.fromCharCode(7) // OSC 序列终止符(BEL)

/**
 * 把绝对路径包成 OSC 8 终端超链接,可见文字为 label。
 *
 * 「能不能点」取决于终端模拟器而非 shell:Windows Terminal、VSCode 集成终端、iTerm2、
 * 多数 Linux 终端都支持 OSC 8,可 ctrl+点击在编辑器/默认程序打开;不支持的(如旧版 conhost)
 * 会忽略这段转义,退化为纯文本展示 label —— 路径仍可见、可选中复制,不影响阅读。
 *
 * file:// URI 用 pathToFileURL 生成,自动处理 Windows 盘符与空格转义,跨平台一致。
 */
export function osc8FileLink(absPath: string, label: string): string {
  const uri = pathToFileURL(absPath).href
  return `${ESC}]8;;${uri}${BEL}${label}${ESC}]8;;${BEL}`
}

/**
 * 删除 dir 下 mtime 早于 now-maxAgeMs 的文件。
 * best-effort：目录不存在、单个文件 stat/unlink 失败（权限/被占用）均跳过、不抛。
 */
export function pruneOldTempFilesAt(dir: string, maxAgeMs: number, now: number): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return // 目录不存在等：无事可做
  }
  for (const name of names) {
    const p = join(dir, name)
    try {
      if (now - statSync(p).mtimeMs > maxAgeMs) unlinkSync(p)
    } catch {
      // 单个文件 stat/unlink 失败（权限/被占用）：跳过，不影响其他文件
    }
  }
}

/** 清理 zuse 临时目录里超龄文件（默认目录 tmpdir()/zuse）。 */
export function pruneOldTempFiles(maxAgeMs: number, now: number): void {
  pruneOldTempFilesAt(join(tmpdir(), 'zuse'), maxAgeMs, now)
}
