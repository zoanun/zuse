// turndown-plugin-gfm 无官方类型声明，这里补一个最小 ambient 声明。
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown'
  /** 一次性挂载 GFM 全套规则（表格、删除线、任务列表）。 */
  export function gfm(service: TurndownService): void
}
