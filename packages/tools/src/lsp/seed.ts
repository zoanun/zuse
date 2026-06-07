import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** 找种子文件时直接剪枝、不下钻的目录(几乎必然巨大或与源码无关)。 */
const PRUNED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'out'])
/** 标记「一个工程根」的清单文件:含其一的目录视为独立工程,各播一个种子。 */
const MANIFESTS = new Set(['tsconfig.json', 'jsconfig.json'])
/** 遍历目录数上限:找不到也及时收手,避免在超大树上空耗。 */
const MAX_DIRS = 4000
/** 种子数上限:多包仓库也只开有限几个文件,避免一次 didOpen 过多。 */
const MAX_SEEDS = 50

/**
 * 在 root 下为「每个工程根」各挑一个代表性源文件,返回它们的绝对路径列表。
 *
 * 为什么需要:workspace/symbol(navto)在「服务器没有任何已打开文件」时没有已加载的工程,
 * tsserver 会抛 No Project;而且 navto 只在**已加载的工程**里搜。冷查询(symbol 不带 file)
 * 时,先给每个工程播一个种子文件 didOpen,服务器才会把这些工程都加载进来,navto 方能跨包命中。
 *
 * 工程根 = 含 tsconfig.json/jsconfig.json 的目录;扫描根 root 本身也算一个隐含工程根,
 * 这样无 tsconfig 的单包项目至少得到一个种子。每个工程根只取其名下首个匹配扩展名的文件
 * (用「最近祖先工程根」归属,嵌套工程各自独立)。剪掉 node_modules/.git 等噪声,设目录/种子上限。
 */
export async function findSeedFiles(
  root: string,
  extensions: string[],
  signal: AbortSignal,
): Promise<string[]> {
  const exts = new Set(extensions.map((e) => e.toLowerCase()))
  const seeds: string[] = []
  const seededRoots = new Set<string>() // 已播种的工程根,保证每根只取一个
  let visited = 0

  const walk = async (dir: string, projectRoot: string): Promise<void> => {
    if (signal.aborted || visited >= MAX_DIRS || seeds.length >= MAX_SEEDS) return
    visited++
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // 不可读目录:跳过
    }
    // 本目录含工程清单 → 它成为后续文件的归属工程根
    const hasManifest = entries.some((e) => e.isFile() && MANIFESTS.has(e.name))
    const pr = hasManifest ? dir : projectRoot

    const subdirs: string[] = []
    for (const e of entries) {
      if (e.isFile()) {
        // 该工程根尚未播种,且本文件扩展名命中 → 取之
        if (!seededRoots.has(pr)) {
          const lower = e.name.toLowerCase()
          const dot = lower.lastIndexOf('.')
          if (dot >= 0 && exts.has(lower.slice(dot))) {
            seeds.push(join(dir, e.name))
            seededRoots.add(pr)
          }
        }
      } else if (e.isDirectory() && !PRUNED_DIRS.has(e.name)) {
        subdirs.push(join(dir, e.name))
      }
    }
    for (const sd of subdirs) await walk(sd, pr)
  }

  await walk(root, root)
  return seeds
}
