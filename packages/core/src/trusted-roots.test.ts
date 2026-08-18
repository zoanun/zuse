import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { isTrustedRoot, trustRoot, untrustRoot, loadTrustedRoots, trustedRootsPath } from './trusted-roots.js'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'zuse-trust-home-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

const proj = (name: string): string => {
  const p = join(home, 'projects', name)
  mkdirSync(p, { recursive: true })
  return p
}

describe('信任表：默认不信任', () => {
  it('没有记录文件 → 一律不信任（fail closed）', () => {
    expect(loadTrustedRoots(home)).toEqual([])
    expect(isTrustedRoot(proj('a'), home)).toBe(false)
  })

  /**
   * **不能回退成「全都信任」。** 那会给出一条「把这个文件写坏就能解锁全部放宽」的路 ——
   * 而放宽的那一半包含 `defaultMode:"bypass"`（关掉全部 deny/ask）。
   */
  it('记录文件写坏了 → 仍然一律不信任', () => {
    mkdirSync(join(home, '.zuse'), { recursive: true })
    writeFileSync(trustedRootsPath(home), '{ not json')
    expect(loadTrustedRoots(home)).toEqual([])
    expect(isTrustedRoot(proj('a'), home)).toBe(false)
  })

  it('roots 字段类型不对 → 不信任，也不抛', () => {
    mkdirSync(join(home, '.zuse'), { recursive: true })
    writeFileSync(trustedRootsPath(home), JSON.stringify({ roots: 'everything' }))
    expect(() => loadTrustedRoots(home)).not.toThrow()
    expect(loadTrustedRoots(home)).toEqual([])
  })
})

describe('信任 / 撤销', () => {
  it('信任之后认得出来', () => {
    const a = proj('a')
    trustRoot(a, home)
    expect(isTrustedRoot(a, home)).toBe(true)
  })

  it('只信任被点头的那一个 —— 不做前缀匹配', () => {
    const a = proj('a')
    trustRoot(a, home)
    // 纯字符串前缀的兄弟目录：`/x/a` 与 `/x/a-evil`
    const sibling = join(home, 'projects', 'a-evil')
    mkdirSync(sibling, { recursive: true })
    expect(isTrustedRoot(sibling, home), '前缀匹配会把兄弟目录一起信任').toBe(false)
    // 子目录也不顺带信任 —— 用户点头时看到的是那一个路径
    const child = join(a, 'sub')
    mkdirSync(child, { recursive: true })
    expect(isTrustedRoot(child, home)).toBe(false)
  })

  it('幂等：重复信任不写重复项', () => {
    const a = proj('a')
    trustRoot(a, home)
    trustRoot(a, home)
    expect(loadTrustedRoots(home)).toHaveLength(1)
  })

  it('撤销走得掉（只能加不能减的信任表是个陷阱）', () => {
    const a = proj('a')
    trustRoot(a, home)
    expect(isTrustedRoot(a, home)).toBe(true)
    untrustRoot(a, home)
    expect(isTrustedRoot(a, home)).toBe(false)
  })

  it('撤销一个没信任过的 → 不抛、不改文件', () => {
    const a = proj('a')
    trustRoot(a, home)
    const before = readFileSync(trustedRootsPath(home), 'utf8')
    untrustRoot(proj('never'), home)
    expect(readFileSync(trustedRootsPath(home), 'utf8')).toBe(before)
  })

  /**
   * **别把 `resolve()` 换成裸字符串比较。** 存进表里的路径来自 `findProjectRoot`
   * （Windows 上是反斜杠），而手工调 API 或写配置时给的常是正斜杠 ——
   * 两边都过 `resolve` 才对得上。去掉它的症状是「正斜杠输入永远撤不掉」，
   * 而表还在，用户会以为是撤销功能坏了。
   */
  it('正斜杠输入能撤销反斜杠存储的条目', () => {
    const a = proj('slash')
    trustRoot(a, home)
    expect(isTrustedRoot(a, home)).toBe(true)
    untrustRoot(a.split(sep).join('/'), home)
    expect(isTrustedRoot(a, home)).toBe(false)
    expect(loadTrustedRoots(home)).toHaveLength(0)
  })

  /**
   * 反过来的一侧：**表里**存的是正斜杠。这不是假想 —— 在补上撤销界面之前，
   * 手改这个 JSON 是用户唯一能撤销的办法，手写出来的路径基本都是正斜杠。
   * 所以比对时两边都得过 `resolve`，只归一化入参是不够的。
   */
  it('表里存的是正斜杠时，仍然撤得掉', () => {
    const a = proj('stored')
    mkdirSync(join(home, '.zuse'), { recursive: true })
    writeFileSync(trustedRootsPath(home), JSON.stringify({ roots: [a.split(sep).join('/')] }, null, 2), 'utf8')
    expect(isTrustedRoot(a, home)).toBe(true)
    untrustRoot(a, home)
    expect(loadTrustedRoots(home)).toHaveLength(0)
  })
})
