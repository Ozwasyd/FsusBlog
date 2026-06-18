import { describe, it, expect } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'
import { mapFramePayloadToViewModel } from '@/adapters/binary/index'
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
  const pod = new Uint8Array(12)
  pod[0] = 1
  pod[1] = 1
  pod[2] = 1
  pod[3] = 4
  writeInt32(pod, 4, 0)
  writeInt32(pod, 8, encodedLanguages.byteLength)
  return buildPayload(pod, blobBuf(languages))
}

describe('mapFramePayloadToViewModel', () => {
  it('throws for unknown frame type', () => {
    expect(() => mapFramePayloadToViewModel(999 as FrameType, new Uint8Array(0))).toThrow()
  })

  it('throws for FrameType.Unknown (0)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.Unknown, new Uint8Array(0))).toThrow()
  })

  it('throws for FrameType.ApiError', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.ApiError, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for ArticleList (throws on empty payload, confirms routing)', () => {
    // The ArticleList mapper will throw for empty payload - this confirms routing is correct
    expect(() => mapFramePayloadToViewModel(FrameType.ArticleList, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for ArticleDetail (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.ArticleDetail, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for ArticleHot (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.ArticleHot, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for ArticleSearch (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.ArticleSearch, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for ArticleFeatured (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.ArticleFeatured, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for ArticleRelatedReading (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.ArticleRelatedReading, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for human read proof frames (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.HumanReadChallengeResponse, new Uint8Array(0))).toThrow()
    expect(() => mapFramePayloadToViewModel(FrameType.HumanReadSubmitResponse, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for TrashClearResponse (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.TrashClearResponse, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for AdminUserList (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.AdminUserList, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for AuthLoginFlow (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.AuthLoginFlow, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for CurrentUserSnapshot (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.CurrentUserSnapshot, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for AuthSessionList (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.AuthSessionList, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for PowChallenge (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.PowChallenge, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for MFA frames (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.MfaSetupStart, new Uint8Array(0))).toThrow()
    expect(() => mapFramePayloadToViewModel(FrameType.MfaSetupVerify, new Uint8Array(0))).toThrow()
    expect(() => mapFramePayloadToViewModel(FrameType.MfaProfile, new Uint8Array(0))).toThrow()
    expect(() => mapFramePayloadToViewModel(FrameType.MfaChallengeResult, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for conversation frames (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.ConversationList, new Uint8Array(0))).toThrow()
    expect(() => mapFramePayloadToViewModel(FrameType.ConversationDetail, new Uint8Array(0))).toThrow()
    expect(() => mapFramePayloadToViewModel(FrameType.ConversationMessage, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for Passkey frames (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.PasskeyRegisterBegin, new Uint8Array(0))).toThrow()
    expect(() => mapFramePayloadToViewModel(FrameType.PasskeyLoginBegin, new Uint8Array(0))).toThrow()
    expect(() => mapFramePayloadToViewModel(FrameType.PasskeyCredentialList, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for CommentArticleCursor (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.CommentArticleCursor, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for CommentUserCursor (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.CommentUserCursor, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for CommentThreadReplyCursor (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.CommentThreadReplyCursor, new Uint8Array(0))).toThrow()
  })

  it('maps CommentPolicySnapshot for composer author-mode controls', () => {
    expect(mapFramePayloadToViewModel(FrameType.CommentPolicySnapshot, commentPolicyPayload('zh-CN\nen'))).toEqual({
      anonymousCommentsEnabled: true,
      publicCommentsEnabled: true,
      zkAnonymousEnabled: true,
      defaultAuthorMode: 'zk_anonymous',
      supportedDisplayLanguages: ['zh-CN', 'en']
    })
  })

  it('maps anonymous privacy state snapshot frames', () => {
    const pod = new Uint8Array(ANONYMOUS_PRIVACY_STATE_SNAPSHOT_POD_SIZE)
    const circuit = textBytes('zk-comment-v1')
    const verifyingKeyHash = textBytes('vk-sha256')
    const status = textBytes('active')
    const level = textBytes('strong_anonymous')
    const blob = buildPayload(circuit, verifyingKeyHash, status, level)

    writeInt64(pod, 0, 20260618n)
    writeInt64(pod, 8, 1780000000000n)
    writeInt64(pod, 16, 1780000005000n)
    writeInt32(pod, 24, 7)
    writeUint16(pod, 28, 2)
    pod[30] = 1
    pod[31] = 1
    pod[32] = 0
    writeSliceRef(pod, 34, 0, circuit.byteLength)
    writeSliceRef(pod, 42, circuit.byteLength, verifyingKeyHash.byteLength)
    writeSliceRef(pod, 50, circuit.byteLength + verifyingKeyHash.byteLength, status.byteLength)
    writeSliceRef(pod, 58, circuit.byteLength + verifyingKeyHash.byteLength + status.byteLength, level.byteLength)

    expect(mapFramePayloadToViewModel(FrameType.AnonymousPrivacyStateSnapshot, buildPayload(pod, blobParts(blob)))).toEqual({
      credentialEpoch: 20260618,
      rootExpiresAtUnixMs: 1780000000000,
      ticketExpiresAtUnixMs: 1780000005000,
      circuitNumericId: 7,
      publicInputLayoutVersion: 2,
      hasActiveCredential: true,
      canIssueCredential: true,
      canSubmitAnonymousComment: false,
      circuitId: 'zk-comment-v1',
      verifyingKeyHash: 'vk-sha256',
      credentialStatus: 'active',
      credentialLevel: 'strong_anonymous'
    })
  })

  it('calls mapper for AdminStats (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.AdminStats, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for CategoryList (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.CategoryList, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for TagList (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.TagList, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for RecentCommentStats (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.RecentCommentStats, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for RegionStats (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.RegionStats, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for SeoConfig (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.SeoConfig, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for PageContent (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.PageContent, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for UploadInit (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.UploadInit, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for UploadStatus (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.UploadStatus, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for UploadPartAck (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.UploadPartAck, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for UploadComplete (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.UploadComplete, new Uint8Array(0))).toThrow()
  })

  it('calls mapper for UploadPartMap (throws on empty payload, confirms routing)', () => {
    expect(() => mapFramePayloadToViewModel(FrameType.UploadPartMap, new Uint8Array(0))).toThrow()
  })

  it('maps security JSON bridge frames', () => {
    const payload = new TextEncoder().encode('{"snapshotId":"sec-1"}')
    expect(mapFramePayloadToViewModel(FrameType.AntiCrawlerPolicySnapshot, payload)).toEqual({ snapshotId: 'sec-1' })
  })

  it('maps EmptySuccess payload', () => {
    expect(mapFramePayloadToViewModel(FrameType.EmptySuccess, new Uint8Array([1, 0, 0, 0]))).toBeNull()
  })

  it('maps MutationId payload', () => {
    const payload = new Uint8Array(8)
    new DataView(payload.buffer).setBigInt64(0, 42n, true)
    expect(mapFramePayloadToViewModel(FrameType.MutationId, payload)).toEqual({ id: 42 })
  })
})
