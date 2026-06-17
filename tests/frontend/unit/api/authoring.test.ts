import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'
import { requestBinaryOnly } from '@/services/binaryTransport'
import {
  applyIntegrityFix,
  blockAnonymousNullifier,
  getServerDraft,
  moderateComment,
  previewModerationEffectivePolicy,
  revokeAnonymousCredential,
  saveServerDraft
} from '@/api/authoring'
import { FSUS_HEADERS } from '@/api/contracts'

vi.mock('@/services/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

vi.mock('@/utils/fingerprint', () => ({
  getBrowserFp: () => 'fp-test'
}))

const binaryMock = vi.mocked(requestBinaryOnly)
const decoder = new TextDecoder()

describe('authoring API binary transport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('saveServerDraft posts an AEDS author draft request frame', async () => {
    binaryMock.mockResolvedValue({
      draftKey: 'fsus:article-draft:create',
      articleId: null,
      title: 'Draft',
      content: 'Body',
      summary: null,
      coverImageUrl: null,
      categoryId: 1,
      tagIds: [2],
      clientRevision: 'rev-1',
      status: 0,
      scheduledPublishAt: null,
      updatedAt: '2026-05-18T16:00:00Z'
    })

    await saveServerDraft({
      draftKey: 'fsus:article-draft:create',
      articleId: null,
      title: 'Draft',
      content: 'Body',
      summary: null,
      coverImageUrl: null,
      categoryId: 1,
      tagIds: [2],
      clientRevision: 'rev-1',
      status: 0,
      scheduledPublishAt: null
    })

    const call = binaryMock.mock.calls[0]?.[0]
    expect(call?.binaryUrl).toBe('/api/binary/author/drafts')
    expect(call?.frameType).toBe(FrameType.AuthorDraftResponse)
    expect(call?.requestOptions?.method).toBe('POST')
    expect((call?.requestOptions?.headers as Headers).get(FSUS_HEADERS.deviceFingerprint)).toBe('fp-test')
    expectAedsJsonBody(call?.requestOptions?.body, FrameType.AuthorDraftSaveRequest, {
      title: 'Draft',
      status: 0
    })
  })

  it('getServerDraft reads nullable draft responses through AEDS', async () => {
    binaryMock.mockResolvedValue(null)

    await expect(getServerDraft('missing')).resolves.toBeNull()

    const call = binaryMock.mock.calls[0]?.[0]
    expect(call?.binaryUrl).toBe('/api/binary/author/drafts/missing')
    expect(call?.frameType).toBe(FrameType.AuthorDraftResponse)
    expect(call?.requestOptions?.body).toBeUndefined()
  })

  it('keeps MFA proof on sensitive authoring mutations', async () => {
    binaryMock.mockResolvedValue({ status: 'applied', appliedAt: '2026-06-10T00:00:00Z', appliedCount: 1, diffs: [] })

    await applyIntegrityFix({ codes: ['orphan-asset'], confirmPhrase: 'APPLY SAFE FIX' }, { mfaProofToken: 'proof-1' })

    const call = binaryMock.mock.calls[0]?.[0]
    expect(call?.binaryUrl).toBe('/api/binary/author/integrity/fix')
    expect(call?.frameType).toBe(FrameType.IntegrityFixResponse)
    expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-1')
    expectAedsJsonBody(call?.requestOptions?.body, FrameType.IntegrityFixRequest, {
      confirmPhrase: 'APPLY SAFE FIX'
    })
  })

  it('uses moderation AEDS request and response frames', async () => {
    binaryMock.mockResolvedValue({ region: 'CN-MAINLAND', rules: [], warnings: [] })

    await previewModerationEffectivePolicy({
      regionCode: 'CN-MAINLAND',
      operatorOverrides: []
    })

    const call = binaryMock.mock.calls[0]?.[0]
    expect(call?.binaryUrl).toBe('/api/binary/author/moderation/effective-policy/preview')
    expect(call?.frameType).toBe(FrameType.ModerationEffectivePolicy)
    expectAedsJsonBody(call?.requestOptions?.body, FrameType.ModerationEffectivePolicyPreviewRequest, {
      regionCode: 'CN-MAINLAND'
    })
  })

  it('maps boolean moderation mutation responses from AEDS payloads', async () => {
    binaryMock.mockResolvedValue({ moderated: true })

    await expect(moderateComment('42', { status: 1, reason: 'reviewed' }, { mfaProofToken: 'proof-2' }))
      .resolves.toBe(true)

    const call = binaryMock.mock.calls[0]?.[0]
    expect(call?.binaryUrl).toBe('/api/binary/author/comments/42/moderation')
    expect(call?.frameType).toBe(FrameType.CommentModerationResult)
    expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-2')
    expectAedsJsonBody(call?.requestOptions?.body, FrameType.CommentModerationRequest, {
      reason: 'reviewed'
    })
  })

  it('blocks anonymous nullifiers through the authoring governance endpoint', async () => {
    binaryMock.mockResolvedValue({ applied: true })

    await expect(blockAnonymousNullifier({
      nullifierHash: 'hash_abc',
      scope: 'article:42',
      reason: 'spam wave'
    }, { mfaProofToken: 'proof-nullifier' })).resolves.toEqual({ applied: true })

    const call = binaryMock.mock.calls[0]?.[0]
    expect(call?.binaryUrl).toBe('/api/binary/author/comments/moderation/nullifiers/block')
    expect(call?.frameType).toBe(FrameType.AnonymousGovernanceActionResponse)
    expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-nullifier')
    expectAedsJsonBody(call?.requestOptions?.body, FrameType.AnonymousGovernanceActionRequest, {
      nullifierHash: 'hash_abc',
      scope: 'article:42',
      reason: 'spam wave'
    })
  })

  it('revokes anonymous credentials through the authoring governance endpoint', async () => {
    binaryMock.mockResolvedValue({ applied: true })

    await expect(revokeAnonymousCredential('88001', {
      reason: 'abuse confirmed'
    }, { mfaProofToken: 'proof-credential' })).resolves.toEqual({ applied: true })

    const call = binaryMock.mock.calls[0]?.[0]
    expect(call?.binaryUrl).toBe('/api/binary/author/comments/moderation/anonymous-credentials/88001/revoke')
    expect(call?.frameType).toBe(FrameType.AnonymousGovernanceActionResponse)
    expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-credential')
    expectAedsJsonBody(call?.requestOptions?.body, FrameType.AnonymousGovernanceActionRequest, {
      reason: 'abuse confirmed'
    })
  })

  it('does not retain the deprecated authoring JSON client in production source', () => {
    const source = readFileSync(resolve(process.cwd(), '../../src/frontend/src/api/authoring.ts'), 'utf8')
    expect(source).not.toContain('/api/author')
    expect(source).not.toContain('JsonApiResponse')
    expect(source).not.toContain('response.json')
    expect(source).not.toContain('application/json')
    expect(source).not.toContain('JSON.stringify')
  })
})

function expectAedsJsonBody(body: BodyInit | null | undefined, frameType: FrameType, expected: Record<string, unknown>): void {
  expect(body).toBeInstanceOf(ArrayBuffer)
  const bytes = new Uint8Array(body as ArrayBuffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  expect(view.getUint16(8, true)).toBe(frameType)
  const payloadLength = view.getUint32(10, true)
  const payload = JSON.parse(decoder.decode(bytes.slice(16, 16 + payloadLength)))
  expect(payload).toMatchObject(expected)
}
