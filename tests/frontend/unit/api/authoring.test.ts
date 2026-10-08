import { buildFsusBinaryRoute, fsusBinaryRouteDescriptors } from '@/generated/fsusBinaryRoutes'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'
import { requestBinaryOnly } from '@/composition/binaryTransport'
import {
  applyIntegrityFix,
  blockAnonymousNullifier,
  createArticlePreviewSourceIdentity,
  discardServerDraft,
  getServerDraft,
  moderateComment,
  normalizePreviewCoverImageUrl,
  previewArticleDraft,
  previewModerationEffectivePolicy,
  readStructuredArticlePreviewResponse,
  reloadModerationDictionaries,
  revokeAnonymousCredential,
  rollbackArticleRevision,
  rollbackModerationDictionaries,
  saveArticleResponsibility,
  getArticleResponsibilityHistory,
  getPlugin,
  installPlugin,
  listPlugins,
  mutatePlugin,
  saveServerDraft,
  setModerationGlobalState,
  setModerationRegionState
} from '@/api/authoring'
import { FSUS_HEADERS } from '@/api/contracts'

vi.mock('@/composition/binaryTransport', () => ({
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

  it('matches the cross-stack article preview source identity golden vector', async () => {
    await expect(createArticlePreviewSourceIdentity({
      title: 'Preview <Title>',
      content: '## Section\r\n正文🙂',
      summary: 'Summary <safe>',
      coverImageUrl: '/uploads/cover.png'
    })).resolves.toBe(
      'preview:sha256:7ea4f661c9aa2612d0d105ea0b3078187ac0eb8ec02b33e180dd9b4574257a6b'
    )
  })

  it('uses UTF-8 byte lengths and treats null exactly like an empty identity field', async () => {
    await expect(createArticlePreviewSourceIdentity({
      title: 'é',
      content: '🙂',
      summary: null,
      coverImageUrl: null
    })).resolves.toBe(
      'preview:sha256:a5211698f205f78847796364f1c2f15285f8946930c85d1c09c13db9f80c8272'
    )
    await expect(createArticlePreviewSourceIdentity({
      title: 'é',
      content: '🙂',
      summary: '',
      coverImageUrl: ''
    })).resolves.toBe(
      'preview:sha256:a5211698f205f78847796364f1c2f15285f8946930c85d1c09c13db9f80c8272'
    )
  })

  it.each([
    ['/uploads/cover.png', '/uploads/cover.png'],
    ['https://example.com/cover.png', 'https://example.com/cover.png'],
    ['http://example.com/cover.png', 'http://example.com/cover.png'],
    ['//example.com/cover.png', null],
    ['javascript:alert(1)', null],
    ['data:text/html,<script>alert(1)</script>', null],
    ['https://user:pass@example.com/cover.png', null],
    ['mailto:owner@example.com', null]
  ] as const)('normalizes preview cover URL %s', (input, expected) => {
    expect(normalizePreviewCoverImageUrl(input)).toBe(expected)
  })

  it('reads only structured preview fields and rejects leftover HTML protocol keys', () => {
    const structured = {
      normalizedTitle: 'Title',
      normalizedSummary: 'Summary',
      normalizedCoverImageUrl: '/uploads/cover.png',
      normalizedMarkdownSource: '# Markdown',
      plainText: 'Markdown',
      sourceIdentity: `preview:sha256:${'a'.repeat(64)}`,
      issues: [{ severity: 'error', code: 'dangerous_html', message: '<script>issue()</script>' }]
    }

    expect(readStructuredArticlePreviewResponse({
      ...structured,
      extra: 'ignored'
    })).toEqual(structured)
    expect(readStructuredArticlePreviewResponse({
      ...structured,
      normalizedCoverImageUrl: 'javascript:alert(1)'
    }).normalizedCoverImageUrl).toBeNull()
    expect(() => readStructuredArticlePreviewResponse({
      ...structured,
      html: '<p>nope</p>'
    })).toThrow('article_preview_html_field_forbidden')
    expect(() => readStructuredArticlePreviewResponse({
      ...structured,
      srcdoc: '<p>nope</p>'
    })).toThrow('article_preview_html_field_forbidden')
  })

  it('fails closed when a preview response still carries an html field', async () => {
    binaryMock.mockResolvedValue({
      normalizedTitle: 'Title',
      normalizedSummary: 'Summary',
      normalizedCoverImageUrl: '/uploads/cover.png',
      normalizedMarkdownSource: '# Markdown',
      plainText: 'Markdown',
      sourceIdentity: `preview:sha256:${'b'.repeat(64)}`,
      issues: [],
      html: '<article>legacy</article>'
    })

    await expect(previewArticleDraft({
      draftKey: 'article-preview-test',
      articleId: null,
      baseRevisionId: null,
      title: 'Title',
      content: '# Markdown',
      summary: 'Summary',
      coverImageUrl: '/uploads/cover.png',
      categoryId: 1,
      tagIds: [],
      clientRevision: 'preview-test',
      status: 0,
      scheduledPublishAt: null,
      rights: {
        enabled: true,
        licenseType: 'all-rights-reserved',
        copyrightHolder: '',
        copyrightYear: null,
        rightsStatement: '',
        attributionTemplate: '',
        copyPolicy: 'append-attribution',
        maxExcerptChars: 300,
        allowCodeCopy: true,
        showPublicBadge: true,
        proofBindingEnabled: true
      },
      expectedServerRevision: null
    })).rejects.toMatchObject({
      code: 'ProtocolFailure',
      message: 'article_preview_html_field_forbidden'
    })
  })

  it('saveServerDraft posts an AEDS author draft request frame', async () => {
    const rights = {
      enabled: true,
      licenseType: 'CC-BY-4.0',
      copyrightHolder: 'Fsus',
      copyrightYear: 2026,
      rightsStatement: 'Reuse with attribution.',
      attributionTemplate: '{title} - {holder}',
      copyPolicy: 'append-attribution',
      maxExcerptChars: 240,
      allowCodeCopy: true,
      showPublicBadge: true,
      proofBindingEnabled: false
    }

    binaryMock.mockResolvedValue({
      draftKey: 'fsus:article-draft:create',
      articleId: null,
      baseRevisionId: null,
      title: 'Draft',
      content: 'Body',
      summary: null,
      coverImageUrl: null,
      categoryId: 1,
      tagIds: [2],
      clientRevision: 'rev-1',
      status: 0,
      scheduledPublishAt: null,
      rights,
      updatedAt: '2026-05-18T16:00:00Z',
      serverRevision: 1
    })

    const saved = await saveServerDraft({
      draftKey: 'fsus:article-draft:create',
      articleId: null,
      baseRevisionId: null,
      title: 'Draft',
      content: 'Body',
      summary: null,
      coverImageUrl: null,
      categoryId: 1,
      tagIds: [2],
      clientRevision: 'rev-1',
      status: 0,
      scheduledPublishAt: null,
      rights,
      expectedServerRevision: null
    })

    expect(saved.rights).toMatchObject(rights)

    const call = binaryMock.mock.calls[0]?.[0]
    expect(routeUrl(call)).toBe('/api/binary/author/drafts')
    expect(call?.frameType).toBe(FrameType.AuthorDraftResponse)
    expect(fsusBinaryRouteDescriptors[call.binaryRoute.operationId].method).toBe('POST')
    expect((call?.requestOptions?.headers as Headers).get(FSUS_HEADERS.deviceFingerprint)).toBe('fp-test')
    expectAedsJsonBody(call?.requestOptions?.body, FrameType.AuthorDraftSaveRequest, {
      title: 'Draft',
      status: 0,
      expectedServerRevision: null,
      rights: {
        licenseType: 'CC-BY-4.0',
        copyrightHolder: 'Fsus',
        copyrightYear: 2026,
        copyPolicy: 'append-attribution',
        maxExcerptChars: 240,
        proofBindingEnabled: false
      }
    })
  })

  it('discards a draft with an explicit server revision precondition', async () => {
    binaryMock.mockResolvedValue({ discarded: true })

    await expect(discardServerDraft('fsus:article-draft:create', 7)).resolves.toBe(true)

    const call = binaryMock.mock.calls[0]?.[0]
    expect(routeUrl(call)).toBe('/api/binary/author/drafts/fsus%3Aarticle-draft%3Acreate?expectedServerRevision=7')
    expect(call?.frameType).toBe(FrameType.AuthorDraftDiscardResponse)
    expect(fsusBinaryRouteDescriptors[call.binaryRoute.operationId].method).toBe('DELETE')
    expect(call?.requestOptions?.body).toBeUndefined()
  })

  it('saves revision responsibility through its route-specific AEDS frames', async () => {
    binaryMock.mockResolvedValue({ saved: true, articleId: 42, articleRevisionId: '9001', revisionNo: 3, issues: [] })

    await saveArticleResponsibility(42, '9001', {
      inheritSiteAuthor: false,
      authors: [{ name: 'Alice', profileUrl: 'https://example.test/alice' }],
      reviewer: null,
      sources: [],
      updateSummary: null,
      updateReason: null,
      effectiveAt: null,
      conclusionImpact: null,
      methodology: null,
      applicability: null,
      limitations: null,
      responsiblePersonConfirmed: true,
      containsStrongClaims: false,
      isSubstantiveUpdate: false,
      requiresMethodsDisclosure: false,
      expectedVersion: 0
    })

    const call = binaryMock.mock.calls.at(-1)?.[0]
    expect(routeUrl(call)).toBe('/api/binary/author/articles/42/revisions/9001/responsibility')
    expect(call?.frameType).toBe(FrameType.ArticleResponsibilityResponse)
    expect(fsusBinaryRouteDescriptors[call.binaryRoute.operationId].method).toBe('PUT')
  })

  it('reads append-only responsibility history for the exact article revision', async () => {
    binaryMock.mockResolvedValue([])

    await getArticleResponsibilityHistory(42, '9001')

    const call = binaryMock.mock.calls.at(-1)?.[0]
    expect(routeUrl(call)).toBe('/api/binary/author/articles/42/revisions/9001/responsibility')
    expect(call?.frameType).toBe(FrameType.ArticleResponsibilityHistory)
    expect(fsusBinaryRouteDescriptors[call.binaryRoute.operationId].credentialPolicy).toBe('include')
    expect((call?.requestOptions?.headers as Headers).get(FSUS_HEADERS.deviceFingerprint)).toBe('fp-test')
  })

  it('rollbackArticleRevision sends explicit version-package rollback intent', async () => {
    const response = {
      id: 42,
      articleId: 42,
      revisionId: 9011,
      revisionNo: 4,
      status: 3,
      releaseId: 7004,
      releaseNo: 4,
      rightsSnapshotId: 6004,
      rightsRevisionNo: 4,
      idempotencyReplay: false,
      errorCode: 0
    }
    binaryMock.mockResolvedValue(response)

    await expect(rollbackArticleRevision(42, '9001', {
      baseRevisionId: '9010',
      targetStatus: 3,
      reason: 'Archive after restoring the reviewed package'
    }, { mfaProofToken: 'proof' })).resolves.toEqual(response)

    const call = binaryMock.mock.calls[0]?.[0]
    expect(routeUrl(call)).toBe('/api/binary/author/articles/42/revisions/9001/rollback')
    expect(fsusBinaryRouteDescriptors[call.binaryRoute.operationId].method).toBe('POST')
    expect(call?.frameType).toBe(FrameType.MutationId)
    expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof')
    expectAedsJsonBody(call?.requestOptions?.body, FrameType.ArticleRevisionRollbackRequest, {
      baseRevisionId: '9010',
      targetStatus: 3,
      reason: 'Archive after restoring the reviewed package'
    })
  })

  it('getServerDraft reads nullable draft responses through AEDS', async () => {
    binaryMock.mockResolvedValue(null)

    await expect(getServerDraft('missing')).resolves.toBeNull()

    const call = binaryMock.mock.calls[0]?.[0]
    expect(routeUrl(call)).toBe('/api/binary/author/drafts/missing')
    expect(call?.frameType).toBe(FrameType.AuthorDraftResponse)
    expect(call?.requestOptions?.body).toBeUndefined()
  })

  it('keeps admin step-up proof on sensitive authoring mutations', async () => {
    binaryMock.mockResolvedValue({ status: 'applied', appliedAt: '2026-06-10T00:00:00Z', appliedCount: 1, diffs: [] })

    await applyIntegrityFix({ codes: ['orphan-asset'], confirmPhrase: 'APPLY SAFE FIX' }, { mfaProofToken: 'proof-1' })

    const call = binaryMock.mock.calls[0]?.[0]
    expect(routeUrl(call)).toBe('/api/binary/author/integrity/fix')
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
    expect(routeUrl(call)).toBe('/api/binary/author/moderation/effective-policy/preview')
    expect(call?.frameType).toBe(FrameType.ModerationEffectivePolicy)
    expectAedsJsonBody(call?.requestOptions?.body, FrameType.ModerationEffectivePolicyPreviewRequest, {
      regionCode: 'CN-MAINLAND'
    })
  })

  it('reloads and rolls back moderation dictionaries with admin step-up proof', async () => {
    binaryMock
      .mockResolvedValueOnce({
        reloaded: true,
        snapshotId: 'snapshot-next',
        checksum: 'checksum-next',
        error: null,
        reloadedAtUtc: '2026-07-11T08:00:00Z'
      })
      .mockResolvedValueOnce({
        snapshotId: 'snapshot-previous',
        version: '2026-07',
        checksum: 'checksum-previous',
        createdAtUtc: '2026-07-11T07:00:00Z',
        dictionaries: [],
        regionPolicies: [],
        lastError: null
      })

    await reloadModerationDictionaries({ mfaProofToken: 'proof-reload' })
    await rollbackModerationDictionaries({ mfaProofToken: 'proof-rollback' })

    const reload = binaryMock.mock.calls[0]?.[0]
    const rollback = binaryMock.mock.calls[1]?.[0]
    expect(reload).toMatchObject({
      binaryRoute: { operationId: 'binary_post_author_moderation_dictionaries_reload' },
      frameType: FrameType.ModerationDictionaryReloadResponse,
      requestOptions: { }
    })
    expect((reload?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-reload')
    expect(rollback).toMatchObject({
      binaryRoute: { operationId: 'binary_post_author_moderation_dictionaries_rollback' },
      frameType: FrameType.ModerationDictionarySnapshot,
      requestOptions: { }
    })
    expect((rollback?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-rollback')
  })

  it('encodes moderation global and region runtime mutations with their selected arguments', async () => {
    binaryMock.mockResolvedValue({ snapshotId: 'runtime-next' })

    await setModerationGlobalState({
      state: 'disabled_to_pending',
      reason: 'provider incident',
      expiresAtUtc: '2026-07-11T09:00:00Z'
    }, { mfaProofToken: 'proof-global' })
    await setModerationRegionState({
      region: 'CN-MAINLAND',
      state: 'no_public_display',
      reason: 'policy review',
      confirmPhrase: 'CONFIRM_CN_MAINLAND_CHANGE'
    }, { mfaProofToken: 'proof-region' })

    const globalState = binaryMock.mock.calls[0]?.[0]
    const regionState = binaryMock.mock.calls[1]?.[0]
    expect(routeUrl(globalState)).toBe('/api/binary/author/moderation/runtime/global-state')
    expect(globalState?.frameType).toBe(FrameType.ModerationRuntimeStatus)
    expect((globalState?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-global')
    expectAedsJsonBody(globalState?.requestOptions?.body, FrameType.ModerationRuntimeGlobalStateRequest, {
      state: 'disabled_to_pending',
      reason: 'provider incident'
    })
    expect(routeUrl(regionState)).toBe('/api/binary/author/moderation/runtime/region-state')
    expect(regionState?.frameType).toBe(FrameType.ModerationRuntimeStatus)
    expect((regionState?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-region')
    expectAedsJsonBody(regionState?.requestOptions?.body, FrameType.ModerationRuntimeRegionStateRequest, {
      region: 'CN-MAINLAND',
      state: 'no_public_display',
      confirmPhrase: 'CONFIRM_CN_MAINLAND_CHANGE'
    })
  })

  it('maps boolean moderation mutation responses from AEDS payloads', async () => {
    binaryMock.mockResolvedValue({ moderated: true })

    await expect(moderateComment('42', { status: 1, reason: 'reviewed' }, { mfaProofToken: 'proof-2' }))
      .resolves.toBe(true)

    const call = binaryMock.mock.calls[0]?.[0]
    expect(routeUrl(call)).toBe('/api/binary/author/comments/42/moderation')
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
    expect(routeUrl(call)).toBe('/api/binary/author/comments/moderation/nullifiers/block')
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
    expect(routeUrl(call)).toBe('/api/binary/author/comments/moderation/anonymous-credentials/88001/revoke')
    expect(call?.frameType).toBe(FrameType.AnonymousGovernanceActionResponse)
    expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-credential')
    expectAedsJsonBody(call?.requestOptions?.body, FrameType.AnonymousGovernanceActionRequest, {
      reason: 'abuse confirmed'
    })
  })

  it('reads plugin overview and detail through the admin-only snapshot frame', async () => {
    binaryMock.mockResolvedValueOnce({ plugins: [] }).mockResolvedValueOnce({ summary: { pluginId: 'fsusblog.plugin.guard' } })

    await listPlugins()
    await getPlugin('fsusblog.plugin.guard')

    expect(binaryMock.mock.calls[0]?.[0]).toMatchObject({
      binaryRoute: { operationId: 'binary_get_author_plugins' },
      frameType: FrameType.PluginAdminSnapshot
    })
    expect(binaryMock.mock.calls[1]?.[0]).toMatchObject({
      binaryRoute: { operationId: 'binary_get_author_plugins_pluginId', params: { pluginId: "fsusblog.plugin.guard" } },
      frameType: FrameType.PluginAdminSnapshot
    })
  })

  it('encodes plugin mutations with explicit confirmation and config version', async () => {
    binaryMock.mockResolvedValue(null)

    await mutatePlugin('fsusblog.plugin.guard', {
      action: 'update-config',
      confirmed: true,
      expectedConfigVersion: 7,
      config: { mode: 'enforce' }
    }, { mfaProofToken: 'proof-plugin' })

    const call = binaryMock.mock.calls[0]?.[0]
    expect(routeUrl(call)).toBe('/api/binary/author/plugins/fsusblog.plugin.guard/actions')
    expect(call?.frameType).toBe(FrameType.PluginAdminSnapshot)
    expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-plugin')
    expectAedsJsonBody(call?.requestOptions?.body, FrameType.PluginAdminMutationRequest, {
      action: 'update-config',
      confirmed: true,
      expectedConfigVersion: 7,
      config: { mode: 'enforce' }
    })
  })

  it('installs the exact fspkg bytes in a route-specific AEDS frame', async () => {
    binaryMock.mockResolvedValue({ summary: { pluginId: 'fsusblog.plugin.guard' } })
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'guard.fspkg')

    await installPlugin(file, { mfaProofToken: 'proof-install' })

    const call = binaryMock.mock.calls[0]?.[0]
    expect(routeUrl(call)).toBe('/api/binary/author/plugins/install')
    expect(call?.frameType).toBe(FrameType.PluginAdminSnapshot)
    expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-install')
    expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Plugin-Confirm')).toBe('install')
    const bytes = new Uint8Array(call?.requestOptions?.body as ArrayBuffer)
    const view = new DataView(bytes.buffer)
    expect(view.getUint16(8, true)).toBe(FrameType.PluginPackageInstallRequest)
    expect([...bytes.slice(16)]).toEqual([1, 2, 3, 4])
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

function routeUrl(call: Partial<import('@/contracts/binaryTransport').BinaryTransportRequest> | undefined): string | undefined {
  const route = call?.binaryRoute
  return route ? buildFsusBinaryRoute(route.operationId, route.params, route.query) : undefined
}
