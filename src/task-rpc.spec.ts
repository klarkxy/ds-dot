import { describe, expect, it } from 'vitest'
import { reviewPayload } from './task-rpc.ts'

describe('reviewPayload', () => {
  it('accepts true and false and returns them with an optional note', () => {
    expect(reviewPayload({ pass: true })).toEqual({ pass: true })
    expect(reviewPayload({ pass: false })).toEqual({ pass: false })
    expect(reviewPayload({ pass: true, note: 'looks good' })).toEqual({ pass: true, note: 'looks good' })
    expect(reviewPayload({ pass: false, note: 'missing tests' })).toEqual({ pass: false, note: 'missing tests' })
  })

  it('truncates the note to 2000 characters', () => {
    const result = reviewPayload({ pass: true, note: 'x'.repeat(3000) })
    expect(typeof result).toBe('object')
    expect((result as { note: string }).note).toHaveLength(2000)
  })

  it('rejects missing pass, string pass, number pass, and null payload', () => {
    for (const payload of [
      { id: 't-1' },           // pass absent
      { pass: 'true' },        // string
      { pass: 1 },             // number
      { pass: null },          // null
      null,                    // whole payload null
      undefined,               // whole payload undefined
      'true',                  // primitive
    ]) {
      const result = reviewPayload(payload)
      expect(typeof result).toBe('string')
    }
  })
})
