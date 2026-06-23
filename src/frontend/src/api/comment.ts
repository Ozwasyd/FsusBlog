import type { ApiRequestConfig } from './requestConfig';
import type { PowRequest } from './auth'
import { FrameType } from '@wasm/protocol/frame';
import { requestBinaryOnly } from '@/services/binaryTransport';
import { encodeAedsFrame } from './binaryFrame';
import { validateCommentContent } from '@/utils/contentFilter';
import { AppErrorCode, createAppError } from '@/utils/appError';

// =================================================================================
// 1. 类型定义 (DTOs)
// =================================================================================

export type CommentAuthorMode = 'anonymous' | 'public' | 'zk_anonymous'
export type CommentDisplayLanguage = 'zh-CN' | 'en'

export interface CommentAuthorView {
  mode: 'anonymous' | 'public' | 'zk_anonymous'
  displayName: string
  displayLanguage: 'zh-CN' | 'en'
  badge?: string | null
  scopeLabel?: string | null
  credentialLevel?: string | null
}

/** * 发布评论所需的 DTO
 * 继承 PowRequest 以包含 nonce, salt 等字段
 */
export interface CommentDto extends PowRequest {
  articleId: number
  content: string
  parentId?: string | null
  rootId?: string | null
  replyToCommentId?: string | null
  /** @deprecated 匿名模式不应设置 replyToUserId；回复目标必须通过 replyToCommentId 和端上 nullifier/作者快照解析。 */
  replyToUserId?: number | null
  authorMode?: CommentAuthorMode | null
  publicSendExplicitlySelected?: boolean | null
  anonymousScope?: string | null
  displayLanguage?: string | null
  proofToken?: string | null
  zkProof?: Uint8Array | number[] | null
}

export interface CommentCreateV2Dto extends PowRequest {
  articleId: number
  content: string
  parentId?: string | null
  rootId?: string | null
  replyToCommentId?: string | null
  /** @deprecated 匿名模式不应设置 replyToUserId；CommentCreateV2Request POD 会固定写入 0/0 兼容占位。 */
  replyToUserId?: number | null
  authorMode: CommentAuthorMode
  publicSendExplicitlySelected: boolean
  anonymousScope?: string | null
  displayLanguage: CommentDisplayLanguage
  proofToken?: string | null
  zkProof?: Uint8Array | number[] | null
}

export interface AnonymousCommentSubmitDto {
  articleId: number
  content: string
  parentId?: string | null
  rootId?: string | null
  replyToCommentId?: string | null
  anonymousScope: string
  displayLanguage: CommentDisplayLanguage | string
}

export interface AnonymousCommentSubmitTicket {
  credentialEpoch: number
  ticket: Uint8Array | number[]
}

export type PublicCommentDto = Omit<CommentCreateV2Dto, 'authorMode' | 'publicSendExplicitlySelected'> & {
  authorMode?: CommentAuthorMode | null
  publicSendExplicitlySelected?: boolean | null
}

export interface CommentPolicySnapshot {
  anonymousCommentsEnabled: boolean
  publicCommentsEnabled: boolean
  zkAnonymousEnabled: boolean
  defaultAuthorMode: CommentAuthorMode
  supportedDisplayLanguages: string[]
  snapshotHash: string
}

export interface AnonymousCredentialIssueRequestDto {
  credentialEpoch: number
  circuitNumericId: number
  publicInputLayoutVersion: number
  circuitId: string
  credentialLevel: string
  credentialRequest: Uint8Array | number[]
  clientNonce: Uint8Array | number[]
}

export interface AnonymousCredentialIssueResponse {
  credentialEpoch: number
  rootExpiresAtUnixMs: number
  circuitNumericId: number
  publicInputLayoutVersion: number
  circuitId: string
  credentialLevel: string
  issuerPublicKeyId: string
  issuerSignature: Uint8Array
}

export interface AnonymousCredentialRootSnapshot {
  credentialEpoch: number
  rootExpiresAtUnixMs: number
  rootGraceExpiresAtUnixMs: number
  circuitNumericId: number
  publicInputLayoutVersion: number
  zkAnonymousEnabled: boolean
  verifierConfigured: boolean
  circuitId: string
  verifyingKeyHash: string
  issuerPublicKeyHash: string
  credentialRoot: Uint8Array
  revocationRoot: Uint8Array
  circuitMetadata: Uint8Array
}

export interface AnonymousCredentialRevocationWitnessRequestDto {
  credentialEpoch: number
  circuitNumericId: number
  publicInputLayoutVersion: number
  circuitId: string
  issuerPublicKeyHash: string
  revocationRoot: Uint8Array | number[]
  revocationHandleHash: Uint8Array | number[]
}

export interface AnonymousCredentialRevocationWitnessResponse {
  credentialEpoch: number
  algorithmId: string
  pathDepth: number
  revocationRoot: Uint8Array
  issuerPublicKeyHash: string
  revocationHandleHash: Uint8Array
  leafKey: Uint8Array
  witnessHash: Uint8Array
  siblingHashes: Uint8Array
}

export interface AnonymousCommentTicketRequestDto {
  articleId: number
  parentId?: string | null
  rootId?: string | null
  replyToCommentId?: string | null
  credentialEpoch: number
  circuitNumericId: number
  publicInputLayoutVersion: number
  actionContext: string
  anonymousScope: string
  circuitId: string
  verifyingKeyHash: string
  nullifierHash: Uint8Array | number[]
  credentialCommitment: Uint8Array | number[]
  credentialRoot: Uint8Array | number[]
  revocationRoot: Uint8Array | number[]
  credentialLevel: string
  reputationBucket: string
  zkProof: Uint8Array | number[]
  publicInputs: Uint8Array | number[]
}

export interface AnonymousCommentTicketResponse {
  credentialEpoch: number
  ticketExpiresAtUnixMs: number
  credentialLevel: string
  ticket: Uint8Array
  moderationSubjectHash: Uint8Array
  anonymousNullifierHash: Uint8Array
}

export interface AnonymousCommentCreateRequestDto {
  articleId: number
  content: string
  parentId?: string | null
  rootId?: string | null
  replyToCommentId?: string | null
  credentialEpoch: number
  anonymousScope: string
  displayLanguage: string
  ticket: Uint8Array | number[]
}

export interface AnonymousPrivacyStateSnapshot {
  credentialEpoch: number
  rootExpiresAtUnixMs: number
  ticketExpiresAtUnixMs: number
  circuitNumericId: number
  publicInputLayoutVersion: number
  hasActiveCredential: boolean
  canIssueCredential: boolean
  canSubmitAnonymousComment: boolean
  circuitId: string
  verifyingKeyHash: string
  credentialStatus: string
  credentialLevel: string
}

/** 游标响应包装 */
export interface CursorResponse<T> {
  data: T[]
  nextCursor: string | null // 修改：游标改为 string 以适配 Snowflake
  hasMore: boolean
}

/** 文章详情页显示的评论项 */
export interface CommentReplyItem {
  id: string // Snowflake ID 必须使用 string
  content: string
  createTime: string
  author: CommentAuthorView
  authorAccountId?: number | null
  replyToAuthor?: CommentAuthorView | null
  parentId?: string | null
  rootId: string
  replyToCommentId?: string | null
  depth: number
  isDeleted: boolean
}

export interface CommentThreadItem {
  id: string
  content: string
  createTime: string
  author: CommentAuthorView
  authorAccountId?: number | null
  rootId: string
  isDeleted: boolean
  replyCount: number
  hasMoreReplies: boolean
  repliesPreview: CommentReplyPreviewItem[]
}

export interface CommentReplyPreviewItem {
  id: string
  content: string
  createTime: string
  author: CommentAuthorView
  authorAccountId?: number | null
  replyToAuthor?: CommentAuthorView | null
  isDeleted: boolean
}

/** 个人中心显示的评论项 (包含文章信息) */
export interface UserCommentResponse {
  id: string // Snowflake ID 必须使用 string
  content: string
  createTime: string
  articleId: number
  articleTitle: string
  rootId?: string | null
  author: CommentAuthorView
  replyToAuthor?: CommentAuthorView | null
  moderationStatus: number
  moderationStatusLabel: string
  visibilityState: string
  visibilityReasonCode: string
  isPubliclyVisible: boolean
}

export function resolveCommentAuthorView(input: {
  author?: CommentAuthorView | null
}): CommentAuthorView {
  const author = input.author
  if (author?.displayName?.trim()) {
    return {
      mode: normalizeCommentAuthorMode(author.mode),
      displayName: author.displayName.trim(),
      displayLanguage: normalizeCommentDisplayLanguage(author.displayLanguage),
      badge: normalizeNullableAuthorField(author.badge),
      scopeLabel: normalizeNullableAuthorField(author.scopeLabel),
      credentialLevel: normalizeNullableAuthorField(author.credentialLevel)
    }
  }

  throw createAppError(AppErrorCode.ProtocolFailure, 'comment_author_contract_missing')
}

// =================================================================================
// 2. 接口方法
// =================================================================================

/**
 * [修复 2026-02-23] 逻辑自洽：所有方法增加可选的 config 参数以支持 AbortSignal 物理中断
 */

/** * 发布评论
 * 安全性保障：启用 requiresPow 策略，物理隔离垃圾评论攻击
 */
export const createComment = (data: CommentDto, config?: ApiRequestConfig) => {
  return sendCommentMutation(data, config)
}

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
    credentialEpoch: ticket.credentialEpoch,
    anonymousScope: data.anonymousScope,
    displayLanguage: data.displayLanguage,
    ticket: ticket.ticket
  })

  return requestBinaryOnly<null>({
    binaryRoute: { operationId: 'binary_post_comment_anonymous' },
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST',
      credentials: 'omit',
      body: encodeAedsFrame(FrameType.AnonymousCommentCreateRequest, payload)
    }
  })
}

export const createPublicComment = (data: PublicCommentDto, config?: ApiRequestConfig) => {
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

export const getAnonymousCredentialRevocationWitness = (
  data: AnonymousCredentialRevocationWitnessRequestDto,
  config?: ApiRequestConfig
) => {
  const payload = encodeAnonymousCredentialRevocationWitnessRequest(data)
  return requestBinaryOnly<AnonymousCredentialRevocationWitnessResponse>({
    binaryRoute: { operationId: 'binary_post_anonymous_credential_revocation_witness' },
    frameType: FrameType.AnonymousCredentialRevocationWitnessResponse,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST',
      credentials: 'omit',
      body: encodeAedsFrame(FrameType.AnonymousCredentialRevocationWitnessRequest, payload)
    }
  })
}

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
  data: CommentDto | CommentCreateV2Dto,
  config?: ApiRequestConfig
) {
  const validation = validateCommentContent(data.content ?? '')
  if (!validation.isValid) {
    return Promise.reject(new Error(validation.message))
  }

  const payload = encodeCommentCreateV2Request(data)

  return requestBinaryOnly<null>({
    binaryRoute: { operationId: 'binary_post_comment' },
    frameType: FrameType.EmptySuccess,
    signal: config?.signal as AbortSignal | undefined,
    requestOptions: {
      method: 'POST',
      requiresPow: true,
      body: encodeAedsFrame(FrameType.CommentCreateV2Request, payload)
    }
  })
}

/** 获取文章下的评论列表
 * 算法最优：透传 config 确保长列表加载时可被物理中断
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

/** 获取当前登录用户的可归因评论记录 */
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

export function encodeCommentCreateV2Request(data: CommentDto | CommentCreateV2Dto): Uint8Array {
  const anonymousScope = encodeText(data.anonymousScope ?? '')
  const displayLanguage = encodeText(data.displayLanguage ?? '')
  const proofToken = encodeText(data.proofToken ?? '')
  const zkProof = data.zkProof instanceof Uint8Array ? data.zkProof : new Uint8Array(data.zkProof ?? [])
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

export function encodeAnonymousCredentialRevocationWitnessRequest(data: AnonymousCredentialRevocationWitnessRequestDto): Uint8Array {
  const circuitId = encodeText(data.circuitId ?? '')
  const issuerPublicKeyHash = encodeText(data.issuerPublicKeyHash ?? '')
  const revocationRoot = bytesFrom(data.revocationRoot)
  const revocationHandleHash = bytesFrom(data.revocationHandleHash)
  const blobLength = circuitId.byteLength + issuerPublicKeyHash.byteLength + revocationRoot.byteLength + revocationHandleHash.byteLength
  const bytes = new Uint8Array(ANONYMOUS_CREDENTIAL_REVOCATION_WITNESS_REQUEST_POD_SIZE + 4 + blobLength)
  const view = new DataView(bytes.buffer)

  view.setBigInt64(0, BigInt(data.credentialEpoch ?? 0), true)
  view.setUint32(8, data.circuitNumericId ?? 0, true)
  view.setUint16(12, data.publicInputLayoutVersion ?? 0, true)
  view.setUint16(14, 0, true)

  let offset = 0
  offset = writeBlobPart(bytes, view, 16, ANONYMOUS_CREDENTIAL_REVOCATION_WITNESS_REQUEST_BLOB_START, offset, circuitId)
  offset = writeBlobPart(bytes, view, 24, ANONYMOUS_CREDENTIAL_REVOCATION_WITNESS_REQUEST_BLOB_START, offset, issuerPublicKeyHash)
  offset = writeBlobPart(bytes, view, 32, ANONYMOUS_CREDENTIAL_REVOCATION_WITNESS_REQUEST_BLOB_START, offset, revocationRoot)
  writeBlobPart(bytes, view, 40, ANONYMOUS_CREDENTIAL_REVOCATION_WITNESS_REQUEST_BLOB_START, offset, revocationHandleHash)
  view.setInt32(ANONYMOUS_CREDENTIAL_REVOCATION_WITNESS_REQUEST_POD_SIZE, blobLength, true)
  return bytes
}

export function encodeAnonymousCommentTicketRequest(data: AnonymousCommentTicketRequestDto): Uint8Array {
  const actionContext = encodeText(data.actionContext ?? 'comment.create')
  const anonymousScope = encodeText(data.anonymousScope ?? '')
  const circuitId = encodeText(data.circuitId ?? '')
  const verifyingKeyHash = encodeText(data.verifyingKeyHash ?? '')
  const nullifierHash = bytesFrom(data.nullifierHash)
  const credentialCommitment = bytesFrom(data.credentialCommitment)
  const credentialRoot = bytesFrom(data.credentialRoot)
  const revocationRoot = bytesFrom(data.revocationRoot)
  const credentialLevel = encodeText(data.credentialLevel ?? '')
  const reputationBucket = encodeText(data.reputationBucket ?? '')
  const zkProof = bytesFrom(data.zkProof)
  const publicInputs = bytesFrom(data.publicInputs)
  const blobLength = actionContext.byteLength +
    anonymousScope.byteLength +
    circuitId.byteLength +
    verifyingKeyHash.byteLength +
    nullifierHash.byteLength +
    credentialCommitment.byteLength +
    credentialRoot.byteLength +
    revocationRoot.byteLength +
    credentialLevel.byteLength +
    reputationBucket.byteLength +
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
  bytes[7] = 0
  view.setBigInt64(8, parentId ?? 0n, true)
  view.setBigInt64(16, rootId ?? 0n, true)
  view.setBigInt64(24, replyToCommentId ?? 0n, true)
  view.setBigInt64(32, BigInt(data.credentialEpoch ?? 0), true)
  view.setUint32(40, data.circuitNumericId ?? 0, true)
  view.setUint16(44, data.publicInputLayoutVersion ?? 0, true)
  view.setUint16(46, 0, true)

  let offset = 0
  offset = writeBlobPart(bytes, view, 48, ANONYMOUS_COMMENT_TICKET_REQUEST_BLOB_START, offset, actionContext)
  offset = writeBlobPart(bytes, view, 56, ANONYMOUS_COMMENT_TICKET_REQUEST_BLOB_START, offset, anonymousScope)
  offset = writeBlobPart(bytes, view, 64, ANONYMOUS_COMMENT_TICKET_REQUEST_BLOB_START, offset, circuitId)
  offset = writeBlobPart(bytes, view, 72, ANONYMOUS_COMMENT_TICKET_REQUEST_BLOB_START, offset, verifyingKeyHash)
  offset = writeBlobPart(bytes, view, 80, ANONYMOUS_COMMENT_TICKET_REQUEST_BLOB_START, offset, nullifierHash)
  offset = writeBlobPart(bytes, view, 88, ANONYMOUS_COMMENT_TICKET_REQUEST_BLOB_START, offset, credentialCommitment)
  offset = writeBlobPart(bytes, view, 96, ANONYMOUS_COMMENT_TICKET_REQUEST_BLOB_START, offset, credentialRoot)
  offset = writeBlobPart(bytes, view, 104, ANONYMOUS_COMMENT_TICKET_REQUEST_BLOB_START, offset, revocationRoot)
  offset = writeBlobPart(bytes, view, 112, ANONYMOUS_COMMENT_TICKET_REQUEST_BLOB_START, offset, credentialLevel)
  offset = writeBlobPart(bytes, view, 120, ANONYMOUS_COMMENT_TICKET_REQUEST_BLOB_START, offset, reputationBucket)
  offset = writeBlobPart(bytes, view, 128, ANONYMOUS_COMMENT_TICKET_REQUEST_BLOB_START, offset, zkProof)
  writeBlobPart(bytes, view, 136, ANONYMOUS_COMMENT_TICKET_REQUEST_BLOB_START, offset, publicInputs)
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
  view.setBigInt64(32, BigInt(data.credentialEpoch ?? 0), true)

  let offset = 0
  offset = writeBlobPart(bytes, view, 40, ANONYMOUS_COMMENT_CREATE_REQUEST_BLOB_START, offset, anonymousScope)
  offset = writeBlobPart(bytes, view, 48, ANONYMOUS_COMMENT_CREATE_REQUEST_BLOB_START, offset, displayLanguage)
  offset = writeBlobPart(bytes, view, 56, ANONYMOUS_COMMENT_CREATE_REQUEST_BLOB_START, offset, ticket)
  writeBlobPart(bytes, view, 64, ANONYMOUS_COMMENT_CREATE_REQUEST_BLOB_START, offset, content)
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

function encodeCommentAuthorMode(mode: CommentDto['authorMode'] | CommentCreateV2Dto['authorMode']): number {
  switch ((mode ?? 'anonymous').trim().toLowerCase().replace('-', '_')) {
    case 'anonymous':
      return 1
    case 'public':
      return 3
    case 'zk_anonymous':
      return 4
    default:
      throw new TypeError('comment_author_mode_invalid')
  }
}

function normalizeCommentAuthorMode(mode: CommentAuthorView['mode'] | string | null | undefined): CommentAuthorMode {
  const normalized = String(mode ?? 'anonymous').trim().toLowerCase().replace('-', '_')
  return normalized === 'public' || normalized === 'zk_anonymous' ? normalized : 'anonymous'
}

function normalizeCommentDisplayLanguage(language: CommentDisplayLanguage | string | null | undefined): CommentDisplayLanguage {
  return language === 'en' ? 'en' : 'zh-CN'
}

function normalizeNullableAuthorField(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
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
const ANONYMOUS_CREDENTIAL_REVOCATION_WITNESS_REQUEST_POD_SIZE = 48
const ANONYMOUS_CREDENTIAL_REVOCATION_WITNESS_REQUEST_BLOB_START = ANONYMOUS_CREDENTIAL_REVOCATION_WITNESS_REQUEST_POD_SIZE + 4
const ANONYMOUS_COMMENT_TICKET_REQUEST_POD_SIZE = 144
const ANONYMOUS_COMMENT_TICKET_REQUEST_BLOB_START = ANONYMOUS_COMMENT_TICKET_REQUEST_POD_SIZE + 4
const ANONYMOUS_COMMENT_CREATE_REQUEST_POD_SIZE = 72
const ANONYMOUS_COMMENT_CREATE_REQUEST_BLOB_START = ANONYMOUS_COMMENT_CREATE_REQUEST_POD_SIZE + 4
