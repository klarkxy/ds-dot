import { describe, expect, it } from 'vitest'
import { jsonArray } from './work-actions.ts'

describe('jsonArray', () => {
  it('parses ordinary arrays and array values', () => {
    expect(jsonArray(['a'])).toEqual(['a'])
    expect(jsonArray('["a",2]')).toEqual(['a', 2])
    expect(jsonArray('')).toBeUndefined()
    expect(jsonArray('{"a":1}')).toBeUndefined()
  })

  it('repairs a complete array followed only by stray closing brackets', () => {
    expect(jsonArray('["one","two"]]}')).toEqual(['one', 'two'])
    expect(jsonArray(' ["brackets [ in string ]", {"x": [1]}] \n]}')).toEqual(['brackets [ in string ]', { x: [1] }])
  })

  it('still rejects trailing content and malformed arrays', () => {
    expect(jsonArray('["one"] trailing')).toBeUndefined()
    expect(jsonArray('["one"')).toBeUndefined()
    expect(jsonArray('not json')).toBeUndefined()
  })
})
