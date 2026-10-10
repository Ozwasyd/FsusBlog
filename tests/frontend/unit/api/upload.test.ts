import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AEDS_HEADER_LENGTH, AEDS_MAGIC, AEDS_VERSION, FrameType } from '@wasm/protocol/frame'

vi.mock('@/composition/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

import { requestBinaryOnly } from '@/composition/binaryTransport'
import { abortUpload, completeUpload, initUploadSession, uploadPart } from '@/api/upload'

import { decode } from '@wasm/aeds'
import { encodeAedsFrame } from '@/api/binaryFrame'
import { privateRequestRuntime } from '@/services/privateRequestRuntime'

vi.mock('@/composables/usePow', () => ({
  usePow: () => ({ calculate: vi.fn().mockResolvedValue({ nonce: 'ordinary-test-nonce', duration: 1 }) })
}))
vi.mock('@/utils/fingerprint', () => ({ getBrowserFp: () => 'ordinary-test-browser' }))

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
    expect(call.binaryUrl).toBe('/api/binary/upload/init')
    expect(call.frameType).toBe(FrameType.UploadInit)
    expect(call.requestOptions?.method).toBe('POST')
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
    expect(call.binaryUrl).toBe('/api/binary/upload/upload-1/part')
    expect(call.frameType).toBe(FrameType.UploadPartAck)
    expect(call.requestOptions?.method).toBe('PUT')
    expect(call.requestOptions?.headers).toMatchObject({
      'Content-Type': 'application/octet-stream',
      'X-Fsus-Upload-Token': 'upload-token-1',
      'X-Fsus-Upload-Part': '2',
      'X-Fsus-Upload-Offset': '131072',
      'X-Fsus-Upload-Payload-Hash': 'payload-hash'
    })
    expect(call.requestOptions?.body).toBe(chunk)
  })

  it('abort forwards the optional third token without changing its existing signal contract', async () => {
    const signal = new AbortController().signal
    await abortUpload('upload-1', signal, 'original-init-token')
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/upload/upload-1', privateScope: 'admin', signal,
      frameType: FrameType.UploadStatus,
      requestOptions: { method: 'DELETE', requiresPow: true,
        headers: { 'X-Fsus-Upload-Token': 'original-init-token' } }
    }))
    await abortUpload('upload-1', signal)
    expect(mockBinary.mock.lastCall?.[0].requestOptions?.headers).toBeUndefined()
  })

  it('completeUpload sends an UploadCompleteRequest AEDS frame', async () => {
    await completeUpload('upload-1', 'upload-token-1', 'abcdef')

    const call = mockBinary.mock.calls[0][0]
    expect(call.binaryUrl).toBe('/api/binary/upload/upload-1/complete')
    expect(call.frameType).toBe(FrameType.UploadComplete)
    expect(call.requestOptions?.method).toBe('POST')
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

// Ordinary native-decoder fixture boundary; the API, transport, headers and fetch path are real.
function transportFrame(frameType: FrameType, uploadId = 'upload-1', status = 'aborted') {
  const bytes = new Uint8Array(frameType === FrameType.UploadStatus ? 136 : 584)
  const put = (offset: number, size: number, value: string) => bytes.set(new TextEncoder().encode(value).subarray(0, size), offset)
  if (frameType === FrameType.UploadStatus) {
    put(0, 64, uploadId); put(64, 32, status)
  } else {
    bytes[0] = 1; bytes[1] = 1
    new DataView(bytes.buffer).setInt32(4, 403, true)
    put(8, 256, 'original-abort-denied'); put(264, 256, 'ordinary-test-denial'); put(520, 64, 'ordinary-trace')
  }
  return encodeAedsFrame(frameType, bytes)
}

function ordinaryPowFrame() {
  const bytes = new Uint8Array(204)
  bytes.set(new TextEncoder().encode('ordinary-salt'), 0)
  bytes.set(new TextEncoder().encode('ordinary-signature'), 76)
  return encodeAedsFrame(FrameType.PowChallenge, bytes)
}

describe('abort API through the actual binary transport and intercepted fetch', () => {
  beforeEach(async () => {
    privateRequestRuntime.resetForTests()
    const actual = await vi.importActual<typeof import('@/composition/binaryTransport')>('@/composition/binaryTransport')
    mockBinary.mockImplementation(actual.requestBinaryOnly)
    vi.mocked(decode).mockImplementation(buffer => {
      const bytes = new Uint8Array(buffer), view = new DataView(buffer)
      if (view.getUint32(0, true) !== AEDS_MAGIC || view.getUint8(4) !== AEDS_VERSION)
        throw new Error('invalid ordinary AEDS fixture')
      const payloadView = bytes.subarray(AEDS_HEADER_LENGTH)
      return { ok: true, frameType: view.getUint16(8, true), payload: payloadView, payloadView, textBlob: '', error: '' }
    })
  })
  afterEach(() => { vi.unstubAllGlobals(); privateRequestRuntime.resetForTests() })

  it.each(['aborted', 'uploading'])('forwards the original token to DELETE and decodes the actual %s response', async status => {
    const intercepted = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/auth/pow-challenge')) return new Response(ordinaryPowFrame())
      expect(new URL(url).pathname).toBe('/api/binary/upload/upload-1')
      expect(init?.method).toBe('DELETE')
      expect(init?.credentials).toBe('include')
      const headers = new Headers(init?.headers)
      expect(headers.get('X-Fsus-Upload-Token')).toBe('original-init-token')
      expect(headers.get('X-Fsus-Pow-Proof')).toBeTruthy()
      return new Response(transportFrame(FrameType.UploadStatus, 'upload-1', status))
    })
    vi.stubGlobal('fetch', intercepted)
    await expect(abortUpload('upload-1', undefined, 'original-init-token')).resolves.toMatchObject({ uploadId: 'upload-1', status })
    expect(intercepted).toHaveBeenCalledTimes(2)
  })

  it('propagates a genuinely decoded ApiError instead of an abort acknowledgement', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/auth/pow-challenge')
      ? new Response(ordinaryPowFrame()) : new Response(transportFrame(FrameType.ApiError), { status: 403 })))
    await expect(abortUpload('upload-1', undefined, 'original-init-token')).rejects.toMatchObject({
      name: 'BinaryTransportError', message: expect.stringContaining('original-abort-denied'), status: 403
    })
  })

  it('propagates an actual intercepted DELETE network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/auth/pow-challenge')) return new Response(ordinaryPowFrame())
      throw new Error('ordinary-delete-network-failure')
    }))
    await expect(abortUpload('upload-1', undefined, 'original-init-token')).rejects.toThrow('ordinary-delete-network-failure')
  })
})
