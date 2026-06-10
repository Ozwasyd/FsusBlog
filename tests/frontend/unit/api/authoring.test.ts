import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkArticlePrepublish,
  cleanupOrphanAssets,
  CommentModerationStatus,
  disableModerationDictionary,
  discardServerDraft,
  enableModerationDictionary,
  exportArticleContent,
  exportContentBackup,
  getAuthorAnalytics,
  getArticleRevision,
  getModerationDictionarySnapshot,
  getModerationEffectivePolicy,
  getModerationModelStatus,
  getModerationOverview,
  getModerationRuntimeStatus,
  getServerDraft,
  importArticleContent,
  listAdminCategories,
  listAdminTags,
  listArticleRevisions,
  listAssetLibrary,
  listCommentModerationQueue,
  listModerationPolicies,
  listModerationPolicyTemplates,
  listModerationRegionGroups,
  listModerationRegions,
  moderateComment,
  moderateCommentsBulk,
  previewModerationReplay,
  previewModerationEffectivePolicy,
  previewArticleDraft,
  reindexArticleAssets,
  reloadModerationDictionaries,
  reloadModerationModel,
  rollbackArticleRevision,
  rollbackModerationDictionaries,
  rollbackModerationModel,
  setModerationGlobalState,
  setModerationModelRuntime,
  setModerationRegionState,
  saveServerDraft
} from '@/api/authoring'

const fetchMock = vi.fn()

function runtimeStatus(overrides: Record<string, unknown> = {}) {
  return {
    snapshotId: 'moderation-runtime:runtime:abc',
    globalState: 'enabled',
    regionStates: { SG: 'manual_review_only' },
    disabledDictionaryIds: ['global.scam'],
    model: {
      snapshotId: 'moderation-runtime:model:def',
      enabled: true,
      provider: 'mock',
      modelProfile: 'mock-v1',
      thresholdProfile: 'default',
      contractVersion: 'fsusblog-moderation-provider-v1',
      configChecksum: 'checksum',
      loadedAtUtc: '2026-06-10T00:00:00Z',
      loadedBy: 'admin',
      status: 'loaded',
      timeoutMs: 800,
      failOpen: true,
      externalProviderAllowed: false,
      externalProviderReviewed: false,
      lastError: null
    },
    changedAtUtc: '2026-06-10T00:00:00Z',
    changedBy: 'admin',
    reason: null,
    expiresAtUtc: null,
    lastError: null,
    ...overrides
  }
}

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
          evidencePolicy: 'redact',
          termCount: 1
        }],
        regionPolicies: [{
          region: 'CN-MAINLAND',
          version: 'CN-MAINLAND-v2026-06',
          inherits: ['GLOBAL'],
          dictionaryIds: ['cn-mainland.political-sensitive'],
          checksum: 'policy',
          ruleCount: 1,
          rules: [{ category: 'political_sensitive', submitAction: 'reject_submit', displayAction: 'geo_block' }]
        }],
        lastError: null
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const snapshot = await getModerationDictionarySnapshot()

    expect(snapshot.dictionaries[0]?.termCount).toBe(1)
    expect(snapshot.dictionaries[0]?.evidencePolicy).toBe('redact')
    expect(snapshot.regionPolicies[0]?.rules[0]?.displayAction).toBe('geo_block')
    expect(snapshot.regionPolicies[0]?.dictionaryIds).toEqual(['cn-mainland.political-sensitive'])
    expect(fetchMock).toHaveBeenCalledWith('/api/author/moderation/dictionaries', expect.objectContaining({
      credentials: 'include'
    }))
  })

  it('getModerationOverview fetches moderation console counters', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        pendingCount: 2,
        rejectedCount: 3,
        hiddenCount: 1,
        dictionaryCount: 12,
        regionPolicyCount: 5,
        mainlandStrictStatus: 'enabled',
        dictionaryLastError: null,
        modelEnabled: true,
        modelProvider: 'mock',
        modelMode: 'score-only',
        modelContractVersion: 'fsusblog-moderation-provider-v1',
        modelTimeoutMs: 800
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const overview = await getModerationOverview()

    expect(overview.mainlandStrictStatus).toBe('enabled')
    expect(fetchMock).toHaveBeenCalledWith('/api/author/moderation/overview', expect.objectContaining({
      credentials: 'include'
    }))
  })

  it('listModerationPolicies fetches region policy checks', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: [{
        region: 'CN-MAINLAND',
        version: 'CN-MAINLAND-v2026-06',
        inherits: ['GLOBAL'],
        dictionaryIds: ['cn-mainland.political-sensitive'],
        checksum: 'policy',
        ruleCount: 1,
        criticalChecks: [{ code: 'inherits-global', label: '继承 GLOBAL', status: 'ok', detail: 'CN-MAINLAND policy inherits GLOBAL' }]
      }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const policies = await listModerationPolicies()

    expect(policies[0]?.criticalChecks[0]?.status).toBe('ok')
    expect(fetchMock).toHaveBeenCalledWith('/api/author/moderation/policies', expect.objectContaining({
      credentials: 'include'
    }))
  })

  it('region catalog APIs fetch regions groups templates and effective policy preview', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: [{
          regionCode: 'CN-MAINLAND',
          displayName: 'Mainland China',
          parentRegion: null,
          primaryGroup: 'GREATER_CHINA',
          policyTemplate: 'cn-mainland-strict',
          enabled: true,
          builtin: true,
          description: 'strict'
        }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: [{
          groupCode: 'GREATER_CHINA',
          displayName: 'Greater China',
          policyTemplate: null,
          builtin: true,
          enabled: true,
          regions: ['CN-MAINLAND', 'CN-HK', 'CN-MO', 'CN-TW'],
          description: 'group only'
        }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: [{
          templateId: 'cn-mainland-strict',
          version: '2026-06',
          scope: 'region',
          region: 'CN-MAINLAND',
          regionGroup: null,
          source: 'fsusblog-engineering-preset',
          reviewedBy: 'operator-review-required',
          reviewedAtUtc: null,
          builtin: true,
          enabled: true,
          notLegalAdvice: true,
          description: 'preset',
          checksum: 'checksum',
          rules: [{ category: 'political_sensitive', submitAction: 'reject_submit', displayAction: 'geo_block' }]
        }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          region: 'CN-MAINLAND',
          displayName: 'Mainland China',
          regionGroups: ['GREATER_CHINA'],
          inheritance: [{ step: 'region-template', sourceId: 'cn-mainland-strict', sourceType: 'template', rules: [] }],
          rules: [{ category: 'political_sensitive', submitAction: 'reject_submit', displayAction: 'geo_block', sourceId: 'cn-mainland-strict', sourceType: 'template' }],
          checksum: 'effective',
          warnings: []
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          region: 'CUSTOM-US-CAMPUS',
          displayName: 'CUSTOM-US-CAMPUS',
          regionGroups: [],
          inheritance: [{ step: 'operator-preview', sourceId: 'operator-overrides', sourceType: 'operator_override', rules: [] }],
          rules: [{ category: 'harassment', submitAction: 'manual_review', displayAction: 'manual_review_no_public_display', sourceId: 'operator-overrides', sourceType: 'operator_override' }],
          checksum: 'preview',
          warnings: []
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const regions = await listModerationRegions()
    const groups = await listModerationRegionGroups()
    const templates = await listModerationPolicyTemplates()
    const effective = await getModerationEffectivePolicy('CN-MAINLAND')
    const preview = await previewModerationEffectivePolicy({
      regionCode: 'CUSTOM-US-CAMPUS',
      operatorOverrides: [{ category: 'harassment', submitAction: 'manual_review', displayAction: 'manual_review_no_public_display' }]
    })

    expect(regions[0]?.policyTemplate).toBe('cn-mainland-strict')
    expect(groups[0]?.policyTemplate).toBeNull()
    expect(templates[0]?.notLegalAdvice).toBe(true)
    expect(effective.rules[0]?.displayAction).toBe('geo_block')
    expect(preview.rules[0]?.sourceType).toBe('operator_override')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/author/moderation/regions')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/author/moderation/region-groups')
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/author/moderation/policy-templates')
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/author/moderation/effective-policy/CN-MAINLAND')
    expect(fetchMock.mock.calls[4]?.[0]).toBe('/api/author/moderation/effective-policy/preview')
  })

  it('getModerationModelStatus fetches model boundary and latency status', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        enabled: true,
        provider: 'mock',
        mode: 'score-only',
        contractVersion: 'fsusblog-moderation-provider-v1',
        timeoutMs: 800,
        failOpen: true,
        externalProviderAllowed: false,
        externalProviderReviewed: false,
        lastSuccessAtUtc: '2026-06-10T00:00:00Z',
        lastErrorCode: null,
        lastErrorAtUtc: null,
        averageLatencyMs: 3,
        p95LatencyMs: 5
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const status = await getModerationModelStatus()

    expect(status.contractVersion).toBe('fsusblog-moderation-provider-v1')
    expect(status.p95LatencyMs).toBe(5)
    expect(fetchMock).toHaveBeenCalledWith('/api/author/moderation/model/status', expect.objectContaining({
      credentials: 'include'
    }))
  })

  it('reloadModerationDictionaries posts with admin MFA proof header', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        reloaded: true,
        snapshotId: 'moderation-dictionaries:abc',
        checksum: 'abc',
        error: null,
        reloadedAtUtc: '2026-06-10T00:00:00Z'
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const response = await reloadModerationDictionaries({ mfaProofToken: 'proof-reload' })

    expect(response.reloaded).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('/api/author/moderation/dictionaries/reload', expect.objectContaining({
      method: 'POST',
      credentials: 'include'
    }))
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Headers
    expect(headers.get('X-Fsus-Mfa-Proof')).toBe('proof-reload')
  })

  it('moderation runtime status exposes global, region, dictionary, and model state', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: runtimeStatus()
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const runtime = await getModerationRuntimeStatus()

    expect(runtime.globalState).toBe('enabled')
    expect(runtime.regionStates.SG).toBe('manual_review_only')
    expect(runtime.disabledDictionaryIds).toContain('global.scam')
    expect(runtime.model.provider).toBe('mock')
    expect(fetchMock).toHaveBeenCalledWith('/api/author/moderation/runtime/status', expect.objectContaining({
      credentials: 'include'
    }))
  })

  it('setModerationGlobalState posts safe global runtime state with admin MFA proof header', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: runtimeStatus({ globalState: 'disabled_to_pending' })
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const runtime = await setModerationGlobalState(
      { state: 'disabled_to_pending', reason: 'incident' },
      { mfaProofToken: 'proof-global' }
    )

    expect(runtime.globalState).toBe('disabled_to_pending')
    expect(fetchMock).toHaveBeenCalledWith('/api/author/moderation/runtime/global-state', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ state: 'disabled_to_pending', reason: 'incident' })
    }))
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Headers
    expect(headers.get('X-Fsus-Mfa-Proof')).toBe('proof-global')
  })

  it('setModerationRegionState posts CN-MAINLAND confirmation phrase', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: runtimeStatus({ regionStates: { 'CN-MAINLAND': 'no_public_display' } })
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const runtime = await setModerationRegionState({
      region: 'CN-MAINLAND',
      state: 'no_public_display',
      reason: 'strict mode',
      confirmPhrase: 'CONFIRM CN-MAINLAND MODERATION CHANGE'
    }, { mfaProofToken: 'proof-region' })

    expect(runtime.regionStates['CN-MAINLAND']).toBe('no_public_display')
    expect(fetchMock).toHaveBeenCalledWith('/api/author/moderation/runtime/region-state', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"confirmPhrase":"CONFIRM CN-MAINLAND MODERATION CHANGE"')
    }))
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Headers
    expect(headers.get('X-Fsus-Mfa-Proof')).toBe('proof-region')
  })

  it('dictionary runtime controls use separate enable disable and rollback endpoints', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: runtimeStatus({ disabledDictionaryIds: [] })
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: runtimeStatus({ disabledDictionaryIds: ['cn-mainland.political-sensitive'] })
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          snapshotId: 'moderation-dictionaries:rollback',
          version: 'GLOBAL-v2026-06',
          checksum: 'rollback',
          createdAtUtc: '2026-06-10T00:00:00Z',
          dictionaries: [],
          regionPolicies: [],
          lastError: null
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await enableModerationDictionary('global.scam', { reason: 'restore' }, { mfaProofToken: 'proof-dict' })
    await disableModerationDictionary(
      'cn-mainland.political-sensitive',
      { reason: 'test', confirmPhrase: 'CONFIRM CN-MAINLAND MODERATION CHANGE' },
      { mfaProofToken: 'proof-dict' }
    )
    const rollback = await rollbackModerationDictionaries({ mfaProofToken: 'proof-dict' })

    expect(rollback.snapshotId).toBe('moderation-dictionaries:rollback')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/author/moderation/dictionaries/global.scam/enable')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/author/moderation/dictionaries/cn-mainland.political-sensitive/disable')
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/author/moderation/dictionaries/rollback')
  })

  it('model runtime controls update reload and rollback with admin MFA proof header', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: runtimeStatus({ model: { ...runtimeStatus().model, enabled: false, provider: 'none' } })
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: runtimeStatus({ model: { ...runtimeStatus().model, status: 'loaded' } })
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: runtimeStatus({ model: { ...runtimeStatus().model, status: 'rolled_back' } })
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const updated = await setModerationModelRuntime(
      { enabled: false, provider: 'none', reason: 'maintenance' },
      { mfaProofToken: 'proof-model' }
    )
    await reloadModerationModel({ mfaProofToken: 'proof-model' })
    const rolledBack = await rollbackModerationModel({ mfaProofToken: 'proof-model' })

    expect(updated.model.provider).toBe('none')
    expect(rolledBack.model.status).toBe('rolled_back')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/author/moderation/model/runtime')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/author/moderation/model/reload')
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/author/moderation/model/rollback')
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Headers
    expect(headers.get('X-Fsus-Mfa-Proof')).toBe('proof-model')
  })

  it('previewModerationReplay posts scoped preview request without executing replay', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        region: 'CN-MAINLAND',
        policyVersion: 'region-policy-v2026-05',
        dictionaryId: 'cn-mainland.political-sensitive',
        scannedCount: 10,
        affectedCommentCount: 1,
        addedBlockedRegionCount: 1,
        removedBlockedRegionCount: 0,
        addedRiskLabelCount: 1,
        removedRiskLabelCount: 0,
        publishabilityChangedCount: 0,
        manualReviewChangedCount: 0,
        publicVisibilityChangedCount: 1,
        highRiskChangeCount: 1,
        items: [{
          commentId: 1001,
          previousPolicyVersion: 'region-policy-v2026-05',
          nextPolicyVersion: 'region-policy-v2026-06',
          addedBlockedRegions: ['CN-MAINLAND'],
          removedBlockedRegions: [],
          addedRiskLabels: ['cn_mainland_political_sensitive'],
          removedRiskLabels: [],
          publishabilityChanged: false,
          manualReviewChanged: false,
          publicVisibilityChanged: true
        }]
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const preview = await previewModerationReplay({
      region: 'CN-MAINLAND',
      policyVersion: 'region-policy-v2026-05',
      dictionaryId: 'cn-mainland.political-sensitive',
      limit: 10
    })

    expect(preview.highRiskChangeCount).toBe(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/author/moderation/replay/preview', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({
        region: 'CN-MAINLAND',
        policyVersion: 'region-policy-v2026-05',
        dictionaryId: 'cn-mainland.political-sensitive',
        limit: 10
      })
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
