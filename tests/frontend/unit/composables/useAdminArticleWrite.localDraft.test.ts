import { describe, expect, it } from 'vitest'
import {
  decodeLocalDraftMetadata,
  encodeLocalDraftMetadata,
  normalizeLocalDraftMetadata,
  resolveLocalDraftRecovery,
  toLocalDraftMetadata
} from '@/composables/useAdminArticleWrite'
import { decodePublicAotPayload, encodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'

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
  isEdit: true,
  source: 'local' as const,
  clientRevision: 'revision-1'
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
})
