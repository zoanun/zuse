import { ToolRegistry } from '@zuse/core'
import type { DefaultRegistryOptions, ToolModule } from './tool-module.js'
import { toolModule as readToolModule } from './read.js'
import { toolModule as writeToolModule } from './write.js'
import { toolModule as editToolModule } from './edit.js'
import { toolModule as globToolModule } from './glob.js'
import { toolModule as grepToolModule } from './grep.js'
import { toolModule as bashToolModule } from './bash.js'
import { toolModule as webfetchToolModule } from './webfetch.js'
import { toolModule as memoryToolModule } from './memory.js'
import { toolModule as skillToolModule } from './skills.js'
import { toolModule as websearchToolModule } from './websearch.js'
import { toolModule as lspToolModule } from './lsp/index.js'
import { toolModule as lspInstallToolModule } from './lsp/install.js'

/**
 * 内置工具集，**数组顺序即注册顺序**（须与重构前一致）。
 * 加内置工具 = 新建工具文件（导出 toolModule）+ 在此 import 并加入数组。
 * 删内置工具 = 删该文件 + 去掉这里的一行（TS 会用未解析 import 指引你）。
 */
export const BUILTIN_TOOL_MODULES: ToolModule[] = [
  readToolModule,
  writeToolModule,
  editToolModule,
  globToolModule,
  grepToolModule,
  bashToolModule,
  webfetchToolModule,
  memoryToolModule,
  skillToolModule,
  websearchToolModule,
  lspToolModule,
  lspInstallToolModule,
]

/**
 * 构建预装 v1 工具集的登记表。启用条件在各工具的 toolModule.enabled 里；缺省视为启用。
 * 行为与重构前逐一致（见 builtin-tools.test.ts 回归锁）。
 */
export function createDefaultRegistry(opts: DefaultRegistryOptions = {}): ToolRegistry {
  const registry = new ToolRegistry()
  for (const m of BUILTIN_TOOL_MODULES) {
    if (m.enabled?.(opts) ?? true) registry.register(m.make(opts))
  }
  return registry
}
