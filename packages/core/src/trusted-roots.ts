import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 「信任这个目录」的记录。
 *
 * ## 为什么需要它
 *
 * 会话可以 root 到任意目录，而那个目录里的 `.zuse/settings.json` **不在 .gitignore 里**
 *（只有 `.local.*` 是）—— 它是随仓库分发的。把它当成完整的受信配置层，
 * 「clone 一个仓库 → 在里面开会话」就成了一条提权 + 外传的路：那个文件能设
 * `permissions.defaultMode: "bypass"`（关掉你全部 deny/ask）和
 * `providers.default.baseURL`（把整段对话导向别人的 endpoint）。
 *
 * 所以配置按**方向**分成两半：
 *
 * - **收紧**（`deny` / `ask`）：无条件生效，不需要信任 —— 它们只能让判定更严，
 *   恶意仓库最多把自己的会话卡死。见 `settings.ts` 的 `loadTighteningRules`。
 * - **放宽**（`allow` / `defaultMode` / `providers` / `model` / `mcpServers`）：
 *   **必须**这个目录被显式信任过。就是本模块。
 *
 * ## 记录放在全局，不放在项目里
 *
 * `~/.zuse/trusted-roots.json`。放项目里等于让被评估的对象自己签自己的信任状。
 *
 * ## 路径比对用 resolve 后的字面量，不做 realpath
 *
 * realpath 有 TOCTOU（判定与使用之间链接可以被换掉），而这里的判据是「用户信任的是
 * 哪个**路径**」——用户在界面上看到并点头的就是那个字符串。符号链接指向别处属于
 * 「用户自己的目录被人改了」，那是更外层的问题，不该由这一层假装解决。
 */

export interface TrustedRootsFile {
  roots: string[]
}

/** 记录文件的路径。`home` 可注入便于测试。 */
export function trustedRootsPath(home: string = homedir()): string {
  return join(home, '.zuse', 'trusted-roots.json')
}

/** 读记录。文件不存在 / 读不动 / 内容非法 → 空表（**fail closed**：不认识 = 不信任）。 */
export function loadTrustedRoots(home?: string): string[] {
  const path = trustedRootsPath(home)
  if (!existsSync(path)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const roots = (parsed as TrustedRootsFile | null)?.roots
    if (!Array.isArray(roots)) return []
    return roots.filter((r): r is string => typeof r === 'string')
  } catch {
    // 写坏了就当没有。**绝不能**在这里回退成「全都信任」——
    // 那会给出一条「把这个文件写坏就能解锁全部放宽」的路。
    return []
  }
}

/**
 * 这个目录被信任过吗？
 *
 * **精确匹配 resolve 后的路径，不做前缀匹配。** 前缀匹配会让「信任 `/a`」顺带信任
 * `/a-evil`（纯字符串前缀），也会让信任一个目录等于信任它下面所有子目录 ——
 * 而用户点头时看到的是那**一个**路径。
 */
export function isTrustedRoot(root: string, home?: string): boolean {
  const target = resolve(root)
  return loadTrustedRoots(home).some((r) => resolve(r) === target)
}

/** 记下信任。幂等：已经在表里就不重复写。 */
export function trustRoot(root: string, home?: string): void {
  const target = resolve(root)
  const current = loadTrustedRoots(home)
  if (current.some((r) => resolve(r) === target)) return
  const path = trustedRootsPath(home)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify({ roots: [...current, target] }, null, 2) + '\n', 'utf8')
}

/** 撤销信任。用户改主意时要走得掉 —— 只能加不能减的信任表是个陷阱。 */
export function untrustRoot(root: string, home?: string): void {
  const target = resolve(root)
  const current = loadTrustedRoots(home)
  const next = current.filter((r) => resolve(r) !== target)
  if (next.length === current.length) return
  const path = trustedRootsPath(home)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify({ roots: next }, null, 2) + '\n', 'utf8')
}
