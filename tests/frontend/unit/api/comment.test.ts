import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'

vi.mock('@/composition/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

import { requestBinaryOnly } from '@/composition/binaryTransport'
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
  issueCommentManagementChallenge,
  editCommentAsAuthor,
  deleteAnonymousComment,
  deleteCommentAsAuthor,
  getAnonymousCommentStatus,
  appealAnonymousComment,
  deleteComment,
  encodeAnonymousCommentCreateRequest,
  encodeAnonymousCommentTicketRequest,
  getAnonymousCredentialRevocationArtifact,
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
      clientMutationId: '018ff005-1234-7abc-8def-0123456789ab',
      articleId: 1,
      content: 'Hello',
      authorMode: 'public',
      publicSendExplicitlySelected: true,
      displayLanguage: 'zh-CN'
    } as const
    await createCommentV2(dto)
    const body = mockBinary.mock.calls[0][0].requestOptions?.body as ArrayBuffer

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_post_comment' },
      frameType: FrameType.CommentCreateResult,
      requestOptions: expect.objectContaining({
        method: 'POST',
        requiresPow: true,
        headers: {
          'X-Fsus-Client-Mutation-Id': '018ff005-1234-7abc-8def-0123456789ab'
        },
        body: expect.any(ArrayBuffer)
      })
    }))
    expect(readAedsFrameType(body)).toBe(FrameType.CommentCreateV2Request)
  })

  it('createCommentV2 rejects a non-canonical mutation identity before transport', async () => {
    expect(() => createCommentV2({
      clientMutationId: 'comment-42-retry',
      articleId: 42,
      content: 'same draft retry',
      authorMode: 'public',
      publicSendExplicitlySelected: true,
      displayLanguage: 'zh-CN'
    })).toThrow('comment_client_mutation_id_invalid')
    expect(mockBinary).not.toHaveBeenCalled()
  })

  it('reuses the same public mutation identity after a lost response', async () => {
    const dto = {
      clientMutationId: '018ff005-1234-7abc-8def-0123456789ab',
      articleId: 42,
      content: 'retry the same public intent',
      authorMode: 'public',
      publicSendExplicitlySelected: true,
      displayLanguage: 'zh-CN'
    } as const
    mockBinary.mockRejectedValueOnce({
      name: 'BinaryTransportError',
      kind: 'network',
      message: 'response lost'
    })

    await expect(createCommentV2(dto)).rejects.toMatchObject({ kind: 'network' })
    mockBinary.mockResolvedValueOnce({ commentId: '101' } as never)
    await createCommentV2(dto)

    expect(mockBinary).toHaveBeenCalledTimes(2)
    expect(mockBinary.mock.calls.map(call => call[0].requestOptions?.headers)).toEqual([
      { 'X-Fsus-Client-Mutation-Id': dto.clientMutationId },
      { 'X-Fsus-Client-Mutation-Id': dto.clientMutationId }
    ])
  })

  it('createCommentV2 keeps retired anonymous wire slots empty for public writes', async () => {
    const dto = {
      articleId: 9,
      content: 'Hello anonymous mode',
      parentId: '100',
      rootId: '90',
      replyToCommentId: '80',
      authorMode: 'public',
      publicSendExplicitlySelected: true,
      displayLanguage: 'zh-CN',
      nonce: 'n',
      salt: 's',
      answer: 1
    } as const

    await createCommentV2(dto)

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
    expect(payload[12]).toBe(3)
    expect(payload[13]).toBe(1)
    expect(view.getBigInt64(16, true)).toBe(100n)
    expect(view.getBigInt64(24, true)).toBe(90n)
    expect(view.getBigInt64(32, true)).toBe(80n)
    const blob = payload.subarray(84)
    expect(readSliceText(payload, blob, 40)).toBe('')
    expect(readSliceText(payload, blob, 48)).toBe('zh-CN')
    expect(readSliceText(payload, blob, 56)).toBe('')
    expect([...readSliceBytes(payload, blob, 64)]).toEqual([])
    expect(readSliceText(payload, blob, 72)).toBe('Hello anonymous mode')
  })

  it('createCommentV2 always sends public-send and author-mode fields', async () => {
    await createCommentV2({
      articleId: 10,
      content: 'Public comment with explicit consent',
      authorMode: 'public',
      publicSendExplicitlySelected: true,
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
    expect(readSliceText(payload, blob, 40)).toBe('')
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
        ticket: new Uint8Array([31, 32])
      },
      { signal }
    )

    const call = mockBinary.mock.calls[0][0]
    const body = call.requestOptions?.body as ArrayBuffer
    expect(call).toEqual(expect.objectContaining({
      binaryRoute: { operationId: 'binary_post_comment_anonymous' },
      frameType: FrameType.AnonymousCommentCreateResult,
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
    const blob = payload.subarray(68)
    expect(readSliceText(payload, blob, 32)).toBe('article:42')
    expect(readSliceText(payload, blob, 40)).toBe('zh-CN')
    expect([...readSliceBytes(payload, blob, 48)]).toEqual([31, 32])
    expect(readSliceText(payload, blob, 56)).toBe('anonymous comment')
  })

  it('retries one anonymous response loss with the exact same ticket commitment', async () => {
    mockBinary
      .mockRejectedValueOnce({ name: 'BinaryTransportError', kind: 'network', message: 'response lost' })
      .mockResolvedValueOnce({ commentId: '102', idempotencyReplay: true } as never)

    await createAnonymousComment(
      {
        articleId: 42,
        content: 'anonymous response loss',
        anonymousScope: 'comment:v1:article:42:top',
        displayLanguage: 'zh-CN'
      },
      { ticket: new Uint8Array(32).fill(7) }
    )

    expect(mockBinary).toHaveBeenCalledTimes(2)
    const firstBody = new Uint8Array(mockBinary.mock.calls[0][0].requestOptions?.body as ArrayBuffer)
    const secondBody = new Uint8Array(mockBinary.mock.calls[1][0].requestOptions?.body as ArrayBuffer)
    expect(secondBody).toEqual(firstBody)
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

  it('encodeAnonymousCommentTicketRequest writes the v5 minimal-predicate ticket POD without exact attributes', () => {
    const payload = encodeAnonymousCommentTicketRequest({
      articleId: 42,
      parentId: '100',
      rootId: '90',
      replyToCommentId: '80',
      circuitNumericId: 7,
      publicInputLayoutVersion: 6,
      anonymousScope: 'article:42',
      circuitId: 'fsus.anonymous.comment.v5',
      actionContext: 'comment.create',
      verifyingKeyHash: 'a'.repeat(64),
      nullifierHash: new Uint8Array([9, 10]),
      credentialRoot: new Uint8Array([23, 24]),
      revocationRoot: new Uint8Array([25, 26]),
      isEligible: true,
      mayComment: true,
      rateClass: 'common',
      requiresModeration: false,
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
    expect(view.getUint32(32, true)).toBe(7)
    expect(view.getUint16(36, true)).toBe(6)
    expect(payload[38]).toBe(1)
    expect(payload[39]).toBe(0)
    const blob = payload.subarray(124)
    expect(readSliceText(payload, blob, 40)).toBe('comment.create')
    expect(readSliceText(payload, blob, 48)).toBe('article:42')
    expect(readSliceText(payload, blob, 56)).toBe('fsus.anonymous.comment.v5')
    expect(readSliceText(payload, blob, 64)).toBe('a'.repeat(64))
    expect([...readSliceBytes(payload, blob, 72)]).toEqual([9, 10])
    expect([...readSliceBytes(payload, blob, 80)]).toEqual([23, 24])
    expect([...readSliceBytes(payload, blob, 88)]).toEqual([25, 26])
    expect(readSliceText(payload, blob, 96)).toBe('common')
    expect([...readSliceBytes(payload, blob, 104)]).toEqual([11, 12])
    expect([...readSliceBytes(payload, blob, 112)]).toEqual([13, 14])
    expect(new TextDecoder().decode(payload)).not.toContain('alice')
  })

  it('encodeAnonymousCommentCreateRequest has no user id, username, token, or public handle slot', () => {
    const payload = encodeAnonymousCommentCreateRequest({
      articleId: 42,
      content: 'anonymous comment',
      parentId: '100',
      rootId: '90',
      replyToCommentId: '80',
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
    const blob = payload.subarray(68)
    expect(readSliceText(payload, blob, 32)).toBe('article:42')
    expect(readSliceText(payload, blob, 40)).toBe('en')
    expect([...readSliceBytes(payload, blob, 48)]).toEqual([31, 32])
    expect(readSliceText(payload, blob, 56)).toBe('anonymous comment')
    const raw = new TextDecoder().decode(payload)
    expect(raw).not.toContain('Alice')
    expect(raw).not.toContain('Bearer token')
    expect(raw).not.toContain('alice')
  })

  it('requires CommentAuthorView instead of legacy username compatibility', () => {
    expect(() => resolveCommentAuthorView({})).toThrow('comment_author_contract_missing')
    expect(resolveCommentAuthorView({
      author: {
        mode: 'legacy_server_visible_pseudonymous',
        displayName: '匿名用户 王明',
        displayLanguage: 'zh-CN',
        badge: '',
        scopeLabel: '本文'
      }
    })).toEqual({
      mode: 'legacy_server_visible_pseudonymous',
      displayName: '匿名用户 王明',
      displayLanguage: 'zh-CN',
      badge: null,
      scopeLabel: '本文'
    })
  })

  it('createCommentV2 rejects over-limit content before opening binary transport', async () => {
    const dto = {
      articleId: 1,
      content: 'a'.repeat(COMMENT_CONTENT_CONSTRAINT.maxChars + 1),
      authorMode: 'public',
      publicSendExplicitlySelected: true,
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
      publicInputLayoutVersion: 6,
      anonymousScope: 'article:42',
      circuitId: 'fsus.anonymous.comment.v5',
      actionContext: 'comment.create',
      verifyingKeyHash: 'a'.repeat(64),
      nullifierHash: new Uint8Array([9, 10]),
      credentialRoot: new Uint8Array([23, 24]),
      revocationRoot: new Uint8Array([25, 26]),
      isEligible: true,
      mayComment: true,
      rateClass: 'common',
      requiresModeration: false,
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
    const payload = readAedsPayload(body)
    expect(payload[7]).toBe(1)
    expect(payload[38]).toBe(1)
    expect(payload[39]).toBe(0)
    expect(readSliceText(payload, payload.subarray(124), 96)).toBe('common')
  })

  it('uses the same bodyless public artifact transcript for every credential', async () => {
    const signal = new AbortController().signal
    const path = `/api/binary/anonymous-credential/revocation/20260618/4/${'ab'.repeat(32)}/full.aeds`
    await getAnonymousCredentialRevocationArtifact(path, 1, { signal })
    await getAnonymousCredentialRevocationArtifact(path, 1, { signal })

    expect(mockBinary.mock.calls).toHaveLength(2)
    for (const [call] of mockBinary.mock.calls) expect(call).toEqual(expect.objectContaining({
      binaryUrl: path,
      frameType: FrameType.AnonymousCredentialRevocationSnapshot,
      signal,
      requestOptions: expect.objectContaining({
        method: 'GET',
        credentials: 'omit'
      })
    }))
    expect(mockBinary.mock.calls[0][0].requestOptions?.body).toBeUndefined()
    expect(mockBinary.mock.calls[0][0]).toEqual(mockBinary.mock.calls[1][0])
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

  it.each([
    {
      name: 'anonymous challenge',
      invoke: () => issueCommentManagementChallenge('123', 'edit', 'secret-123'),
      operationId: 'binary_post_comment_id_long_management_challenge',
      requestFrame: FrameType.CommentManagementChallengeRequest,
      responseFrame: FrameType.CommentManagementChallengeResponse,
      privateScope: 'public',
      credentials: 'omit',
      payload: { purpose: 'edit', capabilitySecret: 'secret-123' }
    },
    {
      name: 'account challenge',
      invoke: () => issueCommentManagementChallenge('123', 'delete', null),
      operationId: 'binary_post_comment_id_long_author_challenge',
      requestFrame: FrameType.CommentManagementChallengeRequest,
      responseFrame: FrameType.CommentManagementChallengeResponse,
      privateScope: 'account',
      credentials: 'include',
      payload: { purpose: 'delete', capabilitySecret: null }
    },
    {
      name: 'anonymous edit',
      invoke: () => editCommentAsAuthor('123', { expectedVersion: 2, content: 'edited', challenge: 'challenge', capabilitySecret: 'secret-123' }),
      operationId: 'binary_post_comment_id_long_management_edit',
      requestFrame: FrameType.CommentAuthorEditRequest,
      responseFrame: FrameType.CommentAuthorMutationResult,
      privateScope: 'public',
      credentials: 'omit',
      payload: { expectedVersion: 2, content: 'edited', challenge: 'challenge', capabilitySecret: 'secret-123' }
    },
    {
      name: 'anonymous delete',
      invoke: () => deleteAnonymousComment('123', 'secret-123', 'challenge'),
      operationId: 'binary_post_comment_id_long_management_delete',
      requestFrame: FrameType.CommentAuthorStatusRequest,
      responseFrame: FrameType.CommentAuthorMutationResult,
      privateScope: 'public',
      credentials: 'omit',
      payload: { capabilitySecret: 'secret-123', challenge: 'challenge' }
    },
    {
      name: 'account delete',
      invoke: () => deleteCommentAsAuthor('123', 'challenge'),
      operationId: 'binary_post_comment_id_long_author_delete',
      requestFrame: FrameType.CommentAuthorStatusRequest,
      responseFrame: FrameType.CommentAuthorMutationResult,
      privateScope: 'account',
      credentials: 'include',
      payload: { challenge: 'challenge', capabilitySecret: '' }
    },
    {
      name: 'anonymous status',
      invoke: () => getAnonymousCommentStatus('123', 'secret-123', 'challenge'),
      operationId: 'binary_post_comment_id_long_management_status',
      requestFrame: FrameType.CommentAuthorStatusRequest,
      responseFrame: FrameType.CommentAuthorStatusResult,
      privateScope: 'public',
      credentials: 'omit',
      payload: { capabilitySecret: 'secret-123', challenge: 'challenge' }
    },
    {
      name: 'anonymous appeal',
      invoke: () => appealAnonymousComment('123', 'secret-123', 'challenge', 'please review'),
      operationId: 'binary_post_comment_id_long_management_appeal',
      requestFrame: FrameType.CommentAuthorAppealRequest,
      responseFrame: FrameType.CommentAuthorMutationResult,
      privateScope: 'public',
      credentials: 'omit',
      payload: { capabilitySecret: 'secret-123', challenge: 'challenge', reason: 'please review' }
    }
  ])('sends $name as a no-store JSON AEDS request', async ({
    invoke,
    operationId,
    requestFrame,
    responseFrame,
    privateScope,
    credentials,
    payload
  }) => {
    await invoke()

    const call = mockBinary.mock.calls[0][0]
    const body = call.requestOptions?.body as ArrayBuffer
    expect(call).toEqual(expect.objectContaining({
      binaryRoute: { operationId, params: { id: '123' } },
      privateScope,
      frameType: responseFrame,
      requestOptions: expect.objectContaining({
        method: 'POST',
        cache: 'no-store',
        credentials,
        body: expect.any(ArrayBuffer)
      })
    }))
    expect(readAedsFrameType(body)).toBe(requestFrame)
    expect(JSON.parse(new TextDecoder().decode(readAedsPayload(body)))).toEqual(payload)
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
