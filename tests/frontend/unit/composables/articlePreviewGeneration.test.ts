import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { ArticleDocumentContextAuthority, createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext'
import { ArticlePreviewSourceAdmission } from '@/services/authoring/articlePreviewSourceAdmission'
import { calculateOpenArticleDocumentDigest as digest } from '@/services/authoring/openArticleDocumentRegistry'
import {
  commitArticlePreviewIfCurrent,
  useArticlePreviewGeneration,
  type ArticlePreviewSourceSnapshot
} from '@/composables/articlePreviewGeneration'
import type {
  ArticlePreviewResponse,
  ServerDraftSaveRequest
} from '@/api/authoring'

const previewFor = (
  source: ArticlePreviewSourceSnapshot,
  sourceIdentity = `identity:${source.title}`
): ArticlePreviewResponse => ({
  normalizedTitle: source.title,
  normalizedSummary: source.summary ?? '',
  normalizedCoverImageUrl: source.coverImageUrl ?? null,
  normalizedMarkdownSource: source.content,
  plainText: source.content,
  sourceIdentity,
  issues: []
})

const requestFor = (
  source: ArticlePreviewSourceSnapshot
): ServerDraftSaveRequest => ({
  draftKey: 'article-preview-test',
  articleId: null,
  baseRevisionId: null,
  title: source.title,
  content: source.content,
  summary: source.summary,
  coverImageUrl: source.coverImageUrl,
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
})

const createDocumentContext = () => createArticleDocumentContextAdapter({
  articleId: 1,
  draftId: 'article:1',
  editorSessionId: 'session:preview-test',
  siteScope: 'site:test',
  userScope: 'user:test',
  content: 'content A'
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('admin article preview generation authority', () => {
  it('finishes cancellation while the producer ignores abort and rejects its late completion', async () => {
    const source = { title: 'Title A', content: 'content A', summary: '', coverImageUrl: null }
    const previous = previewFor(source, 'last-valid')
    const target = ref<ArticlePreviewResponse | null>(previous)
    const pending = deferred<ArticlePreviewResponse>()
    const requestPreview = vi.fn(() => pending.promise)
    const owner = createDocumentContext()
    const generation = useArticlePreviewGeneration({ target, documentContext: owner,
      readRequest: () => requestFor(source), readCurrentSnapshot: () => source,
      createIdentity: async () => 'identity:Title A', requestPreview })
    const controller = new AbortController()
    const run = generation.generate(controller.signal)
    await vi.waitFor(() => expect(requestPreview).toHaveBeenCalledTimes(1))
    controller.abort()
    expect(await run).toBeNull()
    expect(target.value).toEqual(previous)
    pending.resolve(previewFor(source))
    await Promise.resolve()
    expect(target.value).toEqual(previous)
    owner.dispose()
  })
  it('binds the complete current request and cancels actual owner work while retaining the last admitted preview', async () => {
    const source = { title: 'Title A', content: 'content A', summary: '', coverImageUrl: null }
    const authority = new ArticleDocumentContextAuthority()
    const host = authority.acquire({ articleId: 1, siteScope: 'site:test', userScope: 'user:test', content: source.content })
    let request = requestFor(source)
    const previous = previewFor(source, 'last-valid')
    const target = ref<ArticlePreviewResponse | null>(previous)
    let pending = deferred<ArticlePreviewResponse>()
    const requestPreview = vi.fn((_request: ServerDraftSaveRequest, _signal: AbortSignal) => pending.promise)
    const generation = useArticlePreviewGeneration({ target, documentContext: host.adapter,
      sourceAdmission: () => ArticlePreviewSourceAdmission.attach(() => ({ context: host.adapter.context,
        source: source.content, responsibility: null, siteAuthor: '', attachmentLifecycleHistory: [],
        authoringInputDigest: digest(request) }), authority),
      readRequest: () => request, readCurrentSnapshot: () => source,
      createIdentity: async () => 'identity:Title A', requestPreview })
    try {
      const first = generation.generate(new AbortController().signal)
      await vi.waitFor(() => expect(requestPreview).toHaveBeenCalledTimes(1))
      request = { ...request, rights: { ...request.rights, copyPolicy: 'deny' } }
      pending.resolve(previewFor(source))
      expect(await first).toBeNull()
      expect(target.value).toEqual(previous)
      pending = deferred<ArticlePreviewResponse>()
      const second = generation.generate(new AbortController().signal)
      await vi.waitFor(() => expect(requestPreview).toHaveBeenCalledTimes(2))
      const signal = requestPreview.mock.calls[1]![1]
      host.adapter.updateSource('changed source')
      expect(signal.aborted).toBe(true)
      pending.resolve(previewFor(source))
      expect(await second).toBeNull()
      expect(target.value).toEqual(previous)
      expect(host.adapter.isCurrentContext(host.adapter.context)).toBe(true)
    } finally {
      host.release()
    }
  })
  it('keeps B committed when A returns after editing A to B and back to A', async () => {
    const target = ref<ArticlePreviewResponse | null>(null)
    let current: ArticlePreviewSourceSnapshot = {
      title: 'A',
      content: 'content A',
      summary: 'summary A',
      coverImageUrl: '/a.png'
    }
    const pendingA = deferred<ArticlePreviewResponse>()
    const pendingB = deferred<ArticlePreviewResponse>()
    const generation = useArticlePreviewGeneration({
      target,
      documentContext: createDocumentContext(),
      readRequest: () => requestFor(current),
      readCurrentSnapshot: () => current,
      createIdentity: async request => `identity:${request.title}`,
      requestPreview: request => request.title === 'A' ? pendingA.promise : pendingB.promise
    })

    const requestA = generation.generate(new AbortController().signal)
    await Promise.resolve()
    current = {
      title: 'B',
      content: 'content B',
      summary: 'summary B',
      coverImageUrl: '/b.png'
    }
    const requestB = generation.generate(new AbortController().signal)
    await Promise.resolve()

    pendingB.resolve(previewFor(current))
    await expect(requestB).resolves.toMatchObject({ normalizedTitle: 'B' })
    expect(target.value?.normalizedTitle).toBe('B')

    current = {
      title: 'A',
      content: 'content A',
      summary: 'summary A',
      coverImageUrl: '/a.png'
    }
    pendingA.resolve(previewFor(current))
    await expect(requestA).resolves.toBeNull()
    expect(target.value?.normalizedTitle).toBe('B')
  })

  it.each([
    ['title', 'B'],
    ['content', 'content B'],
    ['summary', 'summary B'],
    ['coverImageUrl', '/b.png']
  ] as const)('rejects a response after the current %s changes', async (field, value) => {
    const target = ref<ArticlePreviewResponse | null>(null)
    let current: ArticlePreviewSourceSnapshot = {
      title: 'A',
      content: 'content A',
      summary: 'summary A',
      coverImageUrl: '/a.png'
    }
    const pending = deferred<ArticlePreviewResponse>()
    const generation = useArticlePreviewGeneration({
      target,
      documentContext: createDocumentContext(),
      readRequest: () => requestFor(current),
      readCurrentSnapshot: () => current,
      createIdentity: async () => 'identity:A',
      requestPreview: () => pending.promise
    })

    const request = generation.generate(new AbortController().signal)
    await Promise.resolve()
    current = { ...current, [field]: value }
    pending.resolve(previewFor({
      title: 'A',
      content: 'content A',
      summary: 'summary A',
      coverImageUrl: '/a.png'
    }))

    await expect(request).resolves.toBeNull()
    expect(target.value).toBeNull()
  })

  it('rejects a response whose source identity does not match the request', async () => {
    const target = ref<ArticlePreviewResponse | null>(null)
    const current: ArticlePreviewSourceSnapshot = {
      title: 'A',
      content: 'content A',
      summary: 'summary A',
      coverImageUrl: '/a.png'
    }
    const generation = useArticlePreviewGeneration({
      target,
      documentContext: createDocumentContext(),
      readRequest: () => requestFor(current),
      readCurrentSnapshot: () => current,
      createIdentity: async () => 'identity:A',
      requestPreview: async () => previewFor(current, 'identity:other')
    })

    await expect(generation.generate(new AbortController().signal))
      .rejects.toThrow('article_preview_source_identity_mismatch')
    expect(target.value).toBeNull()
  })

  it.each(['abort', 'document-switch', 'source-revision'] as const)(
    'does not send a preview after %s while hashing the source', async (change) => {
      const target = ref<ArticlePreviewResponse | null>(null)
      const documentContext = createDocumentContext()
      const identity = deferred<string>()
      const controller = new AbortController()
      const source = { title: 'A', content: 'content A' }
      const requestPreview = vi.fn(async () => previewFor(source))
      const generation = useArticlePreviewGeneration({
        target,
        documentContext,
        readRequest: () => requestFor(source),
        readCurrentSnapshot: () => source,
        createIdentity: () => identity.promise,
        requestPreview
      })
      const pending = generation.generate(controller.signal)
      if (change === 'abort') {
        controller.abort()
      } else if (change === 'document-switch') {
        documentContext.switchDocument({ articleId: 2, draftId: 'article:2', content: source.content })
      } else {
        documentContext.updateSource(source.content, 1)
      }
      identity.resolve('identity:A')
      await expect(pending).resolves.toBeNull()
      expect(requestPreview).not.toHaveBeenCalled()
      expect(target.value).toBeNull()
      documentContext.dispose()
    }
  )

  it.each(['document-switch', 'source-revision'] as const)(
    'rejects a late preview after %s even when transport ignores cancellation', async (change) => {
      const target = ref<ArticlePreviewResponse | null>(null)
      const documentContext = createDocumentContext()
      const response = deferred<ArticlePreviewResponse>()
      const source = { title: 'A', content: 'content A' }
      const generation = useArticlePreviewGeneration({
        target,
        documentContext,
        readRequest: () => requestFor(source),
        readCurrentSnapshot: () => source,
        createIdentity: async () => 'identity:A',
        requestPreview: () => response.promise
      })
      const pending = generation.generate(new AbortController().signal)
      await Promise.resolve()
      if (change === 'document-switch') {
        documentContext.switchDocument({ articleId: 2, draftId: 'article:2', content: source.content })
      } else {
        documentContext.updateSource(source.content, 1)
      }
      response.resolve(previewFor(source))
      await expect(pending).resolves.toBeNull()
      expect(target.value).toBeNull()
      documentContext.dispose()
    }
  )

  it('rejects identity mismatch, older generations, and form edits before committing preview state', async () => {
    const target = ref<ArticlePreviewResponse | null>(null)
    const requestSnapshot = {
      title: 'A',
      content: 'content A',
      summary: 'summary A',
      coverImageUrl: '/a.png'
    }
    const preview: ArticlePreviewResponse = {
      normalizedTitle: 'A',
      normalizedSummary: 'summary A',
      normalizedCoverImageUrl: '/a.png',
      normalizedMarkdownSource: 'content A',
      plainText: 'content A',
      sourceIdentity: `preview:sha256:${'a'.repeat(64)}`,
      issues: []
    }

    await expect(Promise.resolve().then(() => commitArticlePreviewIfCurrent({
      target,
      preview: { ...preview, sourceIdentity: `preview:sha256:${'b'.repeat(64)}` },
      expectedIdentity: preview.sourceIdentity,
      requestGeneration: 2,
      currentGeneration: 2,
      requestSnapshot,
      currentSnapshot: requestSnapshot
    }))).rejects.toThrow('article_preview_source_identity_mismatch')
    expect(target.value).toBeNull()

    expect(commitArticlePreviewIfCurrent({
      target,
      preview,
      expectedIdentity: preview.sourceIdentity,
      requestGeneration: 1,
      currentGeneration: 2,
      requestSnapshot,
      currentSnapshot: requestSnapshot
    })).toBe(false)
    expect(target.value).toBeNull()

    for (const currentSnapshot of [
      { ...requestSnapshot, title: 'B' },
      { ...requestSnapshot, content: 'content B' },
      { ...requestSnapshot, summary: 'summary B' },
      { ...requestSnapshot, coverImageUrl: '/b.png' }
    ]) {
      expect(commitArticlePreviewIfCurrent({
        target,
        preview,
        expectedIdentity: preview.sourceIdentity,
        requestGeneration: 2,
        currentGeneration: 2,
        requestSnapshot,
        currentSnapshot
      })).toBe(false)
      expect(target.value).toBeNull()
    }
  })
})
