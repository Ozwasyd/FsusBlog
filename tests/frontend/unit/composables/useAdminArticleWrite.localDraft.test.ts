import { describe, expect, it } from 'vitest'
import {
  decodeLocalDraftMetadata,
  encodeLocalDraftMetadata,
  normalizeLocalDraftMetadata,
  parseArticleRevisionConflictDetails,
  parseServerDraftConflictDetails,
  resolveLocalDraftRecovery,
  shouldRetryServerDraftSave,
  toLocalDraftMetadata
} from '@/composables/useAdminArticleWrite'
import { decodePublicAotPayload, encodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'
import { BinaryTransportError } from '@/services/binaryTransport'

const snapshot = {
  title: 'private title',
  content: '# unpublished markdown',
  summary: 'private summary',
  coverImageUrl: '/private-cover.png',
  categoryId: 7,
  tagIds: [1, 2],
  status: 1,
  scheduledPublishAt: '2026-07-10T12:00',
  rights: {
    mode: 'custom',
    enabled: true,
    licenseType: 'all-rights-reserved',
    copyrightHolder: 'Private Holder',
    copyrightYear: 2026,
    rightsStatement: 'private rights',
    attributionTemplate: 'private attribution',
    copyPolicy: 'append-attribution',
    maxExcerptChars: 120,
    allowCodeCopy: false,
    showPublicBadge: false,
    proofBindingEnabled: true
  },
  savedAt: 1234,
  sourceArticleId: 42,
  baseRevisionId: '8123',
  isEdit: true,
  source: 'local' as const,
  clientRevision: 'revision-1',
  serverRevision: null
}

describe('admin article local draft metadata', () => {
  it('round-trips only non-recoverable metadata through the real AEDS storage codec', () => {
    const encoded = encodeLocalDraftMetadata(snapshot)
    const metadata = decodeLocalDraftMetadata(encoded)
    const rawPayload = decodePublicAotPayload<Record<string, unknown>>(encoded)

    expect(metadata).toEqual({
      schema: 'fsusblog.article-draft-metadata.v1',
      savedAt: 1234,
      sourceArticleId: 42,
      isEdit: true,
      source: 'local',
      clientRevision: 'revision-1'
    })
    expect(rawPayload).toEqual(metadata)
    for (const sensitiveKey of [
      'title',
      'content',
      'summary',
      'coverImageUrl',
      'categoryId',
      'tagIds',
      'status',
      'scheduledPublishAt',
      'rights'
    ]) {
      expect(metadata).not.toHaveProperty(sensitiveKey)
      expect(rawPayload).not.toHaveProperty(sensitiveKey)
    }
  })

  it('rejects legacy browser payloads that contain unpublished content', () => {
    expect(normalizeLocalDraftMetadata(snapshot)).toBeNull()
    expect(decodeLocalDraftMetadata(encodePublicAotPayload(snapshot))).toBeNull()
    expect(normalizeLocalDraftMetadata({
      ...toLocalDraftMetadata(snapshot),
      title: snapshot.title
    })).toBeNull()
    expect(normalizeLocalDraftMetadata(toLocalDraftMetadata(snapshot))).toEqual(toLocalDraftMetadata(snapshot))
  })

  it('never promotes local-only metadata to a restorable form snapshot', () => {
    const localMetadata = toLocalDraftMetadata(snapshot)
    const localOnly = resolveLocalDraftRecovery(localMetadata, null, () => true)

    expect(localOnly).toEqual({
      draft: null,
      savedAt: 1234,
      hasLocalMetadataWithoutRestorableDraft: true
    })

    const serverDraft = {
      ...snapshot,
      source: 'server' as const,
      savedAt: 2345
    }
    expect(resolveLocalDraftRecovery(localMetadata, serverDraft, () => true)).toEqual({
      draft: serverDraft,
      savedAt: 2345,
      hasLocalMetadataWithoutRestorableDraft: false
    })
    expect(resolveLocalDraftRecovery(localMetadata, serverDraft, () => false)).toEqual({
      draft: null,
      savedAt: 2345,
      hasLocalMetadataWithoutRestorableDraft: true
    })
  })

  it('parses authoritative coordinates for stale two-tab, delayed autosave, and retry conflicts', () => {
    const details = JSON.stringify({
      currentRevisionId: '9010',
      revisionNo: 8,
      status: 0,
      updatedAt: '2026-07-20T08:00:00.0000000Z'
    })

    expect(parseArticleRevisionConflictDetails(details)).toEqual({
      currentRevisionId: '9010',
      revisionNo: 8,
      status: 0,
      updatedAt: '2026-07-20T08:00:00.0000000Z'
    })
    expect(parseArticleRevisionConflictDetails('{"revisionNo":8}')).toBeNull()
    expect(parseArticleRevisionConflictDetails('not-json')).toBeNull()
  })

  it('parses bounded draft conflict metadata without unpublished content', () => {
    const details = JSON.stringify({
      currentServerRevision: 9,
      currentUpdatedAt: '2026-07-20T08:00:00.0000000Z',
      titleSummary: 'Current title'
    })

    expect(parseServerDraftConflictDetails(details)).toEqual({
      currentServerRevision: 9,
      currentUpdatedAt: '2026-07-20T08:00:00.0000000Z',
      titleSummary: 'Current title'
    })
    expect(parseServerDraftConflictDetails('{"currentServerRevision":0}')).toBeNull()
    expect(parseServerDraftConflictDetails('not-json')).toBeNull()
    expect(details).not.toContain('content')
    expect(details).not.toContain('rights')
  })

  it('stops automatic retries for draft conflicts but retries transient failures', () => {
    expect(shouldRetryServerDraftSave(new BinaryTransportError({
      kind: 'conflict',
      message: 'draft_conflict',
      status: 409,
      details: '{"currentServerRevision":2,"currentUpdatedAt":null,"titleSummary":null}'
    }))).toBe(false)
    expect(shouldRetryServerDraftSave(new BinaryTransportError({
      kind: 'network',
      message: 'network_unavailable'
    }))).toBe(true)
  })
})
