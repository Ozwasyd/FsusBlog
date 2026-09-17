import { describe, it, expect } from 'vitest'
import {
  encodeUtf8,
  decodeUtf8
} from '@/utils/utf8'

describe('encodeUtf8', () => {
  it('encodes ASCII text', () => {
    const result = encodeUtf8('hello')
    expect(result).toBeInstanceOf(Uint8Array)
    expect(Array.from(result)).toEqual([104, 101, 108, 108, 111])
  })

  it('encodes multibyte UTF-8', () => {
    const result = encodeUtf8('中')
    expect(result.length).toBe(3) // 中 is 3 bytes in UTF-8
  })

  it('encodes empty string', () => {
    expect(encodeUtf8('')).toHaveLength(0)
  })
})

describe('decodeUtf8', () => {
  it('decodes Uint8Array', () => {
    const bytes = new TextEncoder().encode('world')
    expect(decodeUtf8(bytes)).toBe('world')
  })

  it('decodes ArrayBuffer', () => {
    const bytes = new TextEncoder().encode('buf')
    expect(decodeUtf8(bytes.buffer)).toBe('buf')
  })

  it('round-trips through encode+decode', () => {
    const text = 'Hello, 世界!'
    expect(decodeUtf8(encodeUtf8(text))).toBe(text)
  })
})
