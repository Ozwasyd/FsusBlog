import { describe, expect, it } from 'vitest'
import { decodePublicAotPayload, encodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'
import { AEDS_HEADER_LENGTH, AEDS_MAGIC, AEDS_VERSION, FrameType } from '@wasm/protocol/frame'

const DECIMAL_KIND = 8
const OBJECT_KIND = 6

describe('public AOT binary payload', () => {
  it('round-trips nested bootstrap payloads without JSON script text', () => {
    const payload = {
      kind: 'Home',
      path: '/',
      query: '',
      siteTitle: 'FsusBlog',
      total: 2,
      featured: true,
      articles: [
        {
          id: 1,
          title: 'AEDS',
          views: 42,
          tags: ['binary', 'aot']
        },
        {
          id: 2,
          title: 'Bootstrap',
          views: 7,
          tags: []
        }
      ]
    }

    const encoded = encodePublicAotPayload(payload)

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u)
    expect(decodePublicAotPayload<typeof payload>(encoded)).toEqual(payload)
  })

  it('rejects non-AEDS text', () => {
    expect(decodePublicAotPayload('{ "kind": "Home" }')).toBeNull()
  })

  it('decodes fixed-point decimal payloads without number precision drift', () => {
    const encoded = encodeDecimalFixture()

    expect(decodePublicAotPayload(encoded)).toEqual({
      scoreWeight: '0.1234567890123456789012345678',
      negativeFloor: '-0.0000000000000000000000000001'
    })
  })
})

function encodeDecimalFixture(): string {
  const payload: number[] = []
  writeByte(payload, OBJECT_KIND)
  writeInt32(payload, 2)
  writeString(payload, 'scoreWeight')
  writeByte(payload, DECIMAL_KIND)
  writeDecimal(payload, 0xbe38f34e, 0x6d797a91, 0x03fd35eb, 0x001c0000)
  writeString(payload, 'negativeFloor')
  writeByte(payload, DECIMAL_KIND)
  writeDecimal(payload, 1, 0, 0, 0x801c0000)
  const payloadBytes = new Uint8Array(payload)
  const frame = new Uint8Array(AEDS_HEADER_LENGTH + payloadBytes.byteLength)
  const view = new DataView(frame.buffer)
  view.setUint32(0, AEDS_MAGIC, true)
  view.setUint8(4, AEDS_VERSION)
  view.setUint8(5, AEDS_HEADER_LENGTH)
  view.setUint16(6, 0, true)
  view.setUint16(8, FrameType.PublicAotBootstrap, true)
  view.setUint32(10, payloadBytes.byteLength, true)
  view.setUint16(14, crc16(payloadBytes), true)
  frame.set(payloadBytes, AEDS_HEADER_LENGTH)
  return toBase64Url(frame)
}

function writeDecimal(target: number[], lo: number, mid: number, hi: number, flags: number): void {
  writeInt32(target, lo)
  writeInt32(target, mid)
  writeInt32(target, hi)
  writeInt32(target, flags)
}

function writeString(target: number[], value: string): void {
  const bytes = new TextEncoder().encode(value)
  writeInt32(target, bytes.byteLength)
  target.push(...bytes)
}

function writeInt32(target: number[], value: number): void {
  const normalized = value >>> 0
  target.push(normalized & 0xff, (normalized >>> 8) & 0xff, (normalized >>> 16) & 0xff, (normalized >>> 24) & 0xff)
}

function writeByte(target: number[], value: number): void {
  target.push(value & 0xff)
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function crc16(bytes: Uint8Array): number {
  let crc = 0xffff
  for (let i = 0; i < bytes.byteLength; i += 1) {
    crc ^= bytes[i] ?? 0
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1)
    }
  }
  return crc & 0xffff
}
