import { describe, it, expect } from 'vitest'
import {
  mapCommentCursorFromPodPayload,
  mapCommentPolicySnapshotFromPayload,
  mapThreadReplyCursorFromPodPayload,
  mapUserCommentCursorFromPodPayload
} from '@/adapters/binary/commentAdapter'
import { COMMENT_THREAD_ITEM_POD_SIZE, COMMENT_REPLY_ITEM_POD_SIZE, USER_COMMENT_POD_SIZE } from '@/adapters/binary/types'

function writeInt32(b: Uint8Array, off: number, v: number): void {
  b[off] = v & 0xff; b[off + 1] = (v >>> 8) & 0xff
  b[off + 2] = (v >>> 16) & 0xff; b[off + 3] = (v >>> 24) & 0xff
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
function blobBuf(text: string): Uint8Array {
  const enc = new TextEncoder().encode(text)
  const lenBuf = new Uint8Array(4); writeInt32(lenBuf, 0, enc.length)
  return buildPayload(lenBuf, enc)
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
      blobBuf('')       // blob
    )
    const result = mapCommentCursorFromPodPayload(payload)
    expect(result.nextCursor).toBe('777')
    expect(result.hasMore).toBe(true)
    expect(result.data).toHaveLength(1)
    expect(result.data[0].id).toBe('55')
    expect(result.data[0].author.displayName).toBe('fixture compatibility')
  })
})

// ---------------------------------------------------------------------------
// mapCommentPolicySnapshotFromPayload
// ---------------------------------------------------------------------------
describe('mapCommentPolicySnapshotFromPayload', () => {
  it('decodes composer policy before rendering comment author controls', () => {
    const pod = new Uint8Array(12)
    pod[0] = 1 // anonymousCommentsEnabled
    pod[1] = 1 // publicCommentsEnabled
    pod[2] = 1 // zkAnonymousEnabled
    pod[3] = 4 // defaultAuthorMode = zk_anonymous
    writeSliceRef(pod, 4, 0, 8)

    const result = mapCommentPolicySnapshotFromPayload(buildPayload(
      pod,
      blobBuf('zh-CN\nen')
    ))

    expect(result).toEqual({
      anonymousCommentsEnabled: true,
      publicCommentsEnabled: true,
      zkAnonymousEnabled: true,
      defaultAuthorMode: 'zk_anonymous',
      supportedDisplayLanguages: ['zh-CN', 'en']
    })
  })

  it('rejects invalid policy flag bytes', () => {
    const pod = new Uint8Array(12)
    pod[0] = 2
    expect(() => mapCommentPolicySnapshotFromPayload(buildPayload(pod, blobBuf('')))).toThrow()
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
      blobBuf('')
    )
    const result = mapThreadReplyCursorFromPodPayload(payload)
    expect(result.data[0].rootId).toBe('42')
    expect(result.data[0].author.displayName).toBe('fixture compatibility')
  })

  it('keeps existing rootId when non-zero', () => {
    const replyPod = new Uint8Array(COMMENT_REPLY_ITEM_POD_SIZE)
    writeInt64(replyPod, 0, 10n)
    writeInt64(replyPod, 16, 99n)  // rootId = 99 → should be kept
    const payload = buildPayload(
      int64Buf(42n), int64Buf(0n), byteBuf(0), int32Buf(1),
      replyPod, blobBuf('')
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
    expect(USER_COMMENT_POD_SIZE).toBe(524)

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
    // replyToUserName at 292 (64 bytes) → leave empty → null
    writeInt32(pod, 356, 2)         // moderationStatus = Rejected
    writeByte(pod, 360, 0)          // isPubliclyVisible = false
    writeUtf8(pod, 364, 'rejected')
    writeUtf8(pod, 396, 'rejected_by_moderation')
    writeUtf8(pod, 460, '未通过审核')

    const payload = buildPayload(
      int64Buf(0n), byteBuf(0), int32Buf(1),
      pod,
      blobBuf('text') // blob with 4 bytes
    )
    const result = mapUserCommentCursorFromPodPayload(payload)
    expect(result.data).toHaveLength(1)
    const c = result.data[0]
    expect(c.id).toBe('77')
    expect(c.articleId).toBe(5)
    expect(c.content).toBe('text')
    expect(c.articleTitle).toBe('Article Title')
    expect(c.rootId).toBe('77')
    expect(c.replyToUserName).toBeNull()
    expect(c.moderationStatus).toBe(2)
    expect(c.isPubliclyVisible).toBe(false)
    expect(c.visibilityState).toBe('rejected')
    expect(c.visibilityReasonCode).toBe('rejected_by_moderation')
    expect(c.moderationStatusLabel).toBe('未通过审核')
  })
})
