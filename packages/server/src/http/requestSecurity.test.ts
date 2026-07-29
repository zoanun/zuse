import { describe, it, expect } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { isSecureRequest } from './requestSecurity.js'

/** 最小 req：encrypted 决定是否直连 TLS，headers 提供转发头。 */
const req = (opts: { encrypted?: boolean; xfp?: string | string[] } = {}): IncomingMessage =>
  ({
    socket: { encrypted: opts.encrypted },
    headers: opts.xfp === undefined ? {} : { 'x-forwarded-proto': opts.xfp },
  }) as unknown as IncomingMessage

describe('isSecureRequest', () => {
  it('直连 TLS（socket.encrypted）→ true，与 trustProxy 无关', () => {
    expect(isSecureRequest(req({ encrypted: true }), false)).toBe(true)
    expect(isSecureRequest(req({ encrypted: true }), true)).toBe(true)
  })

  it('明文且不信任代理 → false（X-Forwarded-Proto 不可伪造成加密）', () => {
    expect(isSecureRequest(req({ xfp: 'https' }), false)).toBe(false)
    expect(isSecureRequest(req(), false)).toBe(false)
  })

  it('信任代理时按 X-Forwarded-Proto 判定', () => {
    expect(isSecureRequest(req({ xfp: 'https' }), true)).toBe(true)
    expect(isSecureRequest(req({ xfp: 'http' }), true)).toBe(false)
  })

  it('逗号链取第一段（最靠近客户端的一跳）', () => {
    expect(isSecureRequest(req({ xfp: 'https, http' }), true)).toBe(true)
    expect(isSecureRequest(req({ xfp: 'http, https' }), true)).toBe(false)
  })

  it('大小写与空白不敏感；数组头取第一个；头缺失 → false', () => {
    expect(isSecureRequest(req({ xfp: '  HTTPS ' }), true)).toBe(true)
    expect(isSecureRequest(req({ xfp: ['https', 'http'] }), true)).toBe(true)
    expect(isSecureRequest(req(), true)).toBe(false)
  })
})
