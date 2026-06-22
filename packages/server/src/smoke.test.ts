import { describe, it, expect } from 'vitest'
import { SERVER_PACKAGE } from './index.js'

describe('@zuse/server', () => {
  it('package barrel loads', () => {
    expect(SERVER_PACKAGE).toBe('@zuse/server')
  })
})
