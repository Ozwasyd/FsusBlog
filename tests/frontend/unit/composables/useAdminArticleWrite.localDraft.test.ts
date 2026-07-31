import { describe, expect, it } from 'vitest'
import {
  parseArticleRevisionConflictDetails,
  parseServerDraftConflictDetails,
  shouldRetryServerDraftSave
} from '@/composables/useAdminArticleWrite'
import { BinaryTransportError } from '@/services/binaryTransport'

describe('admin article draft conflict boundaries', () => {
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
