import { createHash } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import articleDetailFrameHex from '../../../../fixtures/protocol/article-detail-frame.hex?raw'
import routingReplacementLedger from '../../../../fixtures/binary-decoder-routing-replacements.json'
import { AEDS_HEADER_LENGTH, AEDS_MAGIC, AEDS_VERSION, FrameType } from '@wasm/protocol/frame'
import { CommentPolicyContractVersion, CommentPolicyReadiness } from '@/contracts/commentPolicy'
import {
  binaryFrameDecoderFrameTypes,
  binaryFrameDecoderRegistrations,
  binaryFrameDecoderRegistry,
  createBinaryFrameDecoderRegistry,
  decodeBinaryFramePayload,
  decodeBinaryFramePayloadWithRegistry
} from '@/composition/binaryDecoderRegistry'
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

function writeFixedUtf8(bytes: Uint8Array, offset: number, length: number, value: string): void {
  bytes.set(textBytes(value).subarray(0, length), offset)
}

function blobbedZeroPod(podSize: number): Uint8Array {
  return new Uint8Array(podSize + 4)
}

function protocolFixturePayload(hexSource: string): Uint8Array {
  const hex = hexSource.replaceAll(/\s+/gu, '')
  return Uint8Array.from(hex.match(/.{2}/gu) ?? [], (value) => Number.parseInt(value, 16)).subarray(16)
}

function aedsEnvelope(frameType: FrameType, payload: Uint8Array, version = AEDS_VERSION): Uint8Array {
  const frame = new Uint8Array(AEDS_HEADER_LENGTH + payload.byteLength)
  const view = new DataView(frame.buffer)
  view.setUint32(0, AEDS_MAGIC, true)
  view.setUint8(4, version)
  view.setUint8(5, AEDS_HEADER_LENGTH)
  view.setUint16(8, frameType, true)
  view.setUint32(10, payload.byteLength, true)
  frame.set(payload, AEDS_HEADER_LENGTH)
  return frame
}

function recoveryKeyCreatePayload(): Uint8Array {
  const pod = new Uint8Array(24)
  const key = textBytes('recovery-key')
  writeSliceRef(pod, 16, 0, key.byteLength)
  return buildPayload(pod, blobParts(key))
}

function recoveryKeyVerifyPayload(): Uint8Array {
  const payload = new Uint8Array(144)
  writeFixedUtf8(payload, 16, 128, 'recovery-session')
  return payload
}

function conversationDetailPayload(podSize: 44 | 52 | 68): Uint8Array {
  const payload = blobbedZeroPod(podSize + 4)
  writeInt64(payload, 24, 1n)
  if (podSize === 68) writeInt32(payload, 60, 3)
  return payload
}

function unavailablePermalinkPayload(): Uint8Array {
  const payload = new Uint8Array(32)
  payload[24] = 1
  return payload
}

function revocationArtifactPayload(): Uint8Array {
  const pod = new Uint8Array(88)
  const algorithm = textBytes('non-membership.v1')
  const issuer = textBytes('issuer')
  const root = new Uint8Array(32).fill(1)
  const hash = new Uint8Array(32).fill(2)
  const signature = new Uint8Array(32).fill(3)
  const blob = buildPayload(algorithm, issuer, root, hash, signature)
  writeUint16(pod, 36, 128)
  pod[38] = 1
  let offset = 0
  for (const [at, value] of [[40, algorithm], [48, issuer], [56, root], [64, hash], [72, signature]] as const) {
    writeSliceRef(pod, at, offset, value.byteLength)
    offset += value.byteLength
  }
  writeSliceRef(pod, 80, offset, 0)
  return buildPayload(pod, blobParts(blob))
}

function securityChallengeVerifyPayload(): Uint8Array {
  const pod = new Uint8Array(968)
  const reason = textBytes('ok')
  pod[1] = 1
  writeInt32(pod, 12, 1)
  writeFixedUtf8(pod, 16, 64, '01900000-0000-7000-8000-000000000001')
  writeFixedUtf8(pod, 80, 64, '01900000-0000-7000-8000-000000000002')
  writeFixedUtf8(pod, 144, 64, 'policy-v1')
  writeSliceRef(pod, 208, 0, 0)
  writeSliceRef(pod, 216, 0, reason.byteLength)
  return buildPayload(pod, blobParts(reason))
}

function commentCreatePayload(): Uint8Array {
  const payload = new Uint8Array(40)
  writeInt64(payload, 0, 1n)
  writeInt64(payload, 8, 1n)
  writeInt64(payload, 24, 1n)
  payload[38] = 1
  return payload
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

const jsonPayload = (): Uint8Array => textBytes('{}')
const zeroPayload = (size: number): (() => Uint8Array) => () => new Uint8Array(size)
const validPayloadByDecoder = new Map<string, () => Uint8Array>([
  ['mapArticlePageFromPodPayload', zeroPayload(16)],
  ['mapArticleDetailFromPodPayload', () => protocolFixturePayload(articleDetailFrameHex)],
  ['mapArticleHotFromPodPayload', zeroPayload(8)],
  ['mapArticleSearchFromPodPayload', zeroPayload(4)],
  ['mapArticleFeaturedFromPodPayload', zeroPayload(4)],
  ['mapRelatedReadingFromPodPayload', zeroPayload(12)],
  ['mapHumanReadChallengeFromPayload', zeroPayload(56)],
  ['mapHumanReadSubmitFromPayload', zeroPayload(16)],
  ['mapTrashClearResponseFromPodPayload', zeroPayload(4)],
  ['mapAdminUserPageFromPayload', zeroPayload(8)],
  ['mapAuthLoginFlowFromPayload', zeroPayload(168)],
  ['mapCurrentUserSnapshotFromPayload', zeroPayload(372)],
  ['mapIdentityAccountSnapshotFromPayload', zeroPayload(76)],
  ['mapUserSessionsFromPayload', zeroPayload(4)],
  ['mapPowChallengeFromPayload', zeroPayload(204)],
  ['mapMfaSetupStartFromPayload', zeroPayload(40)],
  ['mapMfaSetupVerifyFromPayload', zeroPayload(8)],
  ['mapMfaProfileFromPayload', zeroPayload(12)],
  ['mapMfaChallengeResultFromPayload', zeroPayload(296)],
  ['mapRecoveryKeyCreateResponseFromPayload', recoveryKeyCreatePayload],
  ['mapRecoveryKeyVerifyResponseFromPayload', recoveryKeyVerifyPayload],
  ['mapConversationListFromPayload', zeroPayload(12)],
  ['mapConversationDetailFromPayload', zeroPayload(44)],
  ['mapConversationDetailV2FromPayload', () => conversationDetailPayload(44)],
  ['mapConversationDetailV3FromPayload', () => conversationDetailPayload(52)],
  ['mapAdminConversationListFromPayload', zeroPayload(12)],
  ['mapAdminConversationDetailFromPayload', () => conversationDetailPayload(68)],
  ['mapConversationStatusMutationResultFromPayload', zeroPayload(12)],
  ['mapConversationMessageFromPayload', zeroPayload(52)],
  ['mapPasskeyRegisterBeginFromPayload', zeroPayload(152)],
  ['mapPasskeyLoginBeginFromPayload', zeroPayload(104)],
  ['mapPasskeyCredentialListFromPayload', zeroPayload(8)],
  ['mapPasskeySignalStateFromPayload', zeroPayload(52)],
  ['mapCommentPolicySnapshotFromPayload', () => commentPolicyPayload('en')],
  ['mapCommentCreateResultFromPayload', commentCreatePayload],
  ['mapAuthoringJsonFromPayload', jsonPayload],
  ['mapCommentCursorFromPodPayload', zeroPayload(13)],
  ['mapUserCommentCursorFromPodPayload', zeroPayload(13)],
  ['mapThreadReplyCursorFromPodPayload', zeroPayload(21)],
  ['mapCommentTreeRootCursorFromPayload', zeroPayload(13)],
  ['mapCommentChildCursorFromPayload', zeroPayload(32)],
  ['mapCommentPermalinkContextFromPayload', unavailablePermalinkPayload],
  ['mapAnonymousCredentialRootSnapshotFromPayload', zeroPayload(84)],
  ['mapAnonymousCredentialRevocationArtifactFromPayload', revocationArtifactPayload],
  ['mapAnonymousCommentTicketResponseFromPayload', zeroPayload(40)],
  ['mapAnonymousPrivacyStateSnapshotFromPayload', zeroPayload(70)],
  ['mapBlindCredentialIssuerMetadataFromPayload', zeroPayload(76)],
  ['mapBlindCredentialIssueResponseFromPayload', zeroPayload(68)],
  ['mapSiteStatsFromPodPayload', zeroPayload(96)],
  ['mapCategoryListFromPayload', zeroPayload(8)],
  ['mapTagListFromPayload', zeroPayload(8)],
  ['mapRecentCommentsFromPodPayload', zeroPayload(8)],
  ['mapRegionsFromPodPayload', zeroPayload(8)],
  ['mapSeoConfigFromPayload', () => blobbedZeroPod(5000)],
  ['mapPageContentFromPayload', zeroPayload(140)],
  ['mapSiteComplianceConfigFromPayload', () => blobbedZeroPod(1709)],
  ['mapUploadInitFromPayload', zeroPayload(568)],
  ['mapUploadStatusFromPayload', zeroPayload(136)],
  ['mapUploadPartAckFromPayload', zeroPayload(92)],
  ['mapUploadCompleteFromPayload', zeroPayload(648)],
  ['mapUploadPartMapFromPayload', zeroPayload(72)],
  ['mapSecurityJsonFromPayload', jsonPayload],
  ['mapSecurityChallengeIssueResponseFromPayload', zeroPayload(152)],
  ['mapSecurityChallengeVerifyResponseFromPayload', securityChallengeVerifyPayload],
  ['mapSiteSubscriptionResponseFromPayload', zeroPayload(36)],
  ['mapEmptySuccessFromPayload', () => new Uint8Array([1, 0, 0, 0])],
  ['mapMutationIdFromPayload', zeroPayload(8)]
])

function registrationFingerprint(
  registrations: ReadonlyArray<readonly [FrameType, (payload: Uint8Array) => unknown]>
): string {
  const identity = registrations.map(([frameType, decoder]) => `${frameType}:${decoder.name}`).join('\n')
  return createHash('sha256').update(identity).digest('hex')
}

function resultFingerprint(result: unknown): string {
  const serialized = JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? value.toString() : value)
  if (serialized === undefined) throw new Error('decoder_result_undefined')
  return createHash('sha256').update(serialized).digest('hex')
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

  it('builds one authoritative decoder registration per supported frame', () => {
    const frameTypes = binaryFrameDecoderRegistrations.map(([frameType]) => frameType)
    expect(binaryFrameDecoderRegistrations).toHaveLength(routingReplacementLedger.registrationCount)
    expect(registrationFingerprint(binaryFrameDecoderRegistrations))
      .toBe(routingReplacementLedger.registrationSha256)
    expect(new Set(frameTypes).size).toBe(frameTypes.length)
    expect(binaryFrameDecoderFrameTypes).toEqual(frameTypes)
    expect(Object.keys(binaryFrameDecoderRegistry).map(Number).sort((left, right) => left - right))
      .toEqual([...frameTypes].sort((left, right) => left - right))
    expect(() => createBinaryFrameDecoderRegistry([
      binaryFrameDecoderRegistrations[0],
      binaryFrameDecoderRegistrations[0]
    ], binaryFrameDecoderFrameTypes)).toThrow('decoder_frame_type_duplicate')
    expect(() => createBinaryFrameDecoderRegistry([
      [999 as FrameType, () => null]
    ], binaryFrameDecoderFrameTypes)).toThrow('decoder_frame_type_invalid')
    expect(() => createBinaryFrameDecoderRegistry(
      binaryFrameDecoderRegistrations,
      [binaryFrameDecoderFrameTypes[0], binaryFrameDecoderFrameTypes[0]]
    )).toThrow('decoder_expected_frame_type_duplicate')
    expect(() => createBinaryFrameDecoderRegistry(
      binaryFrameDecoderRegistrations,
      [999 as FrameType]
    )).toThrow('decoder_expected_frame_type_invalid')
    expect(() => createBinaryFrameDecoderRegistry(
      binaryFrameDecoderRegistrations.slice(1),
      binaryFrameDecoderFrameTypes
    )).toThrow('decoder_frame_type_missing')
    expect(() => createBinaryFrameDecoderRegistry([
      ...binaryFrameDecoderRegistrations,
      [FrameType.ArticleWriteRequest, () => null]
    ], binaryFrameDecoderFrameTypes)).toThrow('decoder_frame_type_unexpected')
    expect(registrationFingerprint(binaryFrameDecoderRegistrations.slice(1)))
      .not.toBe(routingReplacementLedger.registrationSha256)
    const rewired = binaryFrameDecoderRegistrations.map((registration, index) => index === 0
      ? [registration[0], binaryFrameDecoderRegistrations[1][1]] as const
      : registration)
    expect(registrationFingerprint(rewired))
      .not.toBe(routingReplacementLedger.registrationSha256)
  })

  it('records every retired empty-payload pseudo-routing assertion', () => {
    expect(routingReplacementLedger.schema).toBe('fsusblog.binary-decoder-routing-replacements.v1')
    expect(routingReplacementLedger.removedTestIds).toHaveLength(32)
    expect(new Set(routingReplacementLedger.removedTestIds).size).toBe(32)
    expect(routingReplacementLedger.removedTestIds.every((id) => id.includes('empty payload'))).toBe(true)
    expect(routingReplacementLedger.replacementTestIds).toEqual([
      'builds one authoritative decoder registration per supported frame',
      'maps a minimum valid payload to the registered decoder result contract for every supported frame',
      'dispatches every supported frame to exactly its registered decoder'
    ])
  })

  it('dispatches every supported frame to exactly its registered decoder', () => {
    const payload = new Uint8Array([0xa5])
    const calls = new Map<FrameType, ReturnType<typeof vi.fn>>()
    const registrations = binaryFrameDecoderRegistrations.map(([frameType]) => {
      const decoder = vi.fn(() => ({ frameType }))
      calls.set(frameType, decoder)
      return [frameType, decoder] as const
    })
    const registry = createBinaryFrameDecoderRegistry(registrations)

    for (const [frameType] of registrations) {
      expect(decodeBinaryFramePayloadWithRegistry(registry, frameType, payload)).toEqual({ frameType })
      for (const [candidateFrameType, decoder] of calls) {
        expect(decoder).toHaveBeenCalledTimes(candidateFrameType === frameType ? 1 : 0)
        decoder.mockClear()
      }
    }
  })

  it('maps a minimum valid payload to the registered decoder result contract for every supported frame', () => {
    const registeredDecoderNames = new Set(binaryFrameDecoderRegistrations.map(([, decoder]) => decoder.name))
    expect([...validPayloadByDecoder.keys()].sort()).toEqual([...registeredDecoderNames].sort())
    expect(Object.keys(routingReplacementLedger.decoderResultSha256).sort())
      .toEqual([...registeredDecoderNames].sort())

    for (const [frameType, decoder] of binaryFrameDecoderRegistrations) {
      const createPayload = validPayloadByDecoder.get(decoder.name)
      expect(createPayload, `missing valid payload for ${decoder.name}`).toBeTypeOf('function')
      const result = decodeBinaryFramePayload(frameType, createPayload!())
      expect(resultFingerprint(result), `${frameType}:${decoder.name}`)
        .toBe(routingReplacementLedger.decoderResultSha256[decoder.name as keyof typeof routingReplacementLedger.decoderResultSha256])
    }
  })

  it('rejects a truncated real article detail payload', () => {
    const payload = protocolFixturePayload(articleDetailFrameHex)

    expect(() => decodeBinaryFramePayload(FrameType.ArticleDetail, payload.subarray(0, payload.byteLength - 1)))
      .toThrow()
  })

  it('rejects a frame with a mismatched protocol version before payload routing', async () => {
    const { decodeAedsEnvelopeNoCopy } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const frame = aedsEnvelope(FrameType.ArticleDetail, protocolFixturePayload(articleDetailFrameHex), AEDS_VERSION + 1)

    expect(decodeAedsEnvelopeNoCopy(frame)).toMatchObject({
      ok: false,
      frameType: FrameType.ArticleDetail,
      error: 'version_mismatch'
    })
  })

  it('rejects the legacy v1 envelope before payload routing', async () => {
    const { decodeAedsEnvelopeNoCopy } = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const frame = aedsEnvelope(FrameType.ArticleDetail, protocolFixturePayload(articleDetailFrameHex), 1)

    expect(decodeAedsEnvelopeNoCopy(frame)).toMatchObject({
      ok: false,
      frameType: FrameType.ArticleDetail,
      error: 'version_mismatch'
    })
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
    const circuit = textBytes('fsus.anonymous.comment.v5')
    const verifyingKeyHash = textBytes('vk-sha256')
    const status = textBytes('active')
    const level = textBytes('strong_anonymous')
    const blob = buildPayload(circuit, verifyingKeyHash, status, level)

    writeInt64(pod, 0, 20260618n)
    writeInt64(pod, 8, 1780000000000n)
    writeInt64(pod, 16, 1780000005000n)
    writeInt32(pod, 24, 7)
    writeUint16(pod, 28, 6)
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
      publicInputLayoutVersion: 6,
      hasActiveCredential: true,
      canIssueCredential: true,
      canSubmitAnonymousComment: false,
      circuitId: 'fsus.anonymous.comment.v5',
      verifyingKeyHash: 'vk-sha256',
      credentialStatus: 'active',
      credentialLevel: 'strong_anonymous'
    })
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
    payload[46] = 1

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
      errorCode: 0,
      outcome: 'no_change'
    })
  })

  it('rejects an unknown strong article mutation outcome', () => {
    const payload = new Uint8Array(48)
    payload[46] = 9

    expect(() => decodeBinaryFramePayload(FrameType.MutationId, payload)).toThrow(
      'article_mutation_outcome_invalid'
    )
  })
})
