import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'

vi.mock('@/services/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

import { requestBinaryOnly } from '@/services/binaryTransport'
import {
  createAnonymousComment,
  createCommentV2,
  createPublicComment,
  getAnonymousCredentialCircuitSnapshot,
  getAnonymousCredentialRootSnapshot,
  getComments,
  getThreadReplies,
  getMyComments,
  issueAnonymousCommentTicket,
  deleteComment,
  encodeAnonymousCommentCreateRequest,
  encodeAnonymousCommentTicketRequest,
  encodeAnonymousCredentialIssueRequest,
  encodeAnonymousCredentialRevocationWitnessRequest,
  getAnonymousCredentialRevocationWitness,
  resolveCommentAuthorView
} from '@/api/comment'
import { COMMENT_CONTENT_CONSTRAINT } from '@/utils/contentFilter'

const mockBinary = vi.mocked(requestBinaryOnly)

const queryToString = (query: unknown): string => {
  if (query instanceof URLSearchParams) {
    return query.toString()
  }

  return new URLSearchParams(query as Record<string, string>).toString()
}

describe('comment API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBinary.mockResolvedValue({} as never)
  })

  it('createCommentV2 sends CommentCreateV2 binary mutation frame', async () => {
    const dto = {
      articleId: 1,
      content: 'Hello',
      authorMode: 'anonymous',
      publicSendExplicitlySelected: false,
      displayLanguage: 'zh-CN'
    } as const
    await createCommentV2(dto)
    const body = mockBinary.mock.calls[0][0].requestOptions?.body as ArrayBuffer

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_post_comment' },
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({
        method: 'POST',
        requiresPow: true,
        body: expect.any(ArrayBuffer)
      })
    }))
    expect(readAedsFrameType(body)).toBe(FrameType.CommentCreateV2Request)
  })

  it('createCommentV2 uses CommentCreateV2 for anonymous author fields', async () => {
    const dto = {
      articleId: 9,
      content: 'Hello anonymous mode',
      parentId: '100',
      rootId: '90',
      replyToCommentId: '80',
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

    await createCommentV2(dto as never)

    const body = mockBinary.mock.calls[0][0].requestOptions?.body as ArrayBuffer
    expect(readAedsFrameType(body)).toBe(FrameType.CommentCreateV2Request)
    const payload = readAedsPayload(body)
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    expect(view.getInt32(0, true)).toBe(9)
    expect(view.getInt32(4, true)).toBe(0)
    expect(payload[8]).toBe(1)
    expect(payload[9]).toBe(1)
    expect(payload[10]).toBe(1)
    expect(payload[11]).toBe(0)
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
      binaryRoute: { operationId: 'binary_post_comment_anonymous' },
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
    expect(call.binaryRoute).toEqual({ operationId: 'binary_post_comment' })
    expect(readAedsFrameType(body)).toBe(FrameType.CommentCreateV2Request)
    const payload = readAedsPayload(body)
    expect(payload[12]).toBe(3)
    expect(payload[13]).toBe(1)
  })

  it('encodeAnonymousCredentialIssueRequest writes a fixed POD and blob slices', () => {
    const payload = encodeAnonymousCredentialIssueRequest({
      credentialEpoch: 20260618,
      circuitNumericId: 7,
      publicInputLayoutVersion: 4,
      circuitId: 'fsus.anonymous.comment.v3',
      credentialLevel: 'strong_anonymous',
      credentialRequest: new Uint8Array([1, 2, 3]),
      clientNonce: new Uint8Array([4, 5])
    })

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    expect(view.getBigInt64(0, true)).toBe(20260618n)
    expect(view.getUint32(8, true)).toBe(7)
    expect(view.getUint16(12, true)).toBe(4)
    const blob = payload.subarray(52)
    expect(readSliceText(payload, blob, 16)).toBe('fsus.anonymous.comment.v3')
    expect(readSliceText(payload, blob, 24)).toBe('strong_anonymous')
    expect([...readSliceBytes(payload, blob, 32)]).toEqual([1, 2, 3])
    expect([...readSliceBytes(payload, blob, 40)]).toEqual([4, 5])
  })

  it('encodeAnonymousCredentialRevocationWitnessRequest writes public accumulator fields', () => {
    const payload = encodeAnonymousCredentialRevocationWitnessRequest({
      credentialEpoch: 20260618,
      circuitNumericId: 7,
      publicInputLayoutVersion: 4,
      circuitId: 'fsus.anonymous.comment.v3',
      issuerPublicKeyHash: 'issuer-hash',
      revocationRoot: new Uint8Array([1, 2, 3]),
      revocationHandleHash: new Uint8Array([4, 5, 6])
    })

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    expect(view.getBigInt64(0, true)).toBe(20260618n)
    expect(view.getUint32(8, true)).toBe(7)
    expect(view.getUint16(12, true)).toBe(4)
    const blob = payload.subarray(52)
    expect(readSliceText(payload, blob, 16)).toBe('fsus.anonymous.comment.v3')
    expect(readSliceText(payload, blob, 24)).toBe('issuer-hash')
    expect([...readSliceBytes(payload, blob, 32)]).toEqual([1, 2, 3])
    expect([...readSliceBytes(payload, blob, 40)]).toEqual([4, 5, 6])
  })

  it('encodeAnonymousCommentTicketRequest writes the full comment.v2 ticket POD without public identity', () => {
    const payload = encodeAnonymousCommentTicketRequest({
      articleId: 42,
      parentId: '100',
      rootId: '90',
      replyToCommentId: '80',
      credentialEpoch: 20260618,
      circuitNumericId: 7,
      publicInputLayoutVersion: 4,
      anonymousScope: 'article:42',
      circuitId: 'fsus.anonymous.comment.v3',
      actionContext: 'comment.create',
      verifyingKeyHash: 'a'.repeat(64),
      nullifierHash: new Uint8Array([9, 10]),
      credentialRoot: new Uint8Array([23, 24]),
      revocationRoot: new Uint8Array([25, 26]),
      credentialLevel: 'strong_anonymous',
      reputationBucket: 'rep:low',
      zkProof: new Uint8Array([11, 12]),
      publicInputs: new Uint8Array([13, 14])
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
    expect(view.getUint16(44, true)).toBe(4)
    const blob = payload.subarray(140)
    expect(readSliceText(payload, blob, 48)).toBe('comment.create')
    expect(readSliceText(payload, blob, 56)).toBe('article:42')
    expect(readSliceText(payload, blob, 64)).toBe('fsus.anonymous.comment.v3')
    expect(readSliceText(payload, blob, 72)).toBe('a'.repeat(64))
    expect([...readSliceBytes(payload, blob, 80)]).toEqual([9, 10])
    expect([...readSliceBytes(payload, blob, 88)]).toEqual([23, 24])
    expect([...readSliceBytes(payload, blob, 96)]).toEqual([25, 26])
    expect(readSliceText(payload, blob, 104)).toBe('strong_anonymous')
    expect(readSliceText(payload, blob, 112)).toBe('rep:low')
    expect([...readSliceBytes(payload, blob, 120)]).toEqual([11, 12])
    expect([...readSliceBytes(payload, blob, 128)]).toEqual([13, 14])
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

  it('requires CommentAuthorView instead of legacy username compatibility', () => {
    expect(() => resolveCommentAuthorView({})).toThrow('comment_author_contract_missing')
    expect(resolveCommentAuthorView({
      author: {
        mode: 'anonymous',
        displayName: '匿名用户 王明',
        displayLanguage: 'zh-CN',
        badge: '',
        credentialLevel: 'strong_anonymous',
        scopeLabel: '本文'
      }
    })).toEqual({
      mode: 'anonymous',
      displayName: '匿名用户 王明',
      displayLanguage: 'zh-CN',
      badge: null,
      scopeLabel: '本文',
      credentialLevel: 'strong_anonymous'
    })
  })

  it('createCommentV2 rejects over-limit content before opening binary transport', async () => {
    const dto = {
      articleId: 1,
      content: 'a'.repeat(COMMENT_CONTENT_CONSTRAINT.maxChars + 1),
      authorMode: 'anonymous',
      publicSendExplicitlySelected: false,
      displayLanguage: 'zh-CN'
    } as const

    await expect(createCommentV2(dto)).rejects.toThrow(COMMENT_CONTENT_CONSTRAINT.charLengthMessage)
    expect(mockBinary).not.toHaveBeenCalled()
  })

  it('getAnonymousCredentialRootSnapshot reads public root metadata with omitted credentials', async () => {
    await getAnonymousCredentialRootSnapshot()

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_get_anonymous_credential_root' },
      frameType: FrameType.AnonymousCredentialRootSnapshot,
      requestOptions: expect.objectContaining({
        credentials: 'omit'
      })
    }))
    expect(mockBinary.mock.calls[0][0].requestOptions?.headers).toBeUndefined()
  })

  it('getAnonymousCredentialCircuitSnapshot reads the circuit metadata alias with omitted credentials', async () => {
    await getAnonymousCredentialCircuitSnapshot()

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_get_anonymous_credential_circuit' },
      frameType: FrameType.AnonymousCredentialRootSnapshot,
      requestOptions: expect.objectContaining({
        credentials: 'omit'
      })
    }))
    expect(mockBinary.mock.calls[0][0].requestOptions?.headers).toBeUndefined()
  })

  it('issueAnonymousCommentTicket posts proof material with omitted credentials and no auth headers', async () => {
    const signal = new AbortController().signal
    await issueAnonymousCommentTicket({
      articleId: 42,
      parentId: '100',
      rootId: '90',
      replyToCommentId: '80',
      credentialEpoch: 20260618,
      circuitNumericId: 7,
      publicInputLayoutVersion: 4,
      anonymousScope: 'article:42',
      circuitId: 'fsus.anonymous.comment.v3',
      actionContext: 'comment.create',
      verifyingKeyHash: 'a'.repeat(64),
      nullifierHash: new Uint8Array([9, 10]),
      credentialRoot: new Uint8Array([23, 24]),
      revocationRoot: new Uint8Array([25, 26]),
      credentialLevel: 'strong_anonymous',
      reputationBucket: 'rep:low',
      zkProof: new Uint8Array([11, 12]),
      publicInputs: new Uint8Array([13, 14])
    }, { signal })

    const call = mockBinary.mock.calls[0][0]
    const body = call.requestOptions?.body as ArrayBuffer
    expect(call).toEqual(expect.objectContaining({
      binaryRoute: { operationId: 'binary_post_comment_anonymous_ticket' },
      frameType: FrameType.AnonymousCommentTicketResponse,
      signal,
      requestOptions: expect.objectContaining({
        method: 'POST',
        credentials: 'omit',
        body: expect.any(ArrayBuffer)
      })
    }))
    expect(call.requestOptions?.requiresPow).toBeUndefined()
    expect(call.requestOptions?.headers).toBeUndefined()
    expect(readAedsFrameType(body)).toBe(FrameType.AnonymousCommentTicketRequest)
  })

  it('getAnonymousCredentialRevocationWitness posts witness request with omitted credentials', async () => {
    const signal = new AbortController().signal
    await getAnonymousCredentialRevocationWitness({
      credentialEpoch: 20260618,
      circuitNumericId: 7,
      publicInputLayoutVersion: 4,
      circuitId: 'fsus.anonymous.comment.v3',
      issuerPublicKeyHash: 'issuer-hash',
      revocationRoot: new Uint8Array([1, 2]),
      revocationHandleHash: new Uint8Array([3, 4])
    }, { signal })

    const call = mockBinary.mock.calls[0][0]
    const body = call.requestOptions?.body as ArrayBuffer
    expect(call).toEqual(expect.objectContaining({
      binaryRoute: { operationId: 'binary_post_anonymous_credential_revocation_witness' },
      frameType: FrameType.AnonymousCredentialRevocationWitnessResponse,
      signal,
      requestOptions: expect.objectContaining({
        method: 'POST',
        credentials: 'omit',
        body: expect.any(ArrayBuffer)
      })
    }))
    expect(call.requestOptions?.requiresPow).toBeUndefined()
    expect(call.requestOptions?.headers).toBeUndefined()
    expect(readAedsFrameType(body)).toBe(FrameType.AnonymousCredentialRevocationWitnessRequest)
  })

  it('getComments does not request pow headers', async () => {
    await getComments(5)
    const call = mockBinary.mock.calls[0][0]
    expect(call.binaryRoute).toEqual(expect.objectContaining({
      operationId: 'binary_get_comment_articleId_int',
      params: { articleId: 5 }
    }))
    expect(call.requestOptions).toEqual(expect.objectContaining({ credentials: 'omit' }))
    expect(call.requestOptions?.requiresPow).toBeUndefined()
  })

  it('getComments includes cursor when provided', async () => {
    await getComments(5, 'cursor-abc')
    const call = mockBinary.mock.calls[0][0]
    expect(queryToString(call.binaryRoute?.query)).toContain('cursor=cursor-abc')
  })

  it('getComments uses default limit 10', async () => {
    await getComments(5)
    const call = mockBinary.mock.calls[0][0]
    expect(queryToString(call.binaryRoute?.query)).toContain('limit=10')
  })

  it('getThreadReplies does not request pow headers', async () => {
    await getThreadReplies(1, 'root-123')
    const call = mockBinary.mock.calls[0][0]
    expect(call.binaryRoute).toEqual(expect.objectContaining({
      operationId: 'binary_get_comment_articleId_int_thread_rootId_long',
      params: { articleId: 1, rootId: 'root-123' }
    }))
    expect(queryToString(call.binaryRoute?.query)).toContain('limit=20')
    expect(call.requestOptions).toEqual(expect.objectContaining({ credentials: 'omit' }))
    expect(call.requestOptions?.requiresPow).toBeUndefined()
  })

  it('getThreadReplies includes cursor', async () => {
    await getThreadReplies(1, 'root-123', 'cursor-xyz')
    const call = mockBinary.mock.calls[0][0]
    expect(queryToString(call.binaryRoute?.query)).toContain('cursor=cursor-xyz')
  })

  it('getMyComments calls requestBinaryOnly with user endpoint', async () => {
    await getMyComments()
    const call = mockBinary.mock.calls[0][0]
    expect(call.binaryRoute).toEqual(expect.objectContaining({
      operationId: 'binary_get_comment_me'
    }))
    expect(queryToString(call.binaryRoute?.query)).toContain('limit=10')
  })

  it('getMyComments includes cursor when provided', async () => {
    await getMyComments('my-cursor')
    const call = mockBinary.mock.calls[0][0]
    expect(queryToString(call.binaryRoute?.query)).toContain('cursor=my-cursor')
  })

  it('deleteComment sends binary delete request', async () => {
    await deleteComment('123')
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: {
        operationId: 'binary_delete_comment_id_long',
        params: { id: '123' }
      },
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
