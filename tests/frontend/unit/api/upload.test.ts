import { buildFsusBinaryRoute, fsusBinaryRouteDescriptors } from '@/generated/fsusBinaryRoutes'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AEDS_HEADER_LENGTH, AEDS_MAGIC, AEDS_VERSION, FrameType } from '@wasm/protocol/frame'

vi.mock('@/composition/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

import { requestBinaryOnly } from '@/composition/binaryTransport'
import { completeUpload, initUploadSession, uploadPart } from '@/api/upload'

const mockBinary = vi.mocked(requestBinaryOnly)

describe('upload API requests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBinary.mockResolvedValue({} as never)
  })

  it('initUploadSession sends an UploadInitRequest AEDS frame', async () => {
    await initUploadSession({
      fileName: 'cover.png',
      mimeType: 'image/png',
      targetFormat: 'webp',
      totalBytes: 123456,
      chunkSize: 65536,
      sha256: '0123456789abcdef'
    })

    const call = mockBinary.mock.calls[0][0]
    expect(routeUrl(call)).toBe('/api/binary/upload/init')
    expect(call.frameType).toBe(FrameType.UploadInit)
    expect(fsusBinaryRouteDescriptors[call.binaryRoute.operationId].method).toBe('POST')
    expect(call.requestOptions?.headers).toMatchObject({
      'Content-Type': 'application/octet-stream'
    })

    const frame = readAedsFrame(call.requestOptions?.body)
    expect(frame.frameType).toBe(FrameType.UploadInitRequest)
    expect(frame.payload.byteLength).toBe(428)
    expect(readFixedUtf8(frame.payload, 0, 256)).toBe('cover.png')
    expect(readFixedUtf8(frame.payload, 256, 64)).toBe('image/png')
    expect(readFixedUtf8(frame.payload, 320, 32)).toBe('webp')
    expect(frame.view.getBigInt64(AEDS_HEADER_LENGTH + 352, true)).toBe(123456n)
    expect(frame.view.getInt32(AEDS_HEADER_LENGTH + 360, true)).toBe(65536)
    expect(readFixedUtf8(frame.payload, 364, 64)).toBe('0123456789abcdef')
  })

  it('uploadPart sends raw bytes with binary metadata headers', async () => {
    const chunk = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' })

    await uploadPart('upload-1', 'upload-token-1', 2, 131072, chunk, 'payload-hash')

    const call = mockBinary.mock.calls[0][0]
    expect(routeUrl(call)).toBe('/api/binary/upload/upload-1/part')
    expect(call.frameType).toBe(FrameType.UploadPartAck)
    expect(fsusBinaryRouteDescriptors[call.binaryRoute.operationId].method).toBe('PUT')
    expect(call.requestOptions?.headers).toMatchObject({
      'Content-Type': 'application/octet-stream',
      'X-Fsus-Upload-Token': 'upload-token-1',
      'X-Fsus-Upload-Part': '2',
      'X-Fsus-Upload-Offset': '131072',
      'X-Fsus-Upload-Payload-Hash': 'payload-hash'
    })
    expect(call.requestOptions?.body).toBe(chunk)
  })

  it('completeUpload sends an UploadCompleteRequest AEDS frame', async () => {
    await completeUpload('upload-1', 'upload-token-1', 'abcdef')

    const call = mockBinary.mock.calls[0][0]
    expect(routeUrl(call)).toBe('/api/binary/upload/upload-1/complete')
    expect(call.frameType).toBe(FrameType.UploadComplete)
    expect(fsusBinaryRouteDescriptors[call.binaryRoute.operationId].method).toBe('POST')
    expect(call.requestOptions?.headers).toMatchObject({
      'Content-Type': 'application/octet-stream',
      'X-Fsus-Upload-Token': 'upload-token-1'
    })

    const frame = readAedsFrame(call.requestOptions?.body)
    expect(frame.frameType).toBe(FrameType.UploadCompleteRequest)
    expect(frame.payload.byteLength).toBe(64)
    expect(readFixedUtf8(frame.payload, 0, 64)).toBe('abcdef')
  })
})

function readAedsFrame(body: BodyInit | null | undefined): {
  frameType: FrameType
  payload: Uint8Array
  view: DataView
} {
  expect(body).toBeInstanceOf(ArrayBuffer)
  const buffer = body as ArrayBuffer
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)

  expect(bytes.byteLength).toBeGreaterThanOrEqual(AEDS_HEADER_LENGTH)
  expect(view.getUint32(0, true)).toBe(AEDS_MAGIC)
  expect(view.getUint8(4)).toBe(AEDS_VERSION)
  expect(view.getUint8(5)).toBe(AEDS_HEADER_LENGTH)

  const payloadLength = view.getUint32(10, true)
  expect(bytes.byteLength).toBe(AEDS_HEADER_LENGTH + payloadLength)
  return {
    frameType: view.getUint16(8, true),
    payload: bytes.subarray(AEDS_HEADER_LENGTH),
    view
  }
}

function readFixedUtf8(bytes: Uint8Array, offset: number, length: number): string {
  const slice = bytes.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return new TextDecoder().decode(end >= 0 ? slice.subarray(0, end) : slice)
}

function routeUrl(call: Partial<import('@/contracts/binaryTransport').BinaryTransportRequest> | undefined): string | undefined {
  const route = call?.binaryRoute
  return route ? buildFsusBinaryRoute(route.operationId, route.params, route.query) : undefined
}
