import { describe, it, expect } from 'vitest'
import { badKeysForFailure, decideFailover } from './failoverCore.js'

describe('badKeysForFailure', () => {
  const models = ['m1', 'm2', 'm3']
  it('quota/unavailable 只标当前 provider/model', () => {
    expect(badKeysForFailure('p', 'm2', 'quota', models)).toEqual(['p/m2'])
    expect(badKeysForFailure('p', 'm2', 'unavailable', models)).toEqual(['p/m2'])
  })
  it('auth 标整个 provider 的所有 model', () => {
    expect(badKeysForFailure('p', 'm2', 'auth', models)).toEqual(['p/m1', 'p/m2', 'p/m3'])
  })
})

describe('decideFailover', () => {
  const models = ['m1', 'm2', 'm3']
  it('dialog 模式:总是弹框', () => {
    const bad = new Set(['p/m1'])
    expect(decideFailover({ category: 'quota', mode: 'dialog', providerId: 'p', models, currentModel: 'm1', bad })).toEqual({ kind: 'dialog' })
  })
  it('auth:即便 auto 也弹框', () => {
    const bad = new Set(['p/m1', 'p/m2', 'p/m3'])
    expect(decideFailover({ category: 'auth', mode: 'auto', providerId: 'p', models, currentModel: 'm1', bad })).toEqual({ kind: 'dialog' })
  })
  it('auto + 有下家:retry 到第一个未坏且非当前的 model(按声明顺序)', () => {
    const bad = new Set(['p/m1']) // m1 刚失败已被标坏
    expect(decideFailover({ category: 'quota', mode: 'auto', providerId: 'p', models, currentModel: 'm1', bad })).toEqual({ kind: 'retry', model: 'm2' })
  })
  it('auto + 下一个也已坏:跳过到再下一个', () => {
    const bad = new Set(['p/m1', 'p/m2'])
    expect(decideFailover({ category: 'unavailable', mode: 'auto', providerId: 'p', models, currentModel: 'm1', bad })).toEqual({ kind: 'retry', model: 'm3' })
  })
  it('auto + 同 provider 全坏:弹框', () => {
    const bad = new Set(['p/m1', 'p/m2', 'p/m3'])
    expect(decideFailover({ category: 'quota', mode: 'auto', providerId: 'p', models, currentModel: 'm3', bad })).toEqual({ kind: 'dialog' })
  })
  it('auto + provider 未声明 models(空数组):弹框', () => {
    expect(decideFailover({ category: 'quota', mode: 'auto', providerId: 'p', models: [], currentModel: 'm1', bad: new Set(['p/m1']) })).toEqual({ kind: 'dialog' })
  })
})
