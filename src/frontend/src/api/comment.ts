import type { ApiRequestConfig } from './requestConfig';
import { FrameType } from '@wasm/protocol/frame';
import { requestBinaryOnly } from '@/composition/binaryTransport';
import type {
  AnonymousCommentCreateRequestDto,
  AnonymousCommentSubmitDto,
  AnonymousCommentSubmitTicket,
  AnonymousCommentTicketRequestDto,
  AnonymousCommentTicketResponse,
  AnonymousCredentialIssueRequestDto,
  AnonymousCredentialIssueResponse,
  AnonymousCredentialRevocationArtifact,
  AnonymousCredentialRootSnapshot,
  AnonymousPrivacyStateSnapshot,
  BlindCredentialIssueRequestDto,
  BlindCredentialIssueResponse,
  BlindCredentialIssuerMetadata,
  CommentAuthorMode,
  CommentAuthorView,
  CommentAuthorViewMode,
  CommentCreateV2Dto,
  CommentCreateResult,
  CommentDisplayLanguage,
  CommentPolicySnapshot,
  CommentReplyItem,
  CommentReplyPreviewItem,
  CommentThreadItem,
  CursorResponse,
  PublicCommentCreateInput,
  UserCommentResponse
} from '@/contracts/binaryApi';
import { encodeAedsFrame } from './binaryFrame';
import { validateCommentContent } from '@/utils/contentFilter';

export { resolveCommentAuthorView } from '@/utils/commentAuthorView'
export type {
  AnonymousCommentCreateRequestDto,
  AnonymousCommentSubmitDto,
  AnonymousCommentSubmitTicket,
  AnonymousCommentTicketRequestDto,
  AnonymousCommentTicketResponse,
  AnonymousCredentialIssueRequestDto,
  AnonymousCredentialIssueResponse,
  AnonymousCredentialRevocationArtifact,
  AnonymousCredentialRootSnapshot,
  AnonymousPrivacyStateSnapshot,
  BlindCredentialIssueRequestDto,
  BlindCredentialIssueResponse,
  BlindCredentialIssuerMetadata,
  CommentAuthorMode,
  CommentAuthorView,
  CommentAuthorViewMode,
  CommentCreateV2Dto,
  CommentCreateResult,
  CommentDisplayLanguage,
  CommentPolicySnapshot,
  CommentReplyItem,
  CommentReplyPreviewItem,
  CommentThreadItem,
  CursorResponse,
  PublicCommentCreateInput,
  UserCommentResponse
} from '@/contracts/binaryApi'

// =================================================================================
// API methods
// =================================================================================

/**
 * 所有方法接受可选的 config.signal，以便调用方通过 AbortSignal 中断请求。
 */

export const createCommentV2 = (data: CommentCreateV2Dto, config?: ApiRequestConfig) => {
  return sendCommentMutation(data, config)
}

export const createAnonymousComment = (
  data: AnonymousCommentSubmitDto,
  ticket: AnonymousCommentSubmitTicket,
  config?: ApiRequestConfig
) => {
  const validation = validateCommentContent(data.content ?? '')
  if (!validation.isValid) {
    return Promise.reject(new Error(validation.message))
  }

  const payload = encodeAnonymousCommentCreateRequest({
    articleId: data.articleId,
    content: data.content,
    parentId: data.parentId ?? null,
    rootId: data.rootId ?? null,
    replyToCommentId: data.replyToCommentId ?? null,
    anonymousScope: data.anonymousScope,
    displayLanguage: data.displayLanguage,
    ticket: ticket.ticket
  })

  return requestBinaryOnly<CommentCreateResult>({
    binaryRoute: { operationId: 'binary_post_comment_anonymous' },
    frameType: FrameType.CommentCreateResult,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST',
      credentials: 'omit',
      body: encodeAedsFrame(FrameType.AnonymousCommentCreateRequest, payload)
    }
  })
}

export const createPublicComment = (data: PublicCommentCreateInput, config?: ApiRequestConfig) => {
  return sendCommentMutation(
    {
      ...data,
      authorMode: 'public',
      publicSendExplicitlySelected: true
    },
    config
  )
}

export const getCommentPolicySnapshot = (config?: ApiRequestConfig) =>
  requestBinaryOnly<CommentPolicySnapshot>({
    binaryRoute: { operationId: 'binary_get_comment_policy' },
    frameType: FrameType.CommentPolicySnapshot,
    signal: config?.signal as AbortSignal | undefined
  })

export const getAnonymousCredentialRootSnapshot = (config?: ApiRequestConfig) =>
  requestBinaryOnly<AnonymousCredentialRootSnapshot>({
    binaryRoute: { operationId: 'binary_get_anonymous_credential_root' },
    frameType: FrameType.AnonymousCredentialRootSnapshot,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      credentials: 'omit'
    }
  })

export const getAnonymousCredentialCircuitSnapshot = (config?: ApiRequestConfig) =>
  requestBinaryOnly<AnonymousCredentialRootSnapshot>({
    binaryRoute: { operationId: 'binary_get_anonymous_credential_circuit' },
    frameType: FrameType.AnonymousCredentialRootSnapshot,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      credentials: 'omit'
    }
  })

export const getBlindCredentialIssuerMetadata = (config?: ApiRequestConfig) =>
  requestBinaryOnly<BlindCredentialIssuerMetadata>({
    binaryRoute: { operationId: 'binary_get_anonymous_credential_blind_issuer' },
    frameType: FrameType.BlindCredentialIssuerMetadata,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      credentials: 'omit'
    }
  })

export const getAnonymousCredentialRevocationArtifact = (
  path: string,
  kind: 1 | 2,
  config?: ApiRequestConfig
) =>
  requestBinaryOnly<AnonymousCredentialRevocationArtifact>({
    binaryUrl: path,
    privateScope: 'public',
    frameType: kind === 1
      ? FrameType.AnonymousCredentialRevocationSnapshot
      : FrameType.AnonymousCredentialRevocationDelta,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'GET',
      credentials: 'omit'
    }
  })

export const issueAnonymousCommentTicket = (
  data: AnonymousCommentTicketRequestDto,
  config?: ApiRequestConfig
) => {
  const payload = encodeAnonymousCommentTicketRequest(data)
  return requestBinaryOnly<AnonymousCommentTicketResponse>({
    binaryRoute: { operationId: 'binary_post_comment_anonymous_ticket' },
    frameType: FrameType.AnonymousCommentTicketResponse,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST',
      credentials: 'omit',
      body: encodeAedsFrame(FrameType.AnonymousCommentTicketRequest, payload)
    }
  })
}

function sendCommentMutation(
  data: CommentCreateV2Dto,
  config?: ApiRequestConfig
) {
  if (data.authorMode !== 'public' || data.publicSendExplicitlySelected !== true) {
    return Promise.reject(new Error('public_opt_in_required'))
  }

  const validation = validateCommentContent(data.content ?? '')
  if (!validation.isValid) {
    return Promise.reject(new Error(validation.message))
  }

  const payload = encodeCommentCreateV2Request(data)

  return requestBinaryOnly<CommentCreateResult>({
    binaryRoute: { operationId: 'binary_post_comment' },
    frameType: FrameType.CommentCreateResult,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST',
      requiresPow: true,
      riskChallengeProof: config?.riskChallengeProof ?? undefined,
      body: encodeAedsFrame(FrameType.CommentCreateV2Request, payload)
    }
  })
}

/** 获取文章下的评论列表
 * 透传 config.signal，使调用方可中断长列表请求。
 */
export const getComments = (
  articleId: number,
  cursor?: string | null,
  limit = 10,
  config?: ApiRequestConfig
) => {
  const search = new URLSearchParams();
  if (cursor) search.set('cursor', cursor);
  search.set('limit', String(limit));

  return requestBinaryOnly<CursorResponse<CommentThreadItem>>({
    binaryRoute: {
      operationId: 'binary_get_comment_articleId_int',
      params: { articleId },
      query: search
    },
    frameType: FrameType.CommentArticleCursor,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      credentials: 'omit'
    }
  });
}

export const getThreadReplies = (
  articleId: number,
  rootId: string,
  cursor?: string | null,
  limit = 20,
  config?: ApiRequestConfig
) => {
  const search = new URLSearchParams();
  if (cursor) search.set('cursor', cursor);
  search.set('limit', String(limit));
  return requestBinaryOnly<CursorResponse<CommentReplyItem>>({
    binaryRoute: {
      operationId: 'binary_get_comment_articleId_int_thread_rootId_long',
      params: { articleId, rootId },
      query: search
    },
    frameType: FrameType.CommentThreadReplyCursor,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      credentials: 'omit'
    }
  });
}

/** 获取当前登录用户的公开评论记录 */
export const getMyComments = (
  cursor?: string | null,
  limit: number = 10,
  config?: ApiRequestConfig
) =>
  requestBinaryOnly<CursorResponse<UserCommentResponse>>({
    binaryRoute: {
      operationId: 'binary_get_comment_me',
      query: {
        ...(cursor ? { cursor } : {}),
        limit
      }
    },
    frameType: FrameType.CommentUserCursor,
    signal: config?.signal as AbortSignal | undefined
  })

/** 删除评论
 * 修改：ID 类型改为 string
 * 安全性保障：删除操作接入 PoW，防止针对他人评论的自动化遍历删除尝试
 */
export const deleteComment = (id: string, config?: ApiRequestConfig) =>
  requestBinaryOnly<null>({
    binaryRoute: {
      operationId: 'binary_delete_comment_id_long',
      params: { id }
    },
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'DELETE',
      requiresPow: true
    }
  })

export function encodeCommentCreateV2Request(data: CommentCreateV2Dto): Uint8Array {
  const anonymousScope = new Uint8Array()
  const displayLanguage = encodeText(data.displayLanguage ?? '')
  const proofToken = new Uint8Array()
  const zkProof = new Uint8Array()
  const content = encodeText(data.content ?? '')
  const blobLength = anonymousScope.byteLength + displayLanguage.byteLength + proofToken.byteLength + zkProof.byteLength + content.byteLength
  const bytes = new Uint8Array(80 + 4 + blobLength)
  const view = new DataView(bytes.buffer)
  const parentId = parseOptionalId(data.parentId)
  const rootId = parseOptionalId(data.rootId)
  const replyToCommentId = parseOptionalId(data.replyToCommentId)

  view.setInt32(0, data.articleId, true)
  view.setInt32(4, 0, true)
  bytes[8] = parentId === null ? 0 : 1
  bytes[9] = rootId === null ? 0 : 1
  bytes[10] = replyToCommentId === null ? 0 : 1
  bytes[11] = 0
  bytes[12] = encodeCommentAuthorMode(data.authorMode)
  bytes[13] = data.publicSendExplicitlySelected ? 1 : 0
  view.setUint16(14, 0, true)
  view.setBigInt64(16, parentId ?? 0n, true)
  view.setBigInt64(24, rootId ?? 0n, true)
  view.setBigInt64(32, replyToCommentId ?? 0n, true)

  let offset = 0
  offset = writeBlobPart(bytes, view, 40, 84, offset, anonymousScope)
  offset = writeBlobPart(bytes, view, 48, 84, offset, displayLanguage)
  offset = writeBlobPart(bytes, view, 56, 84, offset, proofToken)
  offset = writeBlobPart(bytes, view, 64, 84, offset, zkProof)
  writeBlobPart(bytes, view, 72, 84, offset, content)
  view.setInt32(80, blobLength, true)
  return bytes
}

export function encodeAnonymousCredentialIssueRequest(data: AnonymousCredentialIssueRequestDto): Uint8Array {
  const circuitId = encodeText(data.circuitId ?? '')
  const credentialLevel = encodeText(data.credentialLevel ?? '')
  const credentialRequest = bytesFrom(data.credentialRequest)
  const clientNonce = bytesFrom(data.clientNonce)
  const blobLength = circuitId.byteLength + credentialLevel.byteLength + credentialRequest.byteLength + clientNonce.byteLength
  const bytes = new Uint8Array(ANONYMOUS_CREDENTIAL_ISSUE_REQUEST_POD_SIZE + 4 + blobLength)
  const view = new DataView(bytes.buffer)

  view.setBigInt64(0, BigInt(data.credentialEpoch ?? 0), true)
  view.setUint32(8, data.circuitNumericId ?? 0, true)
  view.setUint16(12, data.publicInputLayoutVersion ?? 0, true)
  view.setUint16(14, 0, true)

  let offset = 0
  offset = writeBlobPart(bytes, view, 16, ANONYMOUS_CREDENTIAL_ISSUE_REQUEST_BLOB_START, offset, circuitId)
  offset = writeBlobPart(bytes, view, 24, ANONYMOUS_CREDENTIAL_ISSUE_REQUEST_BLOB_START, offset, credentialLevel)
  offset = writeBlobPart(bytes, view, 32, ANONYMOUS_CREDENTIAL_ISSUE_REQUEST_BLOB_START, offset, credentialRequest)
  writeBlobPart(bytes, view, 40, ANONYMOUS_CREDENTIAL_ISSUE_REQUEST_BLOB_START, offset, clientNonce)
  view.setInt32(ANONYMOUS_CREDENTIAL_ISSUE_REQUEST_POD_SIZE, blobLength, true)
  return bytes
}

export function encodeBlindCredentialIssueRequest(data: BlindCredentialIssueRequestDto): Uint8Array {
  const circuitId = encodeText(data.circuitId ?? '')
  const credentialLevel = encodeText(data.credentialLevel ?? '')
  const schemeId = encodeText(data.schemeId ?? '')
  const issuerPublicKeyId = encodeText(data.issuerPublicKeyId ?? '')
  const blindedMessage = bytesFrom(data.blindedMessage)
  const blobLength = circuitId.byteLength + credentialLevel.byteLength + schemeId.byteLength +
    issuerPublicKeyId.byteLength + blindedMessage.byteLength
  const bytes = new Uint8Array(BLIND_CREDENTIAL_ISSUE_REQUEST_POD_SIZE + 4 + blobLength)
  const view = new DataView(bytes.buffer)
  view.setBigInt64(0, BigInt(data.credentialEpoch ?? 0), true)
  view.setUint32(8, data.circuitNumericId ?? 0, true)
  view.setUint16(12, data.publicInputLayoutVersion ?? 0, true)
  view.setUint16(14, 0, true)
  let offset = 0
  offset = writeBlobPart(bytes, view, 16, BLIND_CREDENTIAL_ISSUE_REQUEST_BLOB_START, offset, circuitId)
  offset = writeBlobPart(bytes, view, 24, BLIND_CREDENTIAL_ISSUE_REQUEST_BLOB_START, offset, credentialLevel)
  offset = writeBlobPart(bytes, view, 32, BLIND_CREDENTIAL_ISSUE_REQUEST_BLOB_START, offset, schemeId)
  offset = writeBlobPart(bytes, view, 40, BLIND_CREDENTIAL_ISSUE_REQUEST_BLOB_START, offset, issuerPublicKeyId)
  writeBlobPart(bytes, view, 48, BLIND_CREDENTIAL_ISSUE_REQUEST_BLOB_START, offset, blindedMessage)
  view.setInt32(BLIND_CREDENTIAL_ISSUE_REQUEST_POD_SIZE, blobLength, true)
  return bytes
}

export function encodeAnonymousCommentTicketRequest(data: AnonymousCommentTicketRequestDto): Uint8Array {
  const actionContext = encodeText(data.actionContext ?? 'comment.create')
  const anonymousScope = encodeText(data.anonymousScope ?? '')
  const circuitId = encodeText(data.circuitId ?? '')
  const verifyingKeyHash = encodeText(data.verifyingKeyHash ?? '')
  const nullifierHash = bytesFrom(data.nullifierHash)
  const credentialRoot = bytesFrom(data.credentialRoot)
  const revocationRoot = bytesFrom(data.revocationRoot)
  const rateClass = encodeText(data.rateClass ?? 'unknown')
  const zkProof = bytesFrom(data.zkProof)
  const publicInputs = bytesFrom(data.publicInputs)
  const blobLength = actionContext.byteLength +
    anonymousScope.byteLength +
    circuitId.byteLength +
    verifyingKeyHash.byteLength +
    nullifierHash.byteLength +
    credentialRoot.byteLength +
    revocationRoot.byteLength +
    rateClass.byteLength +
    zkProof.byteLength +
    publicInputs.byteLength
  const bytes = new Uint8Array(ANONYMOUS_COMMENT_TICKET_REQUEST_POD_SIZE + 4 + blobLength)
  const view = new DataView(bytes.buffer)
  const parentId = parseOptionalId(data.parentId)
  const rootId = parseOptionalId(data.rootId)
  const replyToCommentId = parseOptionalId(data.replyToCommentId)

  view.setInt32(0, data.articleId, true)
  bytes[4] = parentId === null ? 0 : 1
  bytes[5] = rootId === null ? 0 : 1
  bytes[6] = replyToCommentId === null ? 0 : 1
  bytes[7] = data.isEligible ? 1 : 0
  view.setBigInt64(8, parentId ?? 0n, true)
  view.setBigInt64(16, rootId ?? 0n, true)
  view.setBigInt64(24, replyToCommentId ?? 0n, true)
  view.setUint32(32, data.circuitNumericId ?? 0, true)
  view.setUint16(36, data.publicInputLayoutVersion ?? 0, true)
  bytes[38] = data.mayComment ? 1 : 0
  bytes[39] = data.requiresModeration ? 1 : 0

  let offset = 0
  offset = writeBlobPart(bytes, view, 40, ANONYMOUS_COMMENT_TICKET_REQUEST_BLOB_START, offset, actionContext)
  offset = writeBlobPart(bytes, view, 48, ANONYMOUS_COMMENT_TICKET_REQUEST_BLOB_START, offset, anonymousScope)
  offset = writeBlobPart(bytes, view, 56, ANONYMOUS_COMMENT_TICKET_REQUEST_BLOB_START, offset, circuitId)
  offset = writeBlobPart(bytes, view, 64, ANONYMOUS_COMMENT_TICKET_REQUEST_BLOB_START, offset, verifyingKeyHash)
  offset = writeBlobPart(bytes, view, 72, ANONYMOUS_COMMENT_TICKET_REQUEST_BLOB_START, offset, nullifierHash)
  offset = writeBlobPart(bytes, view, 80, ANONYMOUS_COMMENT_TICKET_REQUEST_BLOB_START, offset, credentialRoot)
  offset = writeBlobPart(bytes, view, 88, ANONYMOUS_COMMENT_TICKET_REQUEST_BLOB_START, offset, revocationRoot)
  offset = writeBlobPart(bytes, view, 96, ANONYMOUS_COMMENT_TICKET_REQUEST_BLOB_START, offset, rateClass)
  offset = writeBlobPart(bytes, view, 104, ANONYMOUS_COMMENT_TICKET_REQUEST_BLOB_START, offset, zkProof)
  writeBlobPart(bytes, view, 112, ANONYMOUS_COMMENT_TICKET_REQUEST_BLOB_START, offset, publicInputs)
  view.setInt32(ANONYMOUS_COMMENT_TICKET_REQUEST_POD_SIZE, blobLength, true)
  return bytes
}

export function encodeAnonymousCommentCreateRequest(data: AnonymousCommentCreateRequestDto): Uint8Array {
  const anonymousScope = encodeText(data.anonymousScope ?? '')
  const displayLanguage = encodeText(data.displayLanguage ?? '')
  const ticket = bytesFrom(data.ticket)
  const content = encodeText(data.content ?? '')
  const blobLength = anonymousScope.byteLength + displayLanguage.byteLength + ticket.byteLength + content.byteLength
  const bytes = new Uint8Array(ANONYMOUS_COMMENT_CREATE_REQUEST_POD_SIZE + 4 + blobLength)
  const view = new DataView(bytes.buffer)
  const parentId = parseOptionalId(data.parentId)
  const rootId = parseOptionalId(data.rootId)
  const replyToCommentId = parseOptionalId(data.replyToCommentId)

  view.setInt32(0, data.articleId, true)
  bytes[4] = parentId === null ? 0 : 1
  bytes[5] = rootId === null ? 0 : 1
  bytes[6] = replyToCommentId === null ? 0 : 1
  bytes[7] = 0
  view.setBigInt64(8, parentId ?? 0n, true)
  view.setBigInt64(16, rootId ?? 0n, true)
  view.setBigInt64(24, replyToCommentId ?? 0n, true)
  let offset = 0
  offset = writeBlobPart(bytes, view, 32, ANONYMOUS_COMMENT_CREATE_REQUEST_BLOB_START, offset, anonymousScope)
  offset = writeBlobPart(bytes, view, 40, ANONYMOUS_COMMENT_CREATE_REQUEST_BLOB_START, offset, displayLanguage)
  offset = writeBlobPart(bytes, view, 48, ANONYMOUS_COMMENT_CREATE_REQUEST_BLOB_START, offset, ticket)
  writeBlobPart(bytes, view, 56, ANONYMOUS_COMMENT_CREATE_REQUEST_BLOB_START, offset, content)
  view.setInt32(ANONYMOUS_COMMENT_CREATE_REQUEST_POD_SIZE, blobLength, true)
  return bytes
}

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function bytesFrom(value: Uint8Array | number[] | null | undefined): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value ?? [])
}

function writeBlobPart(bytes: Uint8Array, view: DataView, sliceOffset: number, blobStart: number, offset: number, value: Uint8Array): number {
  view.setInt32(sliceOffset, offset, true)
  view.setInt32(sliceOffset + 4, value.byteLength, true)
  bytes.set(value, blobStart + offset)
  return offset + value.byteLength
}

function encodeCommentAuthorMode(mode: CommentCreateV2Dto['authorMode']): number {
  switch (mode.trim().toLowerCase().replace('-', '_')) {
    case 'public':
      return 3
    case 'zk_anonymous':
      return 4
    default:
      throw new TypeError('comment_author_mode_invalid')
  }
}

function parseOptionalId(value?: string | null): bigint | null {
  if (!value) {
    return null
  }

  try {
    const parsed = BigInt(value)
    return parsed > 0n ? parsed : null
  } catch {
    return null
  }
}

const ANONYMOUS_CREDENTIAL_ISSUE_REQUEST_POD_SIZE = 48
const ANONYMOUS_CREDENTIAL_ISSUE_REQUEST_BLOB_START = ANONYMOUS_CREDENTIAL_ISSUE_REQUEST_POD_SIZE + 4
const BLIND_CREDENTIAL_ISSUE_REQUEST_POD_SIZE = 56
const BLIND_CREDENTIAL_ISSUE_REQUEST_BLOB_START = BLIND_CREDENTIAL_ISSUE_REQUEST_POD_SIZE + 4
const ANONYMOUS_COMMENT_TICKET_REQUEST_POD_SIZE = 120
const ANONYMOUS_COMMENT_TICKET_REQUEST_BLOB_START = ANONYMOUS_COMMENT_TICKET_REQUEST_POD_SIZE + 4
const ANONYMOUS_COMMENT_CREATE_REQUEST_POD_SIZE = 64
const ANONYMOUS_COMMENT_CREATE_REQUEST_BLOB_START = ANONYMOUS_COMMENT_CREATE_REQUEST_POD_SIZE + 4
