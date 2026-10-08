import { COMMENT_CREATE_POD_BYTES, COMMENT_CREATE_OFFSETS } from '@/generated/commentCreateWire'
import { describe, it, expect } from 'vitest'
import {
  mapAnonymousCommentTicketResponseFromPayload,
  mapAnonymousCredentialRevocationArtifactFromPayload,
  mapAnonymousCredentialRootSnapshotFromPayload,
  mapAnonymousPrivacyStateSnapshotFromPayload,
  mapCommentCreateResultFromPayload,
  mapCommentCursorFromPodPayload,
  mapCommentChildCursorFromPayload,
  mapCommentPermalinkContextFromPayload,
  mapCommentPolicySnapshotFromPayload,
  mapCommentTreeRootCursorFromPayload,
  mapThreadReplyCursorFromPodPayload,
  mapUserCommentCursorFromPodPayload
} from '@/adapters/binary/commentAdapter'
import {
  ANONYMOUS_COMMENT_TICKET_RESPONSE_POD_SIZE,
  ANONYMOUS_CREDENTIAL_REVOCATION_ARTIFACT_POD_SIZE,
  ANONYMOUS_CREDENTIAL_ROOT_SNAPSHOT_POD_SIZE,
  ANONYMOUS_PRIVACY_STATE_SNAPSHOT_POD_SIZE,
  COMMENT_AUTHOR_VIEW_POD_SIZE,
  COMMENT_POLICY_SNAPSHOT_POD_SIZE,
  COMMENT_THREAD_ITEM_POD_SIZE,
  COMMENT_REPLY_ITEM_POD_SIZE,
  COMMENT_TREE_NODE_POD_SIZE,
  USER_COMMENT_POD_SIZE
} from '@/adapters/binary/types'
import {
  CommentPolicyReadiness
} from '@/contracts/commentPolicy'
import { encodeCommentCreateRequest as encodeSupportCommentCreateRequest } from '../../../support/aeds-envelope.mjs'

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

describe('mapCommentCreateResultFromPayload', () => {
  it.each([
    { moderationStatus: 0, visibilityCode: 0, visibilityState: 'pending', visible: 0 },
    { moderationStatus: 2, visibilityCode: 2, visibilityState: 'hidden', visible: 0 }
  ])('decodes the complete $visibilityState creation result', ({ moderationStatus, visibilityCode, visibilityState, visible }) => {
    const payload = new Uint8Array(40)
    writeInt64(payload, 0, 101n)
    writeInt64(payload, 8, 100n)
    writeInt64(payload, 16, 99n)
    writeInt64(payload, 24, 1784510400000n)
    writeInt32(payload, 32, moderationStatus)
    payload[36] = visibilityCode
    payload[37] = visible
    payload[38] = 1
    payload[39] = 1

    expect(mapCommentCreateResultFromPayload(payload)).toEqual({
      commentId: '101',
      rootId: '100',
      parentId: '99',
      createdAtUtc: '2026-07-20T01:20:00.000Z',
      moderationStatus,
      visibilityState,
      isPubliclyVisible: false,
      idempotencyReplay: true
    })
  })
})

function lengthPrefixed(payload: Uint8Array): Uint8Array {
  const lenBuf = new Uint8Array(4); writeInt32(lenBuf, 0, payload.length)
  return buildPayload(lenBuf, payload)
}

function commentAuthorPayload(displayName: string, mode: 'legacy_server_visible_pseudonymous' | 'public' | 'zk_anonymous' = 'public'): Uint8Array {
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

function commentTreeNodeRecord(input: {
  id: bigint
  parentId?: bigint
  rootId: bigint
  depth: number
  childCount?: number
  isEdited?: boolean
  content?: string
}): Uint8Array {
  const pod = new Uint8Array(COMMENT_TREE_NODE_POD_SIZE)
  const content = input.content ?? ''
  writeInt64(pod, 0, input.id)
  writeInt64(pod, 8, input.parentId ?? 0n)
  writeInt64(pod, 16, input.rootId)
  writeInt64(pod, 24, input.parentId ?? 0n)
  writeInt32(pod, 32, input.depth)
  writeInt32(pod, 36, input.childCount ?? 0)
  writeByte(pod, 41, (input.childCount ?? 0) > 0 ? 1 : 0)
  writeUint16(pod, 42, input.isEdited ? 1 : 0)
  writeSliceRef(pod, 52, 0, textBytes(content).length)
  return buildPayload(pod, commentItemBlob(content))
}

describe('recursive comment tree binary adapters', () => {
  it('decodes the edited marker from the comment tree POD flags', () => {
    const payload = buildPayload(
      int64Buf(0n), byteBuf(0), int32Buf(1),
      commentTreeNodeRecord({ id: 101n, rootId: 101n, depth: 0, isEdited: true, content: 'edited comment' }),
      byteBuf(0), new Uint8Array(3)
    )

    expect(mapCommentTreeRootCursorFromPayload(payload).data[0]?.node).toMatchObject({
      id: '101',
      content: 'edited comment',
      isEdited: true
    })
  })

  it('decodes a root with only direct children and preserves 64-bit ids as strings', () => {
    const rootId = 9007199254740993n
    const payload = buildPayload(
      int64Buf(0n), byteBuf(0), int32Buf(1),
      commentTreeNodeRecord({ id: rootId, rootId, depth: 0, childCount: 2, content: 'root' }),
      byteBuf(1), new Uint8Array(3),
      commentTreeNodeRecord({ id: rootId + 1n, parentId: rootId, rootId, depth: 1, childCount: 1, content: 'child' })
    )

    const result = mapCommentTreeRootCursorFromPayload(payload)
    expect(result.data[0]?.node.id).toBe(rootId.toString())
    expect(result.data[0]?.childrenPreview[0]?.parentId).toBe(rootId.toString())
    expect(result.data[0]?.childrenPreview[0]?.depth).toBe(1)
    expect(result.data[0]?.childrenPreview[0]?.childCount).toBe(1)
  })

  it('rejects a child cursor whose node is attached to another parent', () => {
    const payload = buildPayload(
      int64Buf(10n), int64Buf(1n), int64Buf(0n), int32Buf(1), byteBuf(0), new Uint8Array(3),
      commentTreeNodeRecord({ id: 12n, parentId: 11n, rootId: 1n, depth: 2 })
    )
    expect(() => mapCommentChildCursorFromPayload(payload)).toThrow('comment_child_cursor_parent_invalid')
  })

  it('decodes permalink ancestors, target, and sibling window without exposing unavailable targets', () => {
    const found = buildPayload(
      int64Buf(3n), int64Buf(1n), int32Buf(2), int32Buf(1), new Uint8Array([0, 1, 0, 1]), new Uint8Array(4),
      commentTreeNodeRecord({ id: 1n, rootId: 1n, depth: 0 }),
      commentTreeNodeRecord({ id: 2n, parentId: 1n, rootId: 1n, depth: 1 }),
      commentTreeNodeRecord({ id: 3n, parentId: 2n, rootId: 1n, depth: 2 }),
      commentTreeNodeRecord({ id: 4n, parentId: 2n, rootId: 1n, depth: 2 })
    )
    const result = mapCommentPermalinkContextFromPayload(found)
    expect(result.status).toBe('found')
    expect(result.ancestors.map((node) => node.id)).toEqual(['1', '2'])
    expect(result.target?.id).toBe('3')
    expect(result.siblings[0]?.id).toBe('4')

    const unavailable = buildPayload(int64Buf(0n), int64Buf(0n), int32Buf(0), int32Buf(0), new Uint8Array([1, 0, 0, 0]), new Uint8Array(4))
    expect(mapCommentPermalinkContextFromPayload(unavailable)).toEqual({
      status: 'unavailable', targetId: null, rootId: null, ancestors: [], target: null, siblings: [],
      hasPreviousSiblings: false, hasNextSiblings: false
    })

    const leakingUnavailable = buildPayload(
      int64Buf(3n), int64Buf(1n), int32Buf(0), int32Buf(0),
      new Uint8Array([1, 0, 0, 0]), new Uint8Array(4)
    )
    expect(() => mapCommentPermalinkContextFromPayload(leakingUnavailable))
      .toThrow('comment_permalink_unavailable_shape_invalid')
  })

  it('keeps an ancestor path deeper than ten levels in server order', () => {
    const rootId = 100n
    const ancestors = Array.from({ length: 10 }, (_, depth) => commentTreeNodeRecord({
      id: rootId + BigInt(depth),
      parentId: depth === 0 ? undefined : rootId + BigInt(depth - 1),
      rootId,
      depth
    }))
    const target = commentTreeNodeRecord({
      id: rootId + 10n,
      parentId: rootId + 9n,
      rootId,
      depth: 10
    })
    const payload = buildPayload(
      int64Buf(rootId + 10n), int64Buf(rootId), int32Buf(10), int32Buf(0),
      new Uint8Array([0, 1, 0, 0]), new Uint8Array(4),
      ...ancestors,
      target
    )

    const result = mapCommentPermalinkContextFromPayload(payload)
    expect(result.ancestors).toHaveLength(10)
    expect(result.ancestors.map((node) => node.depth)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(result.target?.depth).toBe(10)
  })
})

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
  it('uses the compact current support encoder with a sole reply comment target', () => {
    const payload = encodeSupportCommentCreateRequest({
      articleId: 9,
      content: 'reply through comment id',
      parentId: '100',
      rootId: '90',
      replyToCommentId: '80',
      authorMode: 'zk_anonymous',
      publicSendExplicitlySelected: false
    })
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)

    expect(view.getInt32(0, true)).toBe(9)
    expect(COMMENT_CREATE_POD_BYTES).toBeLessThan(80)
    expect(view.getBigInt64(COMMENT_CREATE_OFFSETS.replyToCommentId, true)).toBe(80n)
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
      zkProdUnavailableReason: '',
      zkProdReadiness: CommentPolicyReadiness.Ready
    })
  })

  it.each(['dev_verifier_disallowed', 'legacy_fallback_disallowed', 'credential_unready'])('rejects retired product readiness reason %s on the wire', reason => {
    const pod = new Uint8Array(COMMENT_POLICY_SNAPSHOT_POD_SIZE)
    pod.fill(1, 0, 9)
    pod[3] = 4
    writeInt32(pod, 9, 2500)
    writeInt32(pod, 13, 10000)
    const language = textBytes('en')
    const hash = textBytes('9'.repeat(64))
    const unavailable = textBytes(reason)
    writeSliceRef(pod, 17, 0, language.length)
    writeSliceRef(pod, 25, language.length, hash.length)
    writeSliceRef(pod, 33, language.length + hash.length, unavailable.length)
    expect(() => mapCommentPolicySnapshotFromPayload(buildPayload(pod, blobParts(language, hash, unavailable)))).toThrow('comment_policy_snapshot_fields_invalid')
  })

  it.each(['zero-chars', 'hard-chars', 'zero-bytes', 'hard-bytes', 'padded-offsets', 'missing-hash', 'missing-language', 'missing-reason-ref', 'trailing-blob', 'invalid-utf8'])('rejects a current policy with %s', defect => {
    const pod = new Uint8Array(COMMENT_POLICY_SNAPSHOT_POD_SIZE)
    pod.fill(1, 0, 9)
    pod[3] = 4
    writeInt32(pod, 9, 2500)
    writeInt32(pod, 13, 10000)
    const language = textBytes('en')
    const hash = textBytes('9'.repeat(64))
    writeSliceRef(pod, 17, 0, language.length)
    writeSliceRef(pod, 25, language.length, hash.length)
    writeSliceRef(pod, 33, language.length + hash.length, 0)
    if (defect === 'zero-chars') writeInt32(pod, 9, 0)
    if (defect === 'hard-chars') writeInt32(pod, 9, 3001)
    if (defect === 'zero-bytes') writeInt32(pod, 13, 0)
    if (defect === 'hard-bytes') writeInt32(pod, 13, 12289)
    if (defect === 'padded-offsets') { writeInt32(pod, 9, 0); writeInt32(pod, 12, 2500); writeInt32(pod, 16, 10000) }
    if (defect === 'missing-hash') writeSliceRef(pod, 25, language.length, 0)
    if (defect === 'missing-language') writeSliceRef(pod, 17, 0, 0)
    if (defect === 'missing-reason-ref') writeSliceRef(pod, 33, 0, 0)
    if (defect === 'invalid-utf8') language[0] = 0xff
    const blob = defect === 'trailing-blob' ? blobParts(language, hash, new Uint8Array([0])) : blobParts(language, hash)
    expect(() => mapCommentPolicySnapshotFromPayload(buildPayload(pod, blob))).toThrow()
  })

  it('rejects structurally valid retired 48-byte policy snapshots', () => {
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

    expect(() => mapCommentPolicySnapshotFromPayload(buildPayload(pod, blobParts(languages, snapshotHash)))).toThrow()
  })
  it('rejects retired policy snapshots without configurable comment limits', () => {
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

    expect(() => mapCommentPolicySnapshotFromPayload(buildPayload(
      pod,
      blobParts(languages, snapshotHash)
    ))).toThrow()
  })

  it('rejects structurally valid retired 33-byte policy snapshots', () => {
    const pod = new Uint8Array(33)
    pod[0] = 1
    pod[1] = 1
    pod[2] = 1
    pod[3] = 4
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

    expect(() => mapCommentPolicySnapshotFromPayload(buildPayload(pod, blobParts(languages, snapshotHash)))).toThrow()
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
  it('decodes root snapshot, ticket response, and privacy state snapshots', () => {
    const rootPod = new Uint8Array(ANONYMOUS_CREDENTIAL_ROOT_SNAPSHOT_POD_SIZE)
    const circuit = textBytes('fsus.anonymous.comment.v5')
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
    const ticketRateClass = textBytes('common')
    const ticket = new Uint8Array([25, 26])
    const moderationHash = new Uint8Array([27, 28])
    expect(ANONYMOUS_COMMENT_TICKET_RESPONSE_POD_SIZE).toBe(36)
    const ticketBlob = buildPayload(ticketRateClass, ticket, moderationHash)
    writeInt64(ticketPod, 0, 1780000005000n)
    writeByte(ticketPod, 8, 0)
    writeSliceRef(ticketPod, 12, 0, ticketRateClass.length)
    writeSliceRef(ticketPod, 20, ticketRateClass.length, ticket.length)
    writeSliceRef(ticketPod, 28, ticketRateClass.length + ticket.length, moderationHash.length)

    const ticketResponse = mapAnonymousCommentTicketResponseFromPayload(buildPayload(ticketPod, blobParts(ticketBlob)))
    expect(ticketResponse.rateClass).toBe('common')
    expect(ticketResponse.requiresModeration).toBe(false)
    expect([...ticketResponse.ticket]).toEqual([25, 26])
    expect([...ticketResponse.moderationSubjectHash]).toEqual([27, 28])

    const statePod = new Uint8Array(ANONYMOUS_PRIVACY_STATE_SNAPSHOT_POD_SIZE)
    const status = textBytes('active')
    const stateBlob = buildPayload(circuit, vk, status, textBytes('strong_anonymous'))
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
    writeSliceRef(statePod, 58, circuit.length + vk.length + status.length, textBytes('strong_anonymous').length)

    const state = mapAnonymousPrivacyStateSnapshotFromPayload(buildPayload(statePod, blobParts(stateBlob)))
    expect(state.hasActiveCredential).toBe(true)
    expect(state.canIssueCredential).toBe(false)
    expect(state.canSubmitAnonymousComment).toBe(true)
    expect(state.credentialStatus).toBe('active')
  })

  it('decodes common public revocation artifacts', () => {
    const pod = new Uint8Array(ANONYMOUS_CREDENTIAL_REVOCATION_ARTIFACT_POD_SIZE)
    const algorithm = textBytes('circuit-friendly-non-membership.v1')
    const revocationRoot = new Uint8Array(32).fill(1)
    const issuerPublicKeyHash = textBytes('issuer-public-key-hash')
    const contentHash = new Uint8Array(32).fill(2)
    const signature = new Uint8Array(32).fill(3)
    const entries = new Uint8Array(64).fill(4)
    const blob = buildPayload(algorithm, issuerPublicKeyHash, revocationRoot, contentHash, signature, entries)

    writeInt64(pod, 0, 20260618n)
    writeInt64(pod, 8, 2n)
    writeInt64(pod, 16, 0n)
    writeInt64(pod, 24, 1780000000000n)
    writeInt32(pod, 32, 2)
    writeUint16(pod, 36, 128)
    pod[38] = 1
    let offset = 0
    for (const [at, bytes] of [[40, algorithm], [48, issuerPublicKeyHash], [56, revocationRoot], [64, contentHash], [72, signature], [80, entries]] as const) {
      writeSliceRef(pod, at, offset, bytes.length)
      offset += bytes.length
    }

    const response = mapAnonymousCredentialRevocationArtifactFromPayload(buildPayload(pod, blobParts(blob)))

    expect(response.credentialEpoch).toBe(20260618)
    expect(response.algorithmId).toBe('circuit-friendly-non-membership.v1')
    expect(response.pathDepth).toBe(128)
    expect(response.version).toBe(2)
    expect(response.kind).toBe(1)
    expect(response.issuerPublicKeyHash).toBe('issuer-public-key-hash')
    expect(response.revocationRoot).toHaveLength(32)
    expect(response.entryHashes).toHaveLength(64)
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
  it('returns empty thread reply cursor', () => {
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
  it('returns empty user comment cursor', () => {
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
