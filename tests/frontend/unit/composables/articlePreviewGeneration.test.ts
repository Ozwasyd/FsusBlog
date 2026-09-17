import { ref } from 'vue'
import { describe, expect, it } from 'vitest'
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

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('admin article preview generation authority', () => {
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
      readRequest: () => requestFor(current),
      readCurrentSnapshot: () => current,
      createIdentity: async () => 'identity:A',
      requestPreview: async () => previewFor(current, 'identity:other')
    })

    await expect(generation.generate(new AbortController().signal))
      .rejects.toThrow('article_preview_source_identity_mismatch')
    expect(target.value).toBeNull()
  })

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
