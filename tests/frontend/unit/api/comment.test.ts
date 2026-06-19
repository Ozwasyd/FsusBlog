import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'

vi.mock('@/services/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

import { requestBinaryOnly } from '@/services/binaryTransport'
import {
  createAnonymousComment,
  createComment,
  createCommentV2,
  createPublicComment,
  getAnonymousCredentialCircuitSnapshot,
  getAnonymousCredentialRootSnapshot,
  getComments,
  getThreadReplies,
  getMyComments,
  deleteComment,
  encodeAnonymousCommentCreateRequest,
  encodeAnonymousCommentTicketRequest,
  encodeAnonymousCredentialIssueRequest,
  resolveCommentAuthorView
} from '@/api/comment'
import { COMMENT_CONTENT_CONSTRAINT } from '@/utils/contentFilter'

const mockBinary = vi.mocked(requestBinaryOnly)

describe('comment API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBinary.mockResolvedValue({} as never)
  })

  it('createComment sends binary mutation frame', async () => {
    const dto = { articleId: 1, content: 'Hello', nonce: 'n', salt: 's', answer: 1 }
    await createComment(dto as never)
    const body = mockBinary.mock.calls[0][0].requestOptions?.body as ArrayBuffer

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/comment',
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({
        method: 'POST',
        requiresPow: true,
        body: expect.any(ArrayBuffer)
      })
    }))
    expect(readAedsFrameType(body)).toBe(FrameType.CommentCreateRequest)
  })

  it('createComment uses CommentCreateV2 for anonymous author fields', async () => {
    const dto = {
      articleId: 9,
      content: 'Hello anonymous mode',
      parentId: '100',
      rootId: '90',
      replyToCommentId: '80',
      replyToUserId: 7,
      authorMode: 'zk_anonymous',
      publicSendExplicitlySelected: false,
      anonymousScope: 'article:9:root:90',
      displayLanguage: 'zh-CN',
      proofToken: 'proof-token',
      zkProof: new Uint8Array([1, 2, 3, 4]),
      nonce: 'n',
      salt: 's',
      answer: 1
    }

    await createComment(dto as never)

    const body = mockBinary.mock.calls[0][0].requestOptions?.body as ArrayBuffer
    expect(readAedsFrameType(body)).toBe(FrameType.CommentCreateV2Request)
    const payload = readAedsPayload(body)
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    expect(view.getInt32(0, true)).toBe(9)
    expect(view.getInt32(4, true)).toBe(7)
    expect(payload[8]).toBe(1)
    expect(payload[9]).toBe(1)
    expect(payload[10]).toBe(1)
    expect(payload[11]).toBe(1)
    expect(payload[12]).toBe(4)
    expect(payload[13]).toBe(0)
    expect(view.getBigInt64(16, true)).toBe(100n)
    expect(view.getBigInt64(24, true)).toBe(90n)
    expect(view.getBigInt64(32, true)).toBe(80n)
    const blob = payload.subarray(84)
    expect(readSliceText(payload, blob, 40)).toBe('article:9:root:90')
    expect(readSliceText(payload, blob, 48)).toBe('zh-CN')
    expect(readSliceText(payload, blob, 56)).toBe('proof-token')
    expect([...readSliceBytes(payload, blob, 64)]).toEqual([1, 2, 3, 4])
    expect(readSliceText(payload, blob, 72)).toBe('Hello anonymous mode')
  })

  it('createCommentV2 always sends public-send and author-mode fields', async () => {
    await createCommentV2({
      articleId: 10,
      content: 'Public comment with explicit consent',
      authorMode: 'public',
      publicSendExplicitlySelected: true,
      anonymousScope: 'article:10',
      displayLanguage: 'en'
    })

    const body = mockBinary.mock.calls[0][0].requestOptions?.body as ArrayBuffer
    expect(readAedsFrameType(body)).toBe(FrameType.CommentCreateV2Request)
    const payload = readAedsPayload(body)
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    expect(view.getInt32(0, true)).toBe(10)
    expect(payload[12]).toBe(3)
    expect(payload[13]).toBe(1)
    const blob = payload.subarray(84)
    expect(readSliceText(payload, blob, 40)).toBe('article:10')
    expect(readSliceText(payload, blob, 48)).toBe('en')
  })

  it('createAnonymousComment posts an AnonymousCommentCreateRequest with omitted credentials', async () => {
    const signal = new AbortController().signal
    await createAnonymousComment(
      {
        articleId: 42,
        content: 'anonymous comment',
        parentId: '100',
        rootId: '90',
        replyToCommentId: '80',
        anonymousScope: 'article:42',
        displayLanguage: 'zh-CN'
      },
      {
        credentialEpoch: 20260618,
        ticket: new Uint8Array([31, 32])
      },
      { signal }
    )

    const call = mockBinary.mock.calls[0][0]
    const body = call.requestOptions?.body as ArrayBuffer
    expect(call).toEqual(expect.objectContaining({
      binaryUrl: '/api/binary/comment/anonymous',
      frameType: FrameType.EmptySuccess,
      signal,
      requestOptions: expect.objectContaining({
        method: 'POST',
        credentials: 'omit',
        body: expect.any(ArrayBuffer)
      })
    }))
    expect(call.requestOptions?.requiresPow).toBeUndefined()
    expect(call.requestOptions?.headers).toBeUndefined()
    expect(readAedsFrameType(body)).toBe(FrameType.AnonymousCommentCreateRequest)

    const payload = readAedsPayload(body)
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    expect(view.getInt32(0, true)).toBe(42)
    expect(payload[4]).toBe(1)
    expect(payload[5]).toBe(1)
    expect(payload[6]).toBe(1)
    expect(view.getBigInt64(8, true)).toBe(100n)
    expect(view.getBigInt64(16, true)).toBe(90n)
    expect(view.getBigInt64(24, true)).toBe(80n)
    expect(view.getBigInt64(32, true)).toBe(20260618n)
    const blob = payload.subarray(76)
    expect(readSliceText(payload, blob, 40)).toBe('article:42')
    expect(readSliceText(payload, blob, 48)).toBe('zh-CN')
    expect([...readSliceBytes(payload, blob, 56)]).toEqual([31, 32])
    expect(readSliceText(payload, blob, 64)).toBe('anonymous comment')
  })

  it('createPublicComment forces public author mode and explicit opt-in', async () => {
    await createPublicComment({
      articleId: 10,
      content: 'Public comment with explicit consent',
      authorMode: 'anonymous',
      publicSendExplicitlySelected: false,
      anonymousScope: 'article:10',
      displayLanguage: 'en'
    } as never)

    const call = mockBinary.mock.calls[0][0]
    const body = call.requestOptions?.body as ArrayBuffer
    expect(call.binaryUrl).toBe('/api/binary/comment')
    expect(readAedsFrameType(body)).toBe(FrameType.CommentCreateV2Request)
    const payload = readAedsPayload(body)
    expect(payload[12]).toBe(3)
    expect(payload[13]).toBe(1)
  })

  it('encodeAnonymousCredentialIssueRequest writes a fixed POD and blob slices', () => {
    const payload = encodeAnonymousCredentialIssueRequest({
      credentialEpoch: 20260618,
      circuitNumericId: 7,
      publicInputLayoutVersion: 2,
      circuitId: 'zk-comment-v1',
      credentialLevel: 'strong_anonymous',
      blindedRequest: new Uint8Array([1, 2, 3]),
      clientNonce: new Uint8Array([4, 5])
    })

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    expect(view.getBigInt64(0, true)).toBe(20260618n)
    expect(view.getUint32(8, true)).toBe(7)
    expect(view.getUint16(12, true)).toBe(2)
    const blob = payload.subarray(52)
    expect(readSliceText(payload, blob, 16)).toBe('zk-comment-v1')
    expect(readSliceText(payload, blob, 24)).toBe('strong_anonymous')
    expect([...readSliceBytes(payload, blob, 32)]).toEqual([1, 2, 3])
    expect([...readSliceBytes(payload, blob, 40)]).toEqual([4, 5])
  })

  it('encodeAnonymousCommentTicketRequest writes proof fields without public identity', () => {
    const payload = encodeAnonymousCommentTicketRequest({
      articleId: 42,
      parentId: '100',
      rootId: '90',
      replyToCommentId: '80',
      credentialEpoch: 20260618,
      circuitNumericId: 7,
      publicInputLayoutVersion: 2,
      anonymousScope: 'article:42',
      displayLanguage: 'zh-CN',
      circuitId: 'zk-comment-v1',
      nullifierHash: new Uint8Array([9, 10]),
      zkProof: new Uint8Array([11, 12]),
      publicInputs: new Uint8Array([13, 14]),
      replyToUserId: 123,
      publicHandle: 'alice'
    } as never)

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    expect(view.getInt32(0, true)).toBe(42)
    expect(payload[4]).toBe(1)
    expect(payload[5]).toBe(1)
    expect(payload[6]).toBe(1)
    expect(view.getBigInt64(8, true)).toBe(100n)
    expect(view.getBigInt64(16, true)).toBe(90n)
    expect(view.getBigInt64(24, true)).toBe(80n)
    expect(view.getBigInt64(32, true)).toBe(20260618n)
    expect(view.getUint32(40, true)).toBe(7)
    expect(view.getUint16(44, true)).toBe(2)
    const blob = payload.subarray(100)
    expect(readSliceText(payload, blob, 48)).toBe('article:42')
    expect(readSliceText(payload, blob, 56)).toBe('zh-CN')
    expect(readSliceText(payload, blob, 64)).toBe('zk-comment-v1')
    expect([...readSliceBytes(payload, blob, 72)]).toEqual([9, 10])
    expect([...readSliceBytes(payload, blob, 80)]).toEqual([11, 12])
    expect([...readSliceBytes(payload, blob, 88)]).toEqual([13, 14])
    expect(new TextDecoder().decode(payload)).not.toContain('alice')
  })

  it('encodeAnonymousCommentCreateRequest has no user id, username, token, or public handle slot', () => {
    const payload = encodeAnonymousCommentCreateRequest({
      articleId: 42,
      content: 'anonymous comment',
      parentId: '100',
      rootId: '90',
      replyToCommentId: '80',
      credentialEpoch: 20260618,
      anonymousScope: 'article:42',
      displayLanguage: 'en',
      ticket: new Uint8Array([31, 32]),
      userId: 7,
      username: 'Alice',
      authorization: 'Bearer token',
      publicHandle: 'alice'
    } as never)

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    expect(view.getInt32(0, true)).toBe(42)
    expect(payload[4]).toBe(1)
    expect(payload[5]).toBe(1)
    expect(payload[6]).toBe(1)
    expect(view.getBigInt64(8, true)).toBe(100n)
    expect(view.getBigInt64(16, true)).toBe(90n)
    expect(view.getBigInt64(24, true)).toBe(80n)
    expect(view.getBigInt64(32, true)).toBe(20260618n)
    const blob = payload.subarray(76)
    expect(readSliceText(payload, blob, 40)).toBe('article:42')
    expect(readSliceText(payload, blob, 48)).toBe('en')
    expect([...readSliceBytes(payload, blob, 56)]).toEqual([31, 32])
    expect(readSliceText(payload, blob, 64)).toBe('anonymous comment')
    const raw = new TextDecoder().decode(payload)
    expect(raw).not.toContain('Alice')
    expect(raw).not.toContain('Bearer token')
    expect(raw).not.toContain('alice')
  })

  it('resolves legacy usernames through CommentAuthorView compatibility', () => {
    expect(resolveCommentAuthorView({ userName: 'Alice' })).toEqual({
      mode: 'public',
      displayName: 'Alice',
      displayLanguage: 'zh-CN',
      badge: 'legacy',
      scopeLabel: 'fixture compatibility'
    })
    expect(resolveCommentAuthorView({
      author: {
        mode: 'anonymous',
        displayName: '匿名用户 王明',
        displayLanguage: 'zh-CN',
        scopeLabel: '本文'
      },
      userName: 'Alice'
    }).displayName).toBe('匿名用户 王明')
  })

  it('createComment rejects over-limit content before opening binary transport', async () => {
    const dto = { articleId: 1, content: 'a'.repeat(COMMENT_CONTENT_CONSTRAINT.maxChars + 1), nonce: 'n', salt: 's', answer: 1 }

    await expect(createComment(dto as never)).rejects.toThrow(COMMENT_CONTENT_CONSTRAINT.charLengthMessage)
    expect(mockBinary).not.toHaveBeenCalled()
  })

  it('getAnonymousCredentialRootSnapshot reads public root metadata without credentials options', async () => {
    await getAnonymousCredentialRootSnapshot()

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/anonymous-credential/root',
      frameType: FrameType.AnonymousCredentialRootSnapshot
    }))
    expect(mockBinary.mock.calls[0][0].requestOptions).toBeUndefined()
  })

  it('getAnonymousCredentialCircuitSnapshot reads the circuit metadata alias', async () => {
    await getAnonymousCredentialCircuitSnapshot()

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/anonymous-credential/circuit',
      frameType: FrameType.AnonymousCredentialRootSnapshot
    }))
    expect(mockBinary.mock.calls[0][0].requestOptions).toBeUndefined()
  })

  it('getComments calls requestBinaryOnly with articleId', async () => {
    await getComments(5)
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: expect.stringContaining('/api/binary/comment/5'),
      requestOptions: expect.objectContaining({ requiresPow: true })
    }))
  })

  it('getComments includes cursor when provided', async () => {
    await getComments(5, 'cursor-abc')
    const call = mockBinary.mock.calls[0][0]
    expect(call.binaryUrl).toContain('cursor=cursor-abc')
  })

  it('getComments uses default limit 10', async () => {
    await getComments(5)
    const call = mockBinary.mock.calls[0][0]
    expect(call.binaryUrl).toContain('limit=10')
  })

  it('getThreadReplies calls requestBinaryOnly with articleId and rootId', async () => {
    await getThreadReplies(1, 'root-123')
    const call = mockBinary.mock.calls[0][0]
    expect(call.binaryUrl).toContain('/api/binary/comment/1/thread/root-123')
    expect(call.binaryUrl).toContain('limit=20')
    expect(call.requestOptions).toEqual(expect.objectContaining({ requiresPow: true }))
  })

  it('getThreadReplies includes cursor', async () => {
    await getThreadReplies(1, 'root-123', 'cursor-xyz')
    const call = mockBinary.mock.calls[0][0]
    expect(call.binaryUrl).toContain('cursor=cursor-xyz')
  })

  it('getMyComments calls requestBinaryOnly with user endpoint', async () => {
    await getMyComments()
    const call = mockBinary.mock.calls[0][0]
    expect(call.binaryUrl).toContain('/api/binary/comment/me')
    expect(call.binaryUrl).toContain('limit=10')
  })

  it('getMyComments includes cursor when provided', async () => {
    await getMyComments('my-cursor')
    const call = mockBinary.mock.calls[0][0]
    expect(call.binaryUrl).toContain('cursor=my-cursor')
  })

  it('deleteComment sends binary delete request', async () => {
    await deleteComment('123')
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/comment/123',
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({
        method: 'DELETE',
        requiresPow: true
      })
    }))
  })
})

function readAedsFrameType(buffer: ArrayBuffer): number {
  return new DataView(buffer).getUint16(8, true)
}

function readAedsPayload(buffer: ArrayBuffer): Uint8Array {
  const bytes = new Uint8Array(buffer)
  const length = new DataView(buffer).getUint32(10, true)
  return bytes.subarray(16, 16 + length)
}

function readSliceBytes(payload: Uint8Array, blob: Uint8Array, sliceOffset: number): Uint8Array {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const offset = view.getInt32(sliceOffset, true)
  const length = view.getInt32(sliceOffset + 4, true)
  return blob.subarray(offset, offset + length)
}

function readSliceText(payload: Uint8Array, blob: Uint8Array, sliceOffset: number): string {
  return new TextDecoder().decode(readSliceBytes(payload, blob, sliceOffset))
}
