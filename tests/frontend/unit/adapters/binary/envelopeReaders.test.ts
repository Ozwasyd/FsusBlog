import { describe, it, expect } from 'vitest'
import { BinaryReader } from '@/adapters/binary/reader'
import {
  readPageEnvelope,
  readCursorEnvelope,
  readArrayEnvelope
} from '@/adapters/binary/envelopeReaders'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
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

/** Build a reader from a spec array:
 *   each entry is either a number (written as int32) or { i64: bigint } */
function buildReader(entries: (number | { i64: bigint } | { byte: number } | { span: number[] })[]): BinaryReader {
  // First pass: measure total size
  let size = 0
  for (const e of entries) {
    if (typeof e === 'number') size += 4
    else if ('i64' in e) size += 8
    else if ('byte' in e) size += 1
    else size += e.span.length
  }
  const b = new Uint8Array(size)
  let off = 0
  for (const e of entries) {
    if (typeof e === 'number') { writeInt32(b, off, e); off += 4 }
    else if ('i64' in e) { writeInt64(b, off, e.i64); off += 8 }
    else if ('byte' in e) { b[off] = e.byte; off += 1 }
    else { b.set(e.span, off); off += e.span.length }
  }
  return new BinaryReader(b)
}

// simple int32 item reader
function readInt32Item(r: BinaryReader): number { return r.readInt32() }

// ---------------------------------------------------------------------------
// readPageEnvelope
// ---------------------------------------------------------------------------
describe('readPageEnvelope', () => {
  it('reads empty list with total', () => {
    const r = buildReader([/* total */ 100, /* count */ 0])
    const result = readPageEnvelope(r, readInt32Item, 'err', 'trail')
    expect(result.total).toBe(100)
    expect(result.items).toEqual([])
  })

  it('reads list with items', () => {
    const r = buildReader([/* total */ 3, /* count */ 3, 10, 20, 30])
    const result = readPageEnvelope(r, readInt32Item, 'err', 'trail')
    expect(result.total).toBe(3)
    expect(result.items).toEqual([10, 20, 30])
  })

  it('throws when count is negative', () => {
    const r = buildReader([/* total */ 5, /* count */ -1])
    expect(() => readPageEnvelope(r, readInt32Item, 'bad_count', 'trail')).toThrow()
  })

  it('passes index to item reader', () => {
    const indices: number[] = []
    const r = buildReader([0, 2, 99, 88])
    readPageEnvelope(r, (reader, index) => { indices.push(index); return reader.readInt32() }, 'err', 'trail')
    expect(indices).toEqual([0, 1])
  })

  it('throws when page payload has trailing bytes', () => {
    const r = buildReader([100, 0, { byte: 1 }])
    expect(() => readPageEnvelope(r, readInt32Item, 'err', 'page_trailing')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// readCursorEnvelope
// ---------------------------------------------------------------------------
describe('readCursorEnvelope', () => {
  it('reads empty cursor with null nextCursor', () => {
    const r = buildReader([{ i64: 0n }, { byte: 0 }, /* count */ 0])
    const result = readCursorEnvelope(r, readInt32Item, 'err', 'trail')
    expect(result.nextCursor).toBeNull()
    expect(result.hasMore).toBe(false)
    expect(result.data).toEqual([])
  })

  it('reads cursor with items and nextCursor', () => {
    const r = buildReader([{ i64: 999n }, { byte: 1 }, 2, 10, 20])
    const result = readCursorEnvelope(r, readInt32Item, 'err', 'trail')
    expect(result.nextCursor).toBe('999')
    expect(result.hasMore).toBe(true)
    expect(result.data).toEqual([10, 20])
  })

  it('throws when count is negative', () => {
    const r = buildReader([{ i64: 0n }, { byte: 0 }, -1])
    expect(() => readCursorEnvelope(r, readInt32Item, 'bad', 'trail')).toThrow()
  })

  it('throws when cursor payload has trailing bytes', () => {
    const r = buildReader([{ i64: 0n }, { byte: 0 }, 0, { byte: 1 }])
    expect(() => readCursorEnvelope(r, readInt32Item, 'err', 'cursor_trailing')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// readArrayEnvelope
// ---------------------------------------------------------------------------
describe('readArrayEnvelope', () => {
  it('reads empty array', () => {
    const r = buildReader([0])
    expect(readArrayEnvelope(r, readInt32Item, 'err', 'trail')).toEqual([])
  })

  it('reads multiple items', () => {
    const r = buildReader([3, 1, 2, 3])
    expect(readArrayEnvelope(r, readInt32Item, 'err', 'trail')).toEqual([1, 2, 3])
  })

  it('throws when count is negative', () => {
    const r = buildReader([-1])
    expect(() => readArrayEnvelope(r, readInt32Item, 'bad', 'trail')).toThrow()
  })

  it('throws when array payload has trailing bytes', () => {
    const r = buildReader([0, { byte: 1 }])
    expect(() => readArrayEnvelope(r, readInt32Item, 'err', 'array_trailing')).toThrow()
  })
})
