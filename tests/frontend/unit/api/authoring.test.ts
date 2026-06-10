import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkArticlePrepublish,
  cleanupOrphanAssets,
  CommentModerationStatus,
  discardServerDraft,
  exportArticleContent,
  exportContentBackup,
  getAuthorAnalytics,
  getArticleRevision,
  getModerationDictionarySnapshot,
  getServerDraft,
  importArticleContent,
  listAdminCategories,
  listAdminTags,
  listArticleRevisions,
  listAssetLibrary,
  listCommentModerationQueue,
  moderateComment,
  moderateCommentsBulk,
  previewArticleDraft,
  reindexArticleAssets,
  rollbackArticleRevision,
  saveServerDraft
} from '@/api/authoring'

const fetchMock = vi.fn()

describe('authoring API (server drafts)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch
  })

  it('saveServerDraft posts JSON author draft payload', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
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
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const saved = await saveServerDraft({
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

    expect(saved.status).toBe(0)
    expect(fetchMock).toHaveBeenCalledWith('/api/author/drafts', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: expect.stringContaining('"status":0')
    }))
  })

  it('getServerDraft returns null for empty draft envelope without throwing', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true, data: null }), { status: 200 }))

    await expect(getServerDraft('missing')).resolves.toBeNull()
  })

  it('discardServerDraft returns the discarded flag', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { discarded: true }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(discardServerDraft('fsus:article-draft:create')).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('/api/author/drafts/fsus%3Aarticle-draft%3Acreate', expect.objectContaining({
      method: 'DELETE',
      credentials: 'include'
    }))
  })

  it('previewArticleDraft posts the private preview payload', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        html: '<article data-preview-only="true"><h1>Draft</h1></article>',
        plainText: 'Draft body',
        issues: [{ severity: 'warning', code: 'summary_missing', message: '补齐摘要' }]
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const preview = await previewArticleDraft({
      draftKey: 'fsus:article-draft:create',
      articleId: null,
      title: 'Draft',
      content: '## Draft body',
      summary: null,
      coverImageUrl: null,
      categoryId: 1,
      tagIds: [],
      clientRevision: 'rev-1',
      status: 0,
      scheduledPublishAt: null
    })

    expect(preview.html).toContain('data-preview-only')
    expect(preview.issues[0]?.code).toBe('summary_missing')
    expect(fetchMock).toHaveBeenCalledWith('/api/author/preview', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: expect.stringContaining('"content":"## Draft body"')
    }))
  })

  it('checkArticlePrepublish posts the publish readiness payload', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        canPublish: false,
        issues: [{ severity: 'error', code: 'title_invalid', message: '标题非法' }]
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const result = await checkArticlePrepublish({
      draftKey: 'fsus:article-draft:create',
      articleId: null,
      title: '',
      content: 'Body',
      summary: null,
      coverImageUrl: null,
      categoryId: 1,
      tagIds: [],
      clientRevision: 'rev-1',
      status: 2,
      scheduledPublishAt: null,
      warningOverrideReason: 'manual review accepted missing summary'
    })

    expect(result.canPublish).toBe(false)
    expect(result.issues[0]?.code).toBe('title_invalid')
    expect(fetchMock).toHaveBeenCalledWith('/api/author/prepublish-check', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: expect.stringContaining('"warningOverrideReason":"manual review accepted missing summary"')
    }))
  })

  it('listAssetLibrary fetches reusable author assets', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: [{
        id: 1,
        url: '/uploads/illustration/cover.webp',
        altText: 'Cover',
        sourceArticleId: 7,
        referenceCount: 2,
        sha256: 'hash',
        updatedAt: '2026-05-18T17:40:00Z'
      }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const assets = await listAssetLibrary()

    expect(assets[0]?.url).toBe('/uploads/illustration/cover.webp')
    expect(fetchMock).toHaveBeenCalledWith('/api/author/assets', expect.objectContaining({
      credentials: 'include'
    }))
  })

  it('reindexArticleAssets rebuilds the asset library from an article', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: []
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(reindexArticleAssets(7)).resolves.toEqual([])
    expect(fetchMock).toHaveBeenCalledWith('/api/author/articles/7/assets/reindex', expect.objectContaining({
      method: 'POST',
      credentials: 'include'
    }))
  })

  it('cleanupOrphanAssets deletes zero-reference library rows', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { deleted: 3 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(cleanupOrphanAssets()).resolves.toBe(3)
    expect(fetchMock).toHaveBeenCalledWith('/api/author/assets/orphans', expect.objectContaining({
      method: 'DELETE',
      credentials: 'include'
    }))
  })

  it('listAdminCategories fetches management taxonomy counts', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: [{
        id: 1,
        name: 'Drafts',
        publicArticleCount: 0,
        draftArticleCount: 2,
        scheduledArticleCount: 0,
        archivedArticleCount: 1,
        totalBlockingArticleCount: 3,
        canDelete: false
      }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const categories = await listAdminCategories()
    expect(categories[0]?.totalBlockingArticleCount).toBe(3)
    expect(fetchMock).toHaveBeenCalledWith('/api/author/taxonomy/categories', expect.objectContaining({
      credentials: 'include'
    }))
  })

  it('listAdminTags fetches management taxonomy counts', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: [{
        id: 2,
        name: 'wip',
        publicArticleCount: 0,
        draftArticleCount: 1,
        scheduledArticleCount: 1,
        archivedArticleCount: 0,
        deletedArticleCount: 0,
        totalBlockingArticleCount: 2,
        canDelete: false
      }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const tags = await listAdminTags()
    expect(tags[0]?.totalBlockingArticleCount).toBe(2)
    expect(fetchMock).toHaveBeenCalledWith('/api/author/taxonomy/tags', expect.objectContaining({
      credentials: 'include'
    }))
  })

  it('getAuthorAnalytics fetches author performance signals', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        publishedArticles: 4,
        draftArticles: 1,
        scheduledArticles: 1,
        archivedArticles: 0,
        totalHumanReadEvents: 9,
        totalSearchableArticles: 4,
        aotHitRate: 0.75,
        averageDwellMs: 32000,
        readingCompletionRate: 0.5,
        topSearchKeywords: [{ label: 'aot', count: 3 }],
        topSourceRoutes: [{ label: '/article/1', count: 2 }],
        notFoundHotspots: [{ label: '/missing', count: 1 }],
        rumMetrics: [{ name: 'web_vital_lcp', count: 5, p75: 1800, average: 1400 }],
        rumPageTypes: [{ label: 'article', count: 4 }],
        rumAotSources: [{ label: 'server-aot', count: 4 }]
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const analytics = await getAuthorAnalytics()

    expect(analytics.topSearchKeywords[0]?.label).toBe('aot')
    expect(analytics.rumMetrics[0]?.name).toBe('web_vital_lcp')
    expect(fetchMock).toHaveBeenCalledWith('/api/author/analytics', expect.objectContaining({
      credentials: 'include'
    }))
  })

  it('listCommentModerationQueue fetches pending queue metrics', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        items: [{
          id: '1001',
          articleId: 7,
          articleTitle: 'Article',
          userId: 9,
          userName: 'reader',
          content: 'needs review',
          createTime: '2026-05-18T18:00:00Z',
          status: CommentModerationStatus.Pending,
          reason: 'pending_review',
          moderatedByUserId: null,
          moderatedAt: null,
          hitReasons: ['pending-review', 'model:spam_repeat'],
          submitRegion: 'CN-MAINLAND',
          submitRegionConfidence: 0.95,
          blockedRegions: [],
          regionPolicyVersion: 'region-policy-v2026-06',
          regionDecisionReason: 'region_policy_allow',
          regionCanPublish: true,
          regionRequiresManualReview: false,
          regionHideUntilReviewed: false,
          modelSignals: [{
            provider: 'mock',
            model: 'fsusblog-mock-moderation',
            contractVersion: 'fsusblog-moderation-provider-v1',
            label: 'risky',
            confidence: 0.92,
            severity: 'high',
            primaryReason: 'spam_repeat',
            needsSecondRound: true,
            riskCategories: ['spam_repeat'],
            evidenceJson: null,
            rawReason: 'mock risk signal',
            latencyMs: 3,
            status: 'ok',
            errorCode: null,
            thresholdProfile: 'default',
            createdAtUtc: '2026-05-18T18:00:01Z'
          }],
          modelLabel: 'risky',
          modelConfidence: 0.92,
          modelPrimaryReason: 'spam_repeat',
          modelProvider: 'mock',
          modelUnavailable: false
        }],
        pendingCount: 1,
        rejectedCount: 0,
        hiddenCount: 0
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const queue = await listCommentModerationQueue(CommentModerationStatus.Pending, 25)

    expect(queue.items[0]?.hitReasons).toEqual(['pending-review', 'model:spam_repeat'])
    expect(queue.items[0]?.modelLabel).toBe('risky')
    expect(fetchMock).toHaveBeenCalledWith('/api/author/comments/moderation?status=0&limit=25', expect.objectContaining({
      credentials: 'include'
    }))
  })

  it('getModerationDictionarySnapshot fetches read-only dictionary metadata', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        snapshotId: 'moderation-dictionaries:abc',
        version: 'GLOBAL-v2026-06+CN-MAINLAND-v2026-06',
        checksum: 'abc',
        createdAtUtc: '2026-06-10T00:00:00Z',
        dictionaries: [{
          dictionaryId: 'cn-mainland.political-sensitive',
          version: '2026-06-01',
          scope: 'regional',
          region: 'CN-MAINLAND',
          category: 'political_sensitive',
          source: 'internal_review',
          reviewedBy: 'engineering-preset',
          updatedAtUtc: '2026-06-01T00:00:00Z',
          checksum: 'dict',
          termCount: 1
        }],
        regionPolicies: [{
          region: 'CN-MAINLAND',
          version: 'CN-MAINLAND-v2026-06',
          inherits: ['GLOBAL'],
          dictionaryIds: ['cn-mainland.political-sensitive'],
          checksum: 'policy',
          ruleCount: 1
        }],
        lastError: null
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const snapshot = await getModerationDictionarySnapshot()

    expect(snapshot.dictionaries[0]?.termCount).toBe(1)
    expect(snapshot.regionPolicies[0]?.dictionaryIds).toEqual(['cn-mainland.political-sensitive'])
    expect(fetchMock).toHaveBeenCalledWith('/api/author/moderation/dictionaries', expect.objectContaining({
      credentials: 'include'
    }))
  })

  it('moderateComment posts single comment action with ban linkage flag', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { moderated: true }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(moderateComment('1001', {
      status: CommentModerationStatus.Hidden,
      reason: 'spam links',
      banUser: true
    }, {
      mfaProofToken: 'proof-single'
    })).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('/api/author/comments/1001/moderation', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({
        status: CommentModerationStatus.Hidden,
        reason: 'spam links',
        banUser: true
      })
    }))
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Headers
    expect(headers.get('X-Fsus-Mfa-Proof')).toBe('proof-single')
  })

  it('moderateCommentsBulk posts batch decision payload', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { updated: 2, bannedUsers: 1 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const result = await moderateCommentsBulk({
      commentIds: ['1001', '1002'],
      status: CommentModerationStatus.Rejected,
      reason: 'spam batch',
      banUsers: true
    }, {
      mfaProofToken: 'proof-bulk'
    })

    expect(result.updated).toBe(2)
    expect(fetchMock).toHaveBeenCalledWith('/api/author/comments/moderation/bulk', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({
        commentIds: ['1001', '1002'],
        status: CommentModerationStatus.Rejected,
        reason: 'spam batch',
        banUsers: true
      })
    }))
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Headers
    expect(headers.get('X-Fsus-Mfa-Proof')).toBe('proof-bulk')
  })

  it('exportArticleContent fetches Markdown frontmatter and metadata', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        fileName: 'article-7.md',
        markdownWithFrontmatter: '---\ntitle: Exported\n---\n\nBody',
        metadata: {
          sourceArticleId: 7,
          categoryId: 2,
          tagIds: [3],
          status: 2,
          scheduledPublishAt: null,
          coverImageUrl: '/uploads/illustration/cover.webp',
          revisionCount: 1,
          revisions: []
        }
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const exported = await exportArticleContent(7)

    expect(exported.metadata.tagIds).toEqual([3])
    expect(fetchMock).toHaveBeenCalledWith('/api/author/articles/7/export', expect.objectContaining({
      credentials: 'include'
    }))
  })

  it('exportContentBackup fetches the full content package', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        fileName: 'fsusblog-content-20260518190000.json',
        exportedAt: '2026-05-18T19:00:00Z',
        articles: []
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const backup = await exportContentBackup()

    expect(backup.fileName).toContain('fsusblog-content')
    expect(fetchMock).toHaveBeenCalledWith('/api/author/content/export', expect.objectContaining({
      credentials: 'include'
    }))
  })

  it('importArticleContent posts restore payload and returns revision count', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { articleId: 88, restoredRevisionCount: 2 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const imported = await importArticleContent({
      markdownWithFrontmatter: '---\ntitle: Restored\n---\n\nBody',
      publish: false,
      preserveRevisions: true
    })

    expect(imported.restoredRevisionCount).toBe(2)
    expect(fetchMock).toHaveBeenCalledWith('/api/author/articles/import', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({
        markdownWithFrontmatter: '---\ntitle: Restored\n---\n\nBody',
        publish: false,
        preserveRevisions: true
      })
    }))
  })

  it('listArticleRevisions fetches revision summaries', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: [{
        id: 11,
        articleId: 7,
        revisionNo: 2,
        title: 'Revision',
        diffSummary: 'article updated',
        createdByUserId: 1,
        createdAt: '2026-05-18T16:20:00Z'
      }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(listArticleRevisions(7)).resolves.toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/author/articles/7/revisions', expect.objectContaining({
      credentials: 'include'
    }))
  })

  it('getArticleRevision fetches comparable revision content', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        id: 11,
        articleId: 7,
        revisionNo: 2,
        title: 'Revision',
        content: 'Body',
        summary: 'Summary',
        coverImageUrl: null,
        categoryId: 1,
        tagIds: [2, 3],
        diffSummary: 'article updated',
        createdByUserId: 1,
        createdAt: '2026-05-18T16:20:00Z'
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const revision = await getArticleRevision(7, 11)

    expect(revision.content).toBe('Body')
    expect(revision.tagIds).toEqual([2, 3])
    expect(fetchMock).toHaveBeenCalledWith('/api/author/articles/7/revisions/11', expect.objectContaining({
      credentials: 'include'
    }))
  })

  it('rollbackArticleRevision posts rollback command', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { rolledBack: true }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(rollbackArticleRevision(7, 11)).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('/api/author/articles/7/revisions/11/rollback', expect.objectContaining({
      method: 'POST',
      credentials: 'include'
    }))
  })
})
