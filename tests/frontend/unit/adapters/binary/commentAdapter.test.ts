import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  mapAnonymousCommentTicketResponseFromPayload,
  mapAnonymousCredentialIssueResponseFromPayload,
  mapAnonymousCredentialRevocationWitnessResponseFromPayload,
  mapAnonymousCredentialRootSnapshotFromPayload,
  mapAnonymousPrivacyStateSnapshotFromPayload,
  mapCommentCursorFromPodPayload,
  mapCommentPolicySnapshotFromPayload,
  mapThreadReplyCursorFromPodPayload,
  mapUserCommentCursorFromPodPayload
} from '@/adapters/binary/commentAdapter'
import {
  ANONYMOUS_COMMENT_TICKET_RESPONSE_POD_SIZE,
  ANONYMOUS_CREDENTIAL_ISSUE_RESPONSE_POD_SIZE,
  ANONYMOUS_CREDENTIAL_REVOCATION_WITNESS_RESPONSE_POD_SIZE,
  ANONYMOUS_CREDENTIAL_ROOT_SNAPSHOT_POD_SIZE,
  ANONYMOUS_PRIVACY_STATE_SNAPSHOT_POD_SIZE,
  COMMENT_AUTHOR_VIEW_POD_SIZE,
  COMMENT_POLICY_SNAPSHOT_POD_SIZE,
  COMMENT_THREAD_ITEM_POD_SIZE,
  COMMENT_REPLY_ITEM_POD_SIZE,
  USER_COMMENT_POD_SIZE
} from '@/adapters/binary/types'
import { encodeCommentCreateV2Request as encodeSupportCommentCreateV2Request } from '../../../support/aeds-envelope.mjs'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

function extractTsInterface(source: string, name: string): string {
  const match = source.match(new RegExp(`export interface ${name}(?: extends [^{]+)? \\{[\\s\\S]*?\\n\\}`))
  if (!match) {
    throw new Error(`missing_interface:${name}`)
  }
  return match[0]
}

function writeInt32(b: Uint8Array, off: number, v: number): void {
  b[off] = v & 0xff; b[off + 1] = (v >>> 8) & 0xff
  b[off + 2] = (v >>> 16) & 0xff; b[off + 3] = (v >>> 24) & 0xff
}
function writeUint16(b: Uint8Array, off: number, v: number): void {
  b[off] = v & 0xff; b[off + 1] = (v >>> 8) & 0xff
}
function writeInt64(b: Uint8Array, off: number, v: bigint): void {
  let r = v & 0xffffffffffffffffn
  for (let i = 0; i < 8; i++) { b[off + i] = Number(r & 0xffn); r >>= 8n }
}
function writeByte(b: Uint8Array, off: number, v: number): void {
  b[off] = v & 0xff
}
function writeUtf8(b: Uint8Array, off: number, t: string): void {
  b.set(new TextEncoder().encode(t), off)
}
function writeSliceRef(b: Uint8Array, off: number, offset: number, length: number): void {
  writeInt32(b, off, offset); writeInt32(b, off + 4, length)
}

// Build a payload from a list of typed chunks
function buildPayload(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const b = new Uint8Array(total)
  let off = 0; for (const p of parts) { b.set(p, off); off += p.length }
  return b
}

function int32Buf(v: number): Uint8Array { const b = new Uint8Array(4); writeInt32(b, 0, v); return b }
function int64Buf(v: bigint): Uint8Array { const b = new Uint8Array(8); writeInt64(b, 0, v); return b }
function byteBuf(v: number): Uint8Array { return new Uint8Array([v]) }
function textBytes(text: string): Uint8Array { return new TextEncoder().encode(text) }
function blobBuf(text: string): Uint8Array {
  const enc = textBytes(text)
  const lenBuf = new Uint8Array(4); writeInt32(lenBuf, 0, enc.length)
  return buildPayload(lenBuf, enc)
}

function blobParts(...parts: Uint8Array[]): Uint8Array {
  const blob = buildPayload(...parts)
  const lenBuf = new Uint8Array(4); writeInt32(lenBuf, 0, blob.length)
  return buildPayload(lenBuf, blob)
}

function lengthPrefixed(payload: Uint8Array): Uint8Array {
  const lenBuf = new Uint8Array(4); writeInt32(lenBuf, 0, payload.length)
  return buildPayload(lenBuf, payload)
}

function commentAuthorPayload(displayName: string, mode: 'anonymous' | 'public' | 'zk_anonymous' = 'public'): Uint8Array {
  const pod = new Uint8Array(COMMENT_AUTHOR_VIEW_POD_SIZE)
  pod[0] = mode === 'public' ? 3 : mode === 'zk_anonymous' ? 4 : 1
  const name = textBytes(displayName)
  const language = textBytes('zh-CN')
  writeSliceRef(pod, 4, 0, name.length)
  writeSliceRef(pod, 12, name.length, language.length)
  writeSliceRef(pod, 20, name.length + language.length, 0)
  writeSliceRef(pod, 28, name.length + language.length, 0)
  return buildPayload(pod, blobParts(name, language))
}

function commentItemBlob(content: string, displayName = 'alice', replyToDisplayName?: string): Uint8Array {
  return blobParts(
    textBytes(content),
    lengthPrefixed(commentAuthorPayload(displayName)),
    lengthPrefixed(replyToDisplayName ? commentAuthorPayload(replyToDisplayName) : new Uint8Array())
  )
}

// ---------------------------------------------------------------------------
// mapCommentCursorFromPodPayload
// ---------------------------------------------------------------------------
describe('mapCommentCursorFromPodPayload', () => {
  it('returns empty cursor when count is 0', () => {
    // readCursorEnvelope: nextCursor(int64) + hasMore(byte) + count(int32)
    const payload = buildPayload(
      int64Buf(0n),    // nextCursor = 0 → null
      byteBuf(0),      // hasMore = false
      int32Buf(0)      // count = 0
    )
    const result = mapCommentCursorFromPodPayload(payload)
    expect(result.nextCursor).toBeNull()
    expect(result.hasMore).toBe(false)
    expect(result.data).toEqual([])
  })

  it('reads nextCursor and hasMore', () => {
    // One thread item: build minimal COMMENT_THREAD_ITEM_POD (196 bytes) + previewCount=0 + blob
    const threadPod = new Uint8Array(COMMENT_THREAD_ITEM_POD_SIZE)
    writeInt64(threadPod, 0, 55n)   // id
    writeInt64(threadPod, 16, 55n)  // rootId
    // content slice at offset 180: empty
    const payload = buildPayload(
      int64Buf(777n),   // nextCursor = 777
      byteBuf(1),       // hasMore = true
      int32Buf(1),      // count = 1
      threadPod,
      commentItemBlob('', 'alice')
    )
    const result = mapCommentCursorFromPodPayload(payload)
    expect(result.nextCursor).toBe('777')
    expect(result.hasMore).toBe(true)
    expect(result.data).toHaveLength(1)
    expect(result.data[0].id).toBe('55')
    expect(result.data[0].author.displayName).toBe('alice')
  })

  it('rejects comment cursors without the current author contract', () => {
    const threadPod = new Uint8Array(COMMENT_THREAD_ITEM_POD_SIZE)
    writeInt64(threadPod, 0, 55n)
    writeInt64(threadPod, 16, 55n)
    const payload = buildPayload(
      int64Buf(777n),
      byteBuf(1),
      int32Buf(1),
      threadPod,
      blobBuf('')
    )

    expect(() => mapCommentCursorFromPodPayload(payload)).toThrow('comment_author_contract_missing')
  })
})

describe('comment create binary request compatibility slots', () => {
  it('keeps replyToUserId out of the support encoder POD payload', () => {
    const payload = encodeSupportCommentCreateV2Request({
      articleId: 9,
      content: 'reply through comment id',
      parentId: '100',
      rootId: '90',
      replyToCommentId: '80',
      replyToUserId: 7,
      authorMode: 'anonymous',
      publicSendExplicitlySelected: false
    })
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)

    expect(view.getInt32(0, true)).toBe(9)
    expect(view.getInt32(4, true)).toBe(0)
    expect(payload[11]).toBe(0)
    expect(view.getBigInt64(32, true)).toBe(80n)
  })

  it('marks legacy replyToUserId DTO fields deprecated for anonymous migration', () => {
    const source = readRepoFile('src/frontend/src/api/comment.ts')

    const block = extractTsInterface(source, 'CommentCreateV2Dto')
    expect(block).toMatch(/@deprecated[^\n]*匿名模式不应设置 replyToUserId/)
    expect(block).toContain('replyToUserId?: number | null')
  })
})

// ---------------------------------------------------------------------------
// mapCommentPolicySnapshotFromPayload
// ---------------------------------------------------------------------------
describe('mapCommentPolicySnapshotFromPayload', () => {
  it('decodes composer policy before rendering comment author controls', () => {
    const pod = new Uint8Array(COMMENT_POLICY_SNAPSHOT_POD_SIZE)
    pod[0] = 1 // anonymousCommentsEnabled
    pod[1] = 1 // publicCommentsEnabled
    pod[2] = 1 // zkAnonymousEnabled
    pod[3] = 4 // defaultAuthorMode = zk_anonymous
    pod[4] = 1 // zkProdEnabled
    pod[5] = 1 // zkProdNativeVerifierConfigured
    pod[6] = 1 // zkProdTrustedSetupVerified
    pod[7] = 1 // zkProdCredentialRequired
    pod[8] = 1 // zkProdCredentialRootReady
    writeInt32(pod, 9, 2500)
    writeInt32(pod, 13, 10000)
    const languages = textBytes('zh-CN\nen')
    const snapshotHash = textBytes('9'.repeat(64))
    writeSliceRef(pod, 17, 0, languages.byteLength)
    writeSliceRef(pod, 25, languages.byteLength, snapshotHash.byteLength)
    writeSliceRef(pod, 33, languages.byteLength + snapshotHash.byteLength, 0)

    const result = mapCommentPolicySnapshotFromPayload(buildPayload(
      pod,
      blobParts(languages, snapshotHash)
    ))

    expect(result).toEqual({
      anonymousCommentsEnabled: true,
      publicCommentsEnabled: true,
      zkAnonymousEnabled: true,
      defaultAuthorMode: 'zk_anonymous',
      supportedDisplayLanguages: ['zh-CN', 'en'],
      snapshotHash: '9'.repeat(64),
      commentMaxChars: 2500,
      commentMaxUtf8Bytes: 10000,
      zkProdEnabled: true,
      zkProdNativeVerifierConfigured: true,
      zkProdTrustedSetupVerified: true,
      zkProdCredentialRequired: true,
      zkProdCredentialRootReady: true,
      zkProdUnavailableReason: ''
    })
  })

  it('decodes legacy padded policy snapshot payloads from running dev backends', () => {
    const pod = new Uint8Array(48)
    pod[0] = 1
    pod[1] = 1
    pod[2] = 1
    pod[3] = 4
    pod[4] = 1
    pod[5] = 1
    pod[6] = 1
    pod[7] = 1
    pod[8] = 1
    writeInt32(pod, 12, 2500)
    writeInt32(pod, 16, 10000)
    const languages = textBytes('zh-CN\nen')
    const snapshotHash = textBytes('9'.repeat(64))
    writeSliceRef(pod, 20, 0, languages.byteLength)
    writeSliceRef(pod, 28, languages.byteLength, snapshotHash.byteLength)
    writeSliceRef(pod, 36, languages.byteLength + snapshotHash.byteLength, 0)

    const result = mapCommentPolicySnapshotFromPayload(buildPayload(
      pod,
      blobParts(languages, snapshotHash)
    ))

    expect(result.commentMaxChars).toBe(2500)
    expect(result.commentMaxUtf8Bytes).toBe(10000)
    expect(result.supportedDisplayLanguages).toEqual(['zh-CN', 'en'])
    expect(result.snapshotHash).toBe('9'.repeat(64))
    expect(result.defaultAuthorMode).toBe('zk_anonymous')
  })

  it('decodes legacy policy snapshots without configurable comment limits', () => {
    const pod = new Uint8Array(33)
    pod[0] = 1
    pod[1] = 1
    pod[2] = 0
    pod[3] = 1
    pod[4] = 1
    pod[5] = 1
    pod[6] = 1
    pod[7] = 1
    pod[8] = 1
    const languages = textBytes('zh-CN\nen')
    const snapshotHash = textBytes('9'.repeat(64))
    writeSliceRef(pod, 9, 0, languages.byteLength)
    writeSliceRef(pod, 17, languages.byteLength, snapshotHash.byteLength)
    writeSliceRef(pod, 25, languages.byteLength + snapshotHash.byteLength, 0)

    const result = mapCommentPolicySnapshotFromPayload(buildPayload(
      pod,
      blobParts(languages, snapshotHash)
    ))

    expect(result.commentMaxChars).toBe(1000)
    expect(result.commentMaxUtf8Bytes).toBe(4096)
    expect(result.supportedDisplayLanguages).toEqual(['zh-CN', 'en'])
    expect(result.snapshotHash).toBe('9'.repeat(64))
    expect(result.defaultAuthorMode).toBe('anonymous')
  })

  it('rejects invalid policy flag bytes', () => {
    const pod = new Uint8Array(COMMENT_POLICY_SNAPSHOT_POD_SIZE)
    pod[0] = 2
    expect(() => mapCommentPolicySnapshotFromPayload(buildPayload(pod, blobBuf('')))).toThrow()
  })

  it('rejects retired author mode bytes', () => {
    const pod = new Uint8Array(COMMENT_POLICY_SNAPSHOT_POD_SIZE)
    pod[0] = 1
    pod[1] = 1
    pod[2] = 1
    pod[3] = 2

    expect(() => mapCommentPolicySnapshotFromPayload(buildPayload(pod, blobBuf('')))).toThrow()
  })
})

// ---------------------------------------------------------------------------
// anonymous privacy POD response adapters
// ---------------------------------------------------------------------------
describe('anonymous privacy binary adapters', () => {
  it('decodes credential issue response without exposing reversible identity', () => {
    const pod = new Uint8Array(ANONYMOUS_CREDENTIAL_ISSUE_RESPONSE_POD_SIZE)
    const circuit = textBytes('zk-comment-v2')
    const level = textBytes('strong_anonymous')
    const issuerPublicKeyId = textBytes('issuer-key-2026q2')
    const issuerSignature = new Uint8Array([7, 8, 9])
    const blob = buildPayload(circuit, level, issuerPublicKeyId, issuerSignature)

    writeInt64(pod, 0, 20260618n)
    writeInt64(pod, 8, 1780000000000n)
    writeInt32(pod, 16, 7)
    writeUint16(pod, 20, 3)
    writeSliceRef(pod, 24, 0, circuit.length)
    writeSliceRef(pod, 32, circuit.length, level.length)
    writeSliceRef(pod, 40, circuit.length + level.length, issuerPublicKeyId.length)
    writeSliceRef(pod, 48, circuit.length + level.length + issuerPublicKeyId.length, issuerSignature.length)

    const result = mapAnonymousCredentialIssueResponseFromPayload(buildPayload(pod, blobParts(blob)))

    expect(result.credentialEpoch).toBe(20260618)
    expect(result.rootExpiresAtUnixMs).toBe(1780000000000)
    expect(result.circuitNumericId).toBe(7)
    expect(result.publicInputLayoutVersion).toBe(3)
    expect(result.circuitId).toBe('zk-comment-v2')
    expect(result.credentialLevel).toBe('strong_anonymous')
    expect(result.issuerPublicKeyId).toBe('issuer-key-2026q2')
    expect([...result.issuerSignature]).toEqual([7, 8, 9])
    expect(JSON.stringify(result)).not.toContain('userId')
    expect(JSON.stringify(result)).not.toContain('credentialCommitment')
  })

  it('decodes root snapshot, ticket response, and privacy state snapshots', () => {
    const rootPod = new Uint8Array(ANONYMOUS_CREDENTIAL_ROOT_SNAPSHOT_POD_SIZE)
    const circuit = textBytes('zk-comment-v2')
    const vk = textBytes('vk-sha256')
    const issuerPublicKeyHash = textBytes('issuer-public-key-hash')
    const credentialRoot = new Uint8Array([1, 2])
    const revocationRoot = new Uint8Array([3, 4])
    const metadata = new Uint8Array([5, 6])
    const rootBlob = buildPayload(circuit, vk, issuerPublicKeyHash, credentialRoot, revocationRoot, metadata)
    writeInt64(rootPod, 0, 20260618n)
    writeInt64(rootPod, 8, 1780000000000n)
    writeInt64(rootPod, 16, 1780003600000n)
    writeInt32(rootPod, 24, 7)
    writeUint16(rootPod, 28, 3)
    writeByte(rootPod, 30, 1)
    writeByte(rootPod, 31, 1)
    writeSliceRef(rootPod, 32, 0, circuit.length)
    writeSliceRef(rootPod, 40, circuit.length, vk.length)
    writeSliceRef(rootPod, 48, circuit.length + vk.length, issuerPublicKeyHash.length)
    writeSliceRef(rootPod, 56, circuit.length + vk.length + issuerPublicKeyHash.length, credentialRoot.length)
    writeSliceRef(rootPod, 64, circuit.length + vk.length + issuerPublicKeyHash.length + credentialRoot.length, revocationRoot.length)
    writeSliceRef(rootPod, 72, circuit.length + vk.length + issuerPublicKeyHash.length + credentialRoot.length + revocationRoot.length, metadata.length)

    const root = mapAnonymousCredentialRootSnapshotFromPayload(buildPayload(rootPod, blobParts(rootBlob)))
    expect(root.rootGraceExpiresAtUnixMs).toBe(1780003600000)
    expect(root.zkAnonymousEnabled).toBe(true)
    expect(root.verifierConfigured).toBe(true)
    expect(root.verifyingKeyHash).toBe('vk-sha256')
    expect(root.issuerPublicKeyHash).toBe('issuer-public-key-hash')
    expect([...root.credentialRoot]).toEqual([1, 2])
    expect([...root.revocationRoot]).toEqual([3, 4])
    expect([...root.circuitMetadata]).toEqual([5, 6])

    const ticketPod = new Uint8Array(ANONYMOUS_COMMENT_TICKET_RESPONSE_POD_SIZE)
    const ticketLevel = textBytes('strong_anonymous')
    const ticket = new Uint8Array([25, 26])
    const moderationHash = new Uint8Array([27, 28])
    expect(ANONYMOUS_COMMENT_TICKET_RESPONSE_POD_SIZE).toBe(40)
    const ticketBlob = buildPayload(ticketLevel, ticket, moderationHash)
    writeInt64(ticketPod, 0, 20260618n)
    writeInt64(ticketPod, 8, 1780000005000n)
    writeSliceRef(ticketPod, 16, 0, ticketLevel.length)
    writeSliceRef(ticketPod, 24, ticketLevel.length, ticket.length)
    writeSliceRef(ticketPod, 32, ticketLevel.length + ticket.length, moderationHash.length)

    const ticketResponse = mapAnonymousCommentTicketResponseFromPayload(buildPayload(ticketPod, blobParts(ticketBlob)))
    expect(ticketResponse.credentialLevel).toBe('strong_anonymous')
    expect([...ticketResponse.ticket]).toEqual([25, 26])
    expect([...ticketResponse.moderationSubjectHash]).toEqual([27, 28])

    const statePod = new Uint8Array(ANONYMOUS_PRIVACY_STATE_SNAPSHOT_POD_SIZE)
    const status = textBytes('active')
    const stateBlob = buildPayload(circuit, vk, status, ticketLevel)
    writeInt64(statePod, 0, 20260618n)
    writeInt64(statePod, 8, 1780000000000n)
    writeInt64(statePod, 16, 1780000005000n)
    writeInt32(statePod, 24, 7)
    writeUint16(statePod, 28, 3)
    writeByte(statePod, 30, 1)
    writeByte(statePod, 31, 0)
    writeByte(statePod, 32, 1)
    writeSliceRef(statePod, 34, 0, circuit.length)
    writeSliceRef(statePod, 42, circuit.length, vk.length)
    writeSliceRef(statePod, 50, circuit.length + vk.length, status.length)
    writeSliceRef(statePod, 58, circuit.length + vk.length + status.length, ticketLevel.length)

    const state = mapAnonymousPrivacyStateSnapshotFromPayload(buildPayload(statePod, blobParts(stateBlob)))
    expect(state.hasActiveCredential).toBe(true)
    expect(state.canIssueCredential).toBe(false)
    expect(state.canSubmitAnonymousComment).toBe(true)
    expect(state.credentialStatus).toBe('active')
  })

  it('decodes circuit-friendly revocation witness responses', () => {
    const pod = new Uint8Array(ANONYMOUS_CREDENTIAL_REVOCATION_WITNESS_RESPONSE_POD_SIZE)
    const algorithm = textBytes('circuit-friendly-non-membership.v1')
    const revocationRoot = new Uint8Array([1, 2, 3])
    const issuerPublicKeyHash = textBytes('issuer-public-key-hash')
    const handle = new Uint8Array([4, 5, 6])
    const leafKey = new Uint8Array([7, 8])
    const witnessHash = new Uint8Array([9, 10, 11])
    const siblings = new Uint8Array(64).fill(12)
    const blob = buildPayload(algorithm, revocationRoot, issuerPublicKeyHash, handle, leafKey, witnessHash, siblings)

    writeInt64(pod, 0, 20260618n)
    writeUint16(pod, 8, 2)
    writeUint16(pod, 10, 0)
    writeInt32(pod, 12, 2)
    writeSliceRef(pod, 16, 0, algorithm.length)
    writeSliceRef(pod, 24, algorithm.length, revocationRoot.length)
    writeSliceRef(pod, 32, algorithm.length + revocationRoot.length, issuerPublicKeyHash.length)
    writeSliceRef(pod, 40, algorithm.length + revocationRoot.length + issuerPublicKeyHash.length, handle.length)
    writeSliceRef(pod, 48, algorithm.length + revocationRoot.length + issuerPublicKeyHash.length + handle.length, leafKey.length)
    writeSliceRef(pod, 56, algorithm.length + revocationRoot.length + issuerPublicKeyHash.length + handle.length + leafKey.length, witnessHash.length)
    writeSliceRef(pod, 64, algorithm.length + revocationRoot.length + issuerPublicKeyHash.length + handle.length + leafKey.length + witnessHash.length, siblings.length)

    const response = mapAnonymousCredentialRevocationWitnessResponseFromPayload(buildPayload(pod, blobParts(blob)))

    expect(response.credentialEpoch).toBe(20260618)
    expect(response.algorithmId).toBe('circuit-friendly-non-membership.v1')
    expect(response.pathDepth).toBe(2)
    expect(response.issuerPublicKeyHash).toBe('issuer-public-key-hash')
    expect([...response.revocationRoot]).toEqual([1, 2, 3])
    expect([...response.revocationHandleHash]).toEqual([4, 5, 6])
    expect([...response.leafKey]).toEqual([7, 8])
    expect([...response.witnessHash]).toEqual([9, 10, 11])
    expect(response.siblingHashes).toHaveLength(64)
  })

  it('rejects malformed, trailing, and oversized anonymous privacy payloads', () => {
    const pod = new Uint8Array(ANONYMOUS_COMMENT_TICKET_RESPONSE_POD_SIZE)
    writeSliceRef(pod, 16, 99, 4)
    expect(() => mapAnonymousCommentTicketResponseFromPayload(buildPayload(pod, blobBuf('ok')))).toThrow()

    const validPod = new Uint8Array(ANONYMOUS_COMMENT_TICKET_RESPONSE_POD_SIZE)
    writeSliceRef(validPod, 16, 0, 0)
    expect(() => mapAnonymousCommentTicketResponseFromPayload(buildPayload(validPod, blobBuf(''), byteBuf(1)))).toThrow()

    const oversizedBlob = new Uint8Array(20 * 1024)
    const oversizedPod = new Uint8Array(ANONYMOUS_COMMENT_TICKET_RESPONSE_POD_SIZE)
    writeSliceRef(oversizedPod, 24, 0, oversizedBlob.length)
    expect(() => mapAnonymousCommentTicketResponseFromPayload(buildPayload(oversizedPod, blobParts(oversizedBlob)))).toThrow()
  })
})

// ---------------------------------------------------------------------------
// mapThreadReplyCursorFromPodPayload
// ---------------------------------------------------------------------------
describe('mapThreadReplyCursorFromPodPayload', () => {
  it('returns empty cursor', () => {
    // rootId(int64) + nextCursor(int64) + hasMore(byte) + count(int32)
    const payload = buildPayload(
      int64Buf(100n),  // rootId
      int64Buf(0n),    // nextCursor → null
      byteBuf(0),      // hasMore
      int32Buf(0)      // count
    )
    const result = mapThreadReplyCursorFromPodPayload(payload)
    expect(result.nextCursor).toBeNull()
    expect(result.data).toEqual([])
  })

  it('back-fills rootId from header when reply rootId is 0', () => {
    const replyPod = new Uint8Array(COMMENT_REPLY_ITEM_POD_SIZE)
    writeInt64(replyPod, 0, 10n)   // id
    writeInt64(replyPod, 16, 0n)   // rootId = 0 → should be filled with header rootId
    const payload = buildPayload(
      int64Buf(42n),   // rootId (header)
      int64Buf(0n),    // nextCursor
      byteBuf(0),      // hasMore
      int32Buf(1),     // count = 1
      replyPod,
      commentItemBlob('', 'alice')
    )
    const result = mapThreadReplyCursorFromPodPayload(payload)
    expect(result.data[0].rootId).toBe('42')
    expect(result.data[0].author.displayName).toBe('alice')
  })

  it('keeps existing rootId when non-zero', () => {
    const replyPod = new Uint8Array(COMMENT_REPLY_ITEM_POD_SIZE)
    writeInt64(replyPod, 0, 10n)
    writeInt64(replyPod, 16, 99n)  // rootId = 99 → should be kept
    const payload = buildPayload(
      int64Buf(42n), int64Buf(0n), byteBuf(0), int32Buf(1),
      replyPod, commentItemBlob('', 'alice')
    )
    const result = mapThreadReplyCursorFromPodPayload(payload)
    expect(result.data[0].rootId).toBe('99')
  })
})

// ---------------------------------------------------------------------------
// mapUserCommentCursorFromPodPayload
// ---------------------------------------------------------------------------
describe('mapUserCommentCursorFromPodPayload', () => {
  it('returns empty cursor', () => {
    const payload = buildPayload(int64Buf(0n), byteBuf(0), int32Buf(0))
    const result = mapUserCommentCursorFromPodPayload(payload)
    expect(result.data).toEqual([])
    expect(result.nextCursor).toBeNull()
  })

  it('reads a user comment entry', () => {
    expect(USER_COMMENT_POD_SIZE).toBe(460)

    const pod = new Uint8Array(USER_COMMENT_POD_SIZE)
    writeInt64(pod, 0, 77n)       // id
    writeInt32(pod, 8, 5)          // articleId
    // createTime at 12
    writeInt64(pod, 12, 1700000000000n)
    // content slice at 20: { offset: 0, length: 4 }
    writeInt32(pod, 20, 0); writeInt32(pod, 24, 4)
    // articleTitle at 28 (256 bytes)
    writeUtf8(pod, 28, 'Article Title')
    // rootId at 284
    writeInt64(pod, 284, 77n)
    writeInt32(pod, 292, 2)         // moderationStatus = Rejected
    writeByte(pod, 296, 0)          // isPubliclyVisible = false
    writeUtf8(pod, 300, 'rejected')
    writeUtf8(pod, 332, 'rejected_by_moderation')
    writeUtf8(pod, 396, '未通过审核')

    const payload = buildPayload(
      int64Buf(0n), byteBuf(0), int32Buf(1),
      pod,
      commentItemBlob('text', 'Alice')
    )
    const result = mapUserCommentCursorFromPodPayload(payload)
    expect(result.data).toHaveLength(1)
    const c = result.data[0]
    expect(c.id).toBe('77')
    expect(c.articleId).toBe(5)
    expect(c.content).toBe('text')
    expect(c.articleTitle).toBe('Article Title')
    expect(c.rootId).toBe('77')
    expect(c.author.displayName).toBe('Alice')
    expect(c.replyToAuthor).toBeNull()
    expect(c.moderationStatus).toBe(2)
    expect(c.isPubliclyVisible).toBe(false)
    expect(c.visibilityState).toBe('rejected')
    expect(c.visibilityReasonCode).toBe('rejected_by_moderation')
    expect(c.moderationStatusLabel).toBe('未通过审核')
  })
})
