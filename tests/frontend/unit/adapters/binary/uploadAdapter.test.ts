import { describe, it, expect } from 'vitest'
import { mapUploadInitFromPayload, mapUploadStatusFromPayload, mapUploadPartMapFromPayload, mapUploadPartAckFromPayload, mapUploadCompleteFromPayload } from '@/adapters/binary/uploadAdapter'

const encoder = new TextEncoder()

function writeFixed(bytes: Uint8Array, offset: number, length: number, value: string): void {
  bytes.set(encoder.encode(value).subarray(0, length), offset)
}

function writeInt32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setInt32(offset, value, true)
}

function writeInt64(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigInt64(offset, BigInt(value), true)
}

function unixMs(iso: string): number {
  return new Date(iso).getTime()
}

describe('mapUploadInitFromPayload', () => {
  it('deserializes upload init data', () => {
    const bytes = new Uint8Array(568)
    const data = {
      uploadId: 'uid-1',
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
      targetFormat: 'webp',
      totalBytes: 1024,
      chunkSize: 512,
      totalParts: 2,
      expiresAt: '2026-01-01T00:00:00Z',
      uploadToken: 'token-1'
    }
    writeFixed(bytes, 0, 64, data.uploadId)
    writeFixed(bytes, 64, 256, data.fileName)
    writeFixed(bytes, 320, 64, data.mimeType)
    writeFixed(bytes, 384, 32, data.targetFormat)
    writeInt64(bytes, 416, data.totalBytes)
    writeInt32(bytes, 424, data.chunkSize)
    writeInt32(bytes, 428, data.totalParts)
    writeInt64(bytes, 432, unixMs(data.expiresAt))
    writeFixed(bytes, 440, 128, data.uploadToken)

    expect(mapUploadInitFromPayload(bytes)).toEqual(data)
  })
})

describe('mapUploadStatusFromPayload', () => {
  it('deserializes upload status data', () => {
    const bytes = new Uint8Array(136)
    const data = {
      uploadId: 'uid-2',
      status: 'in_progress',
      totalBytes: 2048,
      uploadedBytes: 512,
      chunkSize: 512,
      totalParts: 4,
      uploadedPartCount: 1,
      nextPartHint: 2,
      expiresAt: '2026-01-01T00:00:00Z'
    }
    writeFixed(bytes, 0, 64, data.uploadId)
    writeFixed(bytes, 64, 32, data.status)
    writeInt64(bytes, 96, data.totalBytes)
    writeInt64(bytes, 104, data.uploadedBytes)
    writeInt32(bytes, 112, data.chunkSize)
    writeInt32(bytes, 116, data.totalParts)
    writeInt32(bytes, 120, data.uploadedPartCount)
    writeInt32(bytes, 124, data.nextPartHint)
    writeInt64(bytes, 128, unixMs(data.expiresAt))

    expect(mapUploadStatusFromPayload(bytes)).toEqual(data)
  })
})

describe('mapUploadPartMapFromPayload', () => {
  it('deserializes upload part map', () => {
    const bytes = new Uint8Array(72 + 2 * 8)
    const data = {
      uploadId: 'uid-3',
      uploadedRanges: [{ start: 0, end: 511 }, { start: 512, end: 1023 }]
    }
    writeFixed(bytes, 0, 64, data.uploadId)
    writeInt32(bytes, 64, data.uploadedRanges.length)
    writeInt32(bytes, 72, 0)
    writeInt32(bytes, 76, 511)
    writeInt32(bytes, 80, 512)
    writeInt32(bytes, 84, 1023)

    expect(mapUploadPartMapFromPayload(bytes)).toEqual(data)
  })

  it('handles empty ranges', () => {
    const bytes = new Uint8Array(72)
    const data = { uploadId: 'uid-4', uploadedRanges: [] }
    writeFixed(bytes, 0, 64, data.uploadId)
    writeInt32(bytes, 64, 0)

    expect(mapUploadPartMapFromPayload(bytes)).toEqual(data)
  })
})

describe('mapUploadPartAckFromPayload', () => {
  it('deserializes upload part ack', () => {
    const bytes = new Uint8Array(92)
    const data = {
      uploadId: 'uid-5',
      partNumber: 1,
      offset: 0,
      size: 512,
      uploadedBytes: 512,
      uploadedPartCount: 1
    }
    writeFixed(bytes, 0, 64, data.uploadId)
    writeInt32(bytes, 64, data.partNumber)
    writeInt64(bytes, 68, data.offset)
    writeInt32(bytes, 76, data.size)
    writeInt64(bytes, 80, data.uploadedBytes)
    writeInt32(bytes, 88, data.uploadedPartCount)

    expect(mapUploadPartAckFromPayload(bytes)).toEqual(data)
  })
})

describe('mapUploadCompleteFromPayload', () => {
  it('deserializes upload complete data', () => {
    const bytes = new Uint8Array(648)
    const data = {
      uploadId: 'uid-6',
      url: 'https://cdn.example.com/photo.webp',
      relativeUrl: '/uploads/photo.webp',
      mimeType: 'image/webp',
      totalBytes: 2048
    }
    writeFixed(bytes, 0, 64, data.uploadId)
    writeFixed(bytes, 64, 256, data.url)
    writeFixed(bytes, 320, 256, data.relativeUrl)
    writeFixed(bytes, 576, 64, data.mimeType)
    writeInt64(bytes, 640, data.totalBytes)

    expect(mapUploadCompleteFromPayload(bytes)).toEqual(data)
  })
})
