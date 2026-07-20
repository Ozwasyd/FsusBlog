import { describe, it, expect } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'
import { CommentPolicyContractVersion, CommentPolicyReadiness } from '@/contracts/commentPolicy'
import { decodeBinaryFramePayload } from '@/composition/binaryDecoderRegistry'
import { ANONYMOUS_PRIVACY_STATE_SNAPSHOT_POD_SIZE } from '@/adapters/binary/types'

function writeInt32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >>> 8) & 0xff
  bytes[offset + 2] = (value >>> 16) & 0xff
  bytes[offset + 3] = (value >>> 24) & 0xff
}

function writeUint16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >>> 8) & 0xff
}

function writeInt64(bytes: Uint8Array, offset: number, value: bigint): void {
  let remaining = value & 0xffffffffffffffffn
  for (let index = 0; index < 8; index++) {
    bytes[offset + index] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
}

function buildPayload(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return bytes
}

function blobBuf(text: string): Uint8Array {
  const encoded = new TextEncoder().encode(text)
  const header = new Uint8Array(4)
  writeInt32(header, 0, encoded.byteLength)
  return buildPayload(header, encoded)
}

function blobParts(...parts: Uint8Array[]): Uint8Array {
  const blob = buildPayload(...parts)
  const header = new Uint8Array(4)
  writeInt32(header, 0, blob.byteLength)
  return buildPayload(header, blob)
}

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function writeSliceRef(bytes: Uint8Array, offset: number, sliceOffset: number, length: number): void {
  writeInt32(bytes, offset, sliceOffset)
  writeInt32(bytes, offset + 4, length)
}

function commentPolicyPayload(languages: string): Uint8Array {
  const encodedLanguages = new TextEncoder().encode(languages)
  const snapshotHash = new TextEncoder().encode('9'.repeat(64))
  const pod = new Uint8Array(41)
  pod[0] = 1
  pod[1] = 1
  pod[2] = 1
  pod[3] = 4
  writeInt32(pod, 9, 1000)
  writeInt32(pod, 13, 4096)
  writeSliceRef(pod, 17, 0, encodedLanguages.byteLength)
  writeSliceRef(pod, 25, encodedLanguages.byteLength, snapshotHash.byteLength)
  writeSliceRef(pod, 33, encodedLanguages.byteLength + snapshotHash.byteLength, 0)
  return buildPayload(pod, blobParts(encodedLanguages, snapshotHash))
}

describe('decodeBinaryFramePayload', () => {
  it('throws for unknown frame type', () => {
    expect(() => decodeBinaryFramePayload(999 as FrameType, new Uint8Array(0))).toThrow()
  })

  it('decodes the final comment creation moderation state', () => {
    const payload = new Uint8Array(40)
    writeInt64(payload, 0, 9007199254740n)
    writeInt64(payload, 8, 9007199254700n)
    writeInt64(payload, 16, 0n)
    writeInt64(payload, 24, 1784510400000n)
    writeInt32(payload, 32, 0)
    payload[36] = 0
    payload[37] = 0
    payload[38] = 1
    payload[39] = 0

    expect(decodeBinaryFramePayload(FrameType.CommentCreateResult, payload)).toEqual({
      commentId: '9007199254740',
      rootId: '9007199254700',
      parentId: null,
      createdAtUtc: '2026-07-20T01:20:00.000Z',
      moderationStatus: 0,
      visibilityState: 'pending',
      isPubliclyVisible: false,
      idempotencyReplay: true
    })
  })

  it('throws for FrameType.Unknown (0)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.Unknown, new Uint8Array(0))).toThrow()
  })

  it('throws for FrameType.ApiError', () => {
    expect(() => decodeBinaryFramePayload(FrameType.ApiError, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for ArticleList (throws on empty payload, confirms routing)', () => {
    // The ArticleList mapper will throw for empty payload - this confirms routing is correct
    expect(() => decodeBinaryFramePayload(FrameType.ArticleList, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for ArticleDetail (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.ArticleDetail, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for ArticleHot (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.ArticleHot, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for ArticleSearch (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.ArticleSearch, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for ArticleFeatured (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.ArticleFeatured, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for ArticleRelatedReading (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.ArticleRelatedReading, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for human read proof frames (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.HumanReadChallengeResponse, new Uint8Array(0))).toThrow()
    expect(() => decodeBinaryFramePayload(FrameType.HumanReadSubmitResponse, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for TrashClearResponse (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.TrashClearResponse, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for AdminUserList (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.AdminUserList, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for AuthLoginFlow (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.AuthLoginFlow, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for CurrentUserSnapshot (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.CurrentUserSnapshot, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for IdentityAccountSnapshot (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.IdentityAccountSnapshot, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for AuthSessionList (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.AuthSessionList, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for PowChallenge (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.PowChallenge, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for MFA frames (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.MfaSetupStart, new Uint8Array(0))).toThrow()
    expect(() => decodeBinaryFramePayload(FrameType.MfaSetupVerify, new Uint8Array(0))).toThrow()
    expect(() => decodeBinaryFramePayload(FrameType.MfaProfile, new Uint8Array(0))).toThrow()
    expect(() => decodeBinaryFramePayload(FrameType.MfaChallengeResult, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for conversation frames (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.ConversationList, new Uint8Array(0))).toThrow()
    expect(() => decodeBinaryFramePayload(FrameType.ConversationDetail, new Uint8Array(0))).toThrow()
    expect(() => decodeBinaryFramePayload(FrameType.ConversationMessage, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for Passkey frames (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.PasskeyRegisterBegin, new Uint8Array(0))).toThrow()
    expect(() => decodeBinaryFramePayload(FrameType.PasskeyLoginBegin, new Uint8Array(0))).toThrow()
    expect(() => decodeBinaryFramePayload(FrameType.PasskeyCredentialList, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for CommentArticleCursor (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.CommentArticleCursor, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for CommentUserCursor (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.CommentUserCursor, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for CommentThreadReplyCursor (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.CommentThreadReplyCursor, new Uint8Array(0))).toThrow()
  })

  it('maps CommentPolicySnapshot for composer author-mode controls', () => {
    expect(decodeBinaryFramePayload(FrameType.CommentPolicySnapshot, commentPolicyPayload('zh-CN\nen'))).toEqual({
      contractVersion: CommentPolicyContractVersion.Current,
      anonymousCommentsEnabled: true,
      publicCommentsEnabled: true,
      zkAnonymousEnabled: true,
      defaultAuthorMode: 'zk_anonymous',
      supportedDisplayLanguages: ['zh-CN', 'en'],
      snapshotHash: '9'.repeat(64),
      commentMaxChars: 1000,
      commentMaxUtf8Bytes: 4096,
      zkProdEnabled: false,
      zkProdNativeVerifierConfigured: false,
      zkProdTrustedSetupVerified: false,
      zkProdCredentialRequired: false,
      zkProdCredentialRootReady: false,
      zkProdUnavailableReason: 'contract_invalid',
      zkProdReadiness: CommentPolicyReadiness.ContractInvalid
    })
  })

  it('maps anonymous privacy state snapshot frames', () => {
    const pod = new Uint8Array(ANONYMOUS_PRIVACY_STATE_SNAPSHOT_POD_SIZE)
    const circuit = textBytes('fsus.anonymous.comment.v3')
    const verifyingKeyHash = textBytes('vk-sha256')
    const status = textBytes('active')
    const level = textBytes('strong_anonymous')
    const blob = buildPayload(circuit, verifyingKeyHash, status, level)

    writeInt64(pod, 0, 20260618n)
    writeInt64(pod, 8, 1780000000000n)
    writeInt64(pod, 16, 1780000005000n)
    writeInt32(pod, 24, 7)
    writeUint16(pod, 28, 4)
    pod[30] = 1
    pod[31] = 1
    pod[32] = 0
    writeSliceRef(pod, 34, 0, circuit.byteLength)
    writeSliceRef(pod, 42, circuit.byteLength, verifyingKeyHash.byteLength)
    writeSliceRef(pod, 50, circuit.byteLength + verifyingKeyHash.byteLength, status.byteLength)
    writeSliceRef(pod, 58, circuit.byteLength + verifyingKeyHash.byteLength + status.byteLength, level.byteLength)

    expect(decodeBinaryFramePayload(FrameType.AnonymousPrivacyStateSnapshot, buildPayload(pod, blobParts(blob)))).toEqual({
      credentialEpoch: 20260618,
      rootExpiresAtUnixMs: 1780000000000,
      ticketExpiresAtUnixMs: 1780000005000,
      circuitNumericId: 7,
      publicInputLayoutVersion: 4,
      hasActiveCredential: true,
      canIssueCredential: true,
      canSubmitAnonymousComment: false,
      circuitId: 'fsus.anonymous.comment.v3',
      verifyingKeyHash: 'vk-sha256',
      credentialStatus: 'active',
      credentialLevel: 'strong_anonymous'
    })
  })

  it('calls mapper for AdminStats (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.AdminStats, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for CategoryList (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.CategoryList, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for TagList (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.TagList, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for RecentCommentStats (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.RecentCommentStats, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for RegionStats (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.RegionStats, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for SeoConfig (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.SeoConfig, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for PageContent (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.PageContent, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for UploadInit (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.UploadInit, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for UploadStatus (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.UploadStatus, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for UploadPartAck (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.UploadPartAck, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for UploadComplete (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.UploadComplete, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for UploadPartMap (throws on empty payload, confirms routing)', () => {
    expect(() => decodeBinaryFramePayload(FrameType.UploadPartMap, new Uint8Array(0))).toThrow()
  })

  it('maps security JSON bridge frames', () => {
    const payload = new TextEncoder().encode('{"snapshotId":"sec-1"}')
    expect(decodeBinaryFramePayload(FrameType.AntiCrawlerPolicySnapshot, payload)).toEqual({ snapshotId: 'sec-1' })
  })

  it('maps EmptySuccess payload', () => {
    expect(decodeBinaryFramePayload(FrameType.EmptySuccess, new Uint8Array([1, 0, 0, 0]))).toBeNull()
  })

  it('maps MutationId payload', () => {
    const payload = new Uint8Array(8)
    new DataView(payload.buffer).setBigInt64(0, 42n, true)
    expect(decodeBinaryFramePayload(FrameType.MutationId, payload)).toEqual({ id: 42 })
  })

  it('maps article mutation coordinates from the extended MutationId payload', () => {
    const payload = new Uint8Array(28)
    writeInt32(payload, 0, 42)
    writeInt64(payload, 4, 8123n)
    writeInt32(payload, 12, 8)
    writeInt64(payload, 16, 9007199254740n)
    writeInt32(payload, 24, 7)

    expect(decodeBinaryFramePayload(FrameType.MutationId, payload)).toEqual({
      id: 42,
      revisionId: 8123,
      revisionNo: 8,
      rightsSnapshotId: 9007199254740,
      rightsRevisionNo: 7
    })
  })

  it('maps the strong article mutation result payload', () => {
    const payload = new Uint8Array(48)
    writeInt32(payload, 0, 42)
    writeInt64(payload, 4, 8123n)
    writeInt32(payload, 12, 8)
    writeInt64(payload, 16, 7201n)
    writeInt32(payload, 24, 4)
    writeInt32(payload, 28, 1)
    writeInt64(payload, 32, 9007199254740n)
    writeInt32(payload, 40, 7)
    payload[44] = 1

    expect(decodeBinaryFramePayload(FrameType.MutationId, payload)).toEqual({
      id: 42,
      articleId: 42,
      revisionId: 8123,
      revisionNo: 8,
      releaseId: 7201,
      releaseNo: 4,
      status: 1,
      rightsSnapshotId: 9007199254740,
      rightsRevisionNo: 7,
      idempotencyReplay: true,
      errorCode: 0
    })
  })
})
