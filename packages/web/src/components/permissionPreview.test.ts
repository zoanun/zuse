import { describe, it, expect } from 'vitest'
import { permissionInputPreview } from './permissionPreview.js'

/**
 * **权限卡片一直只显示 `工具名 · 限定符`。**
 *
 * 对 Bash 那是够的（限定符就是整条命令），对别的工具**不够**：
 * 独立评审指出 `Memory(save)` 那张卡上，用户看到的字面就是「Memory · save」——
 * 而这一档（必须确认）的全部价值就是「让人看一眼」。
 * 一次提示注入让模型读了个恶意 README、说「记住本项目约定」，
 * 用户看到的只有五个字，然后点了允许。
 *
 * `req.input` 一直带着完整入参（`PermissionRequest.input`），只是没人渲染。
 *
 * 判据不写成「哪些工具要显示」的清单（清单必然漂移，第七个工具出现时没人会想起来加），
 * 而是：**把值等于限定符的字段丢掉，剩下的就是限定符没说的那部分**。
 * Bash 的 `command` 因此被丢掉、`description` 留下；Write 的 `file_path` 丢掉、
 * `content` 留下；Memory 的 `action` 丢掉、`content`/`hook` 留下。
 */
describe('权限卡片的入参预览', () => {
  it('Memory(save)：限定符只说了动作，内容要显示出来', () => {
    const p = permissionInputPreview({ action: 'save', type: 'project', content: '本项目统一用 pnpm', hook: 'pnpm' }, 'save')
    expect(p).toContain('本项目统一用 pnpm')
    expect(p).toContain('pnpm')
    // action 的值就是限定符，卡上已经写了，不重复
    expect(p).not.toContain('action')
  })

  it('Bash：命令已经是限定符了，不重复显示', () => {
    const p = permissionInputPreview({ command: 'rm -rf x', description: '删掉临时目录' }, 'rm -rf x')
    expect(p).not.toContain('rm -rf x')
    expect(p).toContain('删掉临时目录')
  })

  it('Write：路径是限定符，内容要能看见（评审指出内容一直可拿但从没显示）', () => {
    const p = permissionInputPreview({ file_path: '/a/b.ts', content: 'export const x = 1' }, '/a/b.ts')
    expect(p).toContain('export const x = 1')
  })

  it('没有额外信息 → 空串，卡片不多出一个空块', () => {
    expect(permissionInputPreview({ command: 'ls' }, 'ls')).toBe('')
    expect(permissionInputPreview({}, null)).toBe('')
    expect(permissionInputPreview(null, null)).toBe('')
  })

  /** 入参是模型输出、会被打进页面与终端 —— 控制字符必须剥掉。 */
  it('剥掉控制字符', () => {
    const ESC = String.fromCharCode(27)
    const p = permissionInputPreview({ action: 'save', content: `正常${ESC}[2J文本` }, 'save')
    expect(p).not.toContain(ESC)
    expect(p).toContain('正常')
  })

  it('很长的内容要截断 —— 一张卡不能刷屏', () => {
    const p = permissionInputPreview({ action: 'save', content: 'x'.repeat(5000) }, 'save')
    expect(p.length).toBeLessThan(600)
    expect(p.endsWith('…')).toBe(true)
  })

  it('嵌套结构也能看（不是 [object Object]）', () => {
    const p = permissionInputPreview({ action: 'save', meta: { a: 1, b: 'two' } }, 'save')
    expect(p).toContain('two')
    expect(p).not.toContain('[object Object]')
  })
})
