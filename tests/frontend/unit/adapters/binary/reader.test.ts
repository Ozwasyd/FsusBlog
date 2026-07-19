import { describe, it, expect } from 'vitest'
import {
  readInt32,
  readInt64Number,
  readByte,
  readFixedUtf8,
  readSliceRef,
  readSliceText,
  readCountChecked,
  readIsoDate64,
  readNullableId64,
  readBlobText,
  readFixedTextNullable,
  BinaryReader
} from '@/codecs/binary/reader'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function buf(size: number): Uint8Array { return new Uint8Array(size) }

function writeInt32(b: Uint8Array, off: number, v: number): void {
  b[off] = v & 0xff
  b[off + 1] = (v >>> 8) & 0xff
  b[off + 2] = (v >>> 16) & 0xff
  b[off + 3] = (v >>> 24) & 0xff
}

function writeInt64(b: Uint8Array, off: number, v: bigint): void {
  let r = v & 0xffffffffffffffffn
  for (let i = 0; i < 8; i++) { b[off + i] = Number(r & 0xffn); r >>= 8n }
}

// ---------------------------------------------------------------------------
// readInt32
// ---------------------------------------------------------------------------
describe('readInt32', () => {
  it('reads little-endian positive value', () => {
    const b = new Uint8Array([0x01, 0x00, 0x00, 0x00])
    expect(readInt32(b, 0)).toBe(1)
  })

  it('reads little-endian 0x01020304', () => {
    const b = new Uint8Array([0x04, 0x03, 0x02, 0x01])
    expect(readInt32(b, 0)).toBe(0x01020304)
  })

  it('treats out-of-bounds bytes as 0', () => {
    const b = new Uint8Array([0x05])
    expect(readInt32(b, 0)).toBe(5)
  })

  it('reads at non-zero offset', () => {
    const b = new Uint8Array([0x00, 0x07, 0x00, 0x00, 0x00])
    expect(readInt32(b, 1)).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// readInt64Number
// ---------------------------------------------------------------------------
describe('readInt64Number', () => {
  it('reads zero', () => {
    const b = buf(8)
    expect(readInt64Number(b, 0)).toBe(0)
  })

  it('reads a small positive value fitting in 32-bit low word', () => {
    const b = buf(8)
    writeInt32(b, 0, 42)
    expect(readInt64Number(b, 0)).toBe(42)
  })

  it('reads a value spanning high word', () => {
    const b = buf(8)
    // value = 1 << 33 = 8589934592
    writeInt64(b, 0, 8589934592n)
    expect(readInt64Number(b, 0)).toBe(8589934592)
  })

  it('reads negative value (sign extension via BigInt.asIntN)', () => {
    const b = buf(8)
    writeInt64(b, 0, -1n)
    expect(readInt64Number(b, 0)).toBe(-1)
  })
})

// ---------------------------------------------------------------------------
// readByte
// ---------------------------------------------------------------------------
describe('readByte', () => {
  it('reads the byte at offset', () => {
    const b = new Uint8Array([0, 255, 0])
    expect(readByte(b, 1)).toBe(255)
  })

  it('returns 0 for out-of-bounds', () => {
    const b = new Uint8Array([])
    expect(readByte(b, 0)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// readFixedUtf8
// ---------------------------------------------------------------------------
describe('readFixedUtf8', () => {
  it('reads ASCII string terminated by NUL', () => {
    const enc = new TextEncoder()
    const b = new Uint8Array(16)
    b.set(enc.encode('hello'))
    expect(readFixedUtf8(b, 0, 16)).toBe('hello')
  })

  it('reads full buffer if no NUL', () => {
    const b = new Uint8Array([65, 66, 67]) // ABC
    expect(readFixedUtf8(b, 0, 3)).toBe('ABC')
  })

  it('reads multibyte UTF-8 (2-byte char)', () => {
    const enc = new TextEncoder()
    const text = 'ç'
    const b = new Uint8Array(8)
    b.set(enc.encode(text))
    expect(readFixedUtf8(b, 0, 8)).toBe(text)
  })

  it('returns empty string for all-NUL buffer', () => {
    const b = new Uint8Array(8)
    expect(readFixedUtf8(b, 0, 8)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// readSliceRef + readSliceText
// ---------------------------------------------------------------------------
describe('readSliceRef and readSliceText', () => {
  it('readSliceRef reads offset and length', () => {
    const b = buf(8)
    writeInt32(b, 0, 10)
    writeInt32(b, 4, 5)
    const ref = readSliceRef(b, 0)
    expect(ref).toEqual({ offset: 10, length: 5 })
  })

  it('readSliceText extracts the correct substring', () => {
    const blob = new TextEncoder().encode('helloworld')
    const result = readSliceText(blob, { offset: 5, length: 5 })
    expect(result).toBe('world')
  })

  it('readSliceText returns empty string for out-of-bounds ref', () => {
    const blob = new Uint8Array([1, 2, 3])
    expect(readSliceText(blob, { offset: 10, length: 5 })).toBe('')
  })

  it('readSliceText returns empty string for negative offset', () => {
    const blob = new Uint8Array([1, 2, 3])
    expect(readSliceText(blob, { offset: -1, length: 2 })).toBe('')
  })

  it('readSliceText returns empty string for negative length', () => {
    const blob = new Uint8Array([1, 2, 3])
    expect(readSliceText(blob, { offset: 0, length: -1 })).toBe('')
  })
})

// ---------------------------------------------------------------------------
// readCountChecked
// ---------------------------------------------------------------------------
describe('readCountChecked', () => {
  it('returns count when non-negative', () => {
    const b = buf(4)
    writeInt32(b, 0, 5)
    const reader = new BinaryReader(b)
    expect(readCountChecked(reader, 'test_err')).toBe(5)
  })

  it('throws when count is negative', () => {
    const b = buf(4)
    writeInt32(b, 0, -1)
    const reader = new BinaryReader(b)
    expect(() => readCountChecked(reader, 'negative_count')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// readIsoDate64
// ---------------------------------------------------------------------------
describe('readIsoDate64', () => {
  it('converts unix ms to ISO string', () => {
    const b = buf(8)
    const ts = 1700000000000n
    writeInt64(b, 0, ts)
    const iso = readIsoDate64(b, 0)
    expect(new Date(iso).getTime()).toBe(1700000000000)
  })

  it('handles zero timestamp', () => {
    const b = buf(8)
    const iso = readIsoDate64(b, 0)
    expect(iso).toBe(new Date(0).toISOString())
  })
})

// ---------------------------------------------------------------------------
// readNullableId64
// ---------------------------------------------------------------------------
describe('readNullableId64', () => {
  it('returns null for zero value', () => {
    const b = buf(8)
    expect(readNullableId64(b, 0)).toBeNull()
  })

  it('returns string id for non-zero value', () => {
    const b = buf(8)
    writeInt64(b, 0, 42n)
    expect(readNullableId64(b, 0)).toBe('42')
  })
})

// ---------------------------------------------------------------------------
// readBlobText
// ---------------------------------------------------------------------------
describe('readBlobText', () => {
  it('reads text via slice reference in pod', () => {
    const pod = buf(16)
    const text = 'hello'
    const blob = new TextEncoder().encode(text)
    // slice at pod offset 0: { offset: 0, length: 5 }
    writeInt32(pod, 0, 0)
    writeInt32(pod, 4, text.length)
    expect(readBlobText(pod, blob, 0)).toBe('hello')
  })
})

// ---------------------------------------------------------------------------
// readFixedTextNullable
// ---------------------------------------------------------------------------
describe('readFixedTextNullable', () => {
  it('returns null for all-whitespace / empty', () => {
    const b = buf(8)
    expect(readFixedTextNullable(b, 0, 8)).toBeNull()
  })

  it('returns trimmed string when text present', () => {
    const b = new Uint8Array(8)
    b.set(new TextEncoder().encode('hi  '))
    expect(readFixedTextNullable(b, 0, 8)).toBe('hi')
  })
})

// ---------------------------------------------------------------------------
// BinaryReader
// ---------------------------------------------------------------------------
describe('BinaryReader', () => {
  it('remaining() tracks bytes consumed', () => {
    const b = buf(8)
    const r = new BinaryReader(b)
    expect(r.remaining()).toBe(8)
    r.readInt32()
    expect(r.remaining()).toBe(4)
  })

  it('readInt32 reads and advances offset', () => {
    const b = buf(8)
    writeInt32(b, 0, 100)
    writeInt32(b, 4, 200)
    const r = new BinaryReader(b)
    expect(r.readInt32()).toBe(100)
    expect(r.readInt32()).toBe(200)
  })

  it('readInt32 throws on underflow', () => {
    const r = new BinaryReader(new Uint8Array(2))
    expect(() => r.readInt32()).toThrow()
  })

  it('readInt64 reads and advances offset', () => {
    const b = buf(8)
    writeInt64(b, 0, 12345n)
    const r = new BinaryReader(b)
    expect(r.readInt64()).toBe(12345)
  })

  it('readInt64 throws on underflow', () => {
    const r = new BinaryReader(new Uint8Array(4))
    expect(() => r.readInt64()).toThrow()
  })

  it('readByte reads and advances offset', () => {
    const b = new Uint8Array([42, 7])
    const r = new BinaryReader(b)
    expect(r.readByte()).toBe(42)
    expect(r.readByte()).toBe(7)
  })

  it('readByte throws on underflow', () => {
    const r = new BinaryReader(new Uint8Array(0))
    expect(() => r.readByte()).toThrow()
  })

  it('readSpan returns slice of correct length', () => {
    const b = new Uint8Array([1, 2, 3, 4, 5])
    const r = new BinaryReader(b)
    const span = r.readSpan(3)
    expect(span).toEqual(new Uint8Array([1, 2, 3]))
    expect(r.remaining()).toBe(2)
  })

  it('readSpan throws on underflow', () => {
    const r = new BinaryReader(new Uint8Array([1]))
    expect(() => r.readSpan(4)).toThrow()
  })

  it('readSpan throws for negative length', () => {
    const r = new BinaryReader(new Uint8Array([1, 2, 3]))
    expect(() => r.readSpan(-1)).toThrow()
  })

  it('readBlob reads length-prefixed blob', () => {
    const b = buf(4 + 3)
    writeInt32(b, 0, 3)
    b[4] = 10; b[5] = 20; b[6] = 30
    const r = new BinaryReader(b)
    expect(r.readBlob()).toEqual(new Uint8Array([10, 20, 30]))
  })
})
