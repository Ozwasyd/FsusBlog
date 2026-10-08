import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext'
import type { ArticleDocumentContext } from '@/services/authoring/articleDocumentContext'
import { calculateOpenArticleDocumentDigest as digest } from '@/services/authoring/openArticleDocumentRegistry'
import { useArticlePreviewGeneration, type ArticlePreviewSourceSnapshot } from '@/composables/articlePreviewGeneration'
import type { ArticlePreviewResponse, ServerDraftSaveRequest } from '@/api/authoring'

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

const projectionFor = (context: ArticleDocumentContext, blocked = false) => {
  const body = { schema: 'fsusblog.article-attachment-business.v1' as const, context,
    items: Object.freeze(blocked ? [Object.freeze({ intentRef: 'intent:1', nodeId: 'node:1',
      transactionRef: 'transaction:1', providerRef: 'provider:1', sourceOrder: 0, sourceReferenced: true,
      status: 'pending', reason: 'upload_pending', asset: null, referenceReceiptRef: null, cleanup: 'not-needed' })] : []),
    blockingNodeIds: Object.freeze(blocked ? ['node:1'] : []), previewResources: Object.freeze([]) }
  return Object.freeze({ ...body, contentDigest: digest(body) })
}
const harness = () => {
  const source = { title: 'Title A', content: 'content A', summary: '', coverImageUrl: null }
  const owner = createDocumentContext()
  const previous = previewFor(source, 'last-valid')
  const target = ref<ArticlePreviewResponse | null>(previous)
  const requestPreview = vi.fn(async () => previewFor(source))
  const options = { target, documentContext: owner, readRequest: () => requestFor(source),
    readCurrentSnapshot: () => source, createIdentity: async () => 'identity:Title A', requestPreview }
  return { source, owner, previous, target, requestPreview, options }
}

describe('preview borrows the attachment business read port (orchestration only)', () => {
  it('keeps source-only legacy preview explicitly missing resource qualification', async () => {
    const h = harness()
    try {
      const g = useArticlePreviewGeneration(h.options)
      expect(await g.generate(new AbortController().signal)).not.toBeNull()
      expect(g.attachmentState.value).toEqual({ status: 'missing', projection: null, reason: 'attachment-business-owner-missing' })
    } finally { h.owner.dispose() }
  })
  it('blocks a configured but unavailable owner without requesting a preview', async () => {
    const h = harness()
    try {
      const g = useArticlePreviewGeneration({ ...h.options, attachmentBusiness: () => null })
      expect(await g.generate(new AbortController().signal)).toBeNull()
      expect(g.attachmentState.value.status).toBe('blocked')
      expect(h.target.value).toEqual(h.previous)
      expect(h.requestPreview).not.toHaveBeenCalled()
    } finally { h.owner.dispose() }
  })
  it('requires the existing live context subscription for configured attachment qualification', async () => {
    const h = harness()
    try {
      const p = projectionFor(h.owner.context)
      const assess = vi.fn(async () => p)
      const g = useArticlePreviewGeneration({ ...h.options,
        documentContext: { context: h.owner.context, isCurrentContext: context => h.owner.isCurrentContext(context) },
        attachmentBusiness: () => ({ assess, verify: async () => true }) })
      expect(await g.generate(new AbortController().signal)).toBeNull()
      expect(g.attachmentState.value.reason).toBe('preview-context-observer-missing')
      expect(assess).not.toHaveBeenCalled()
      g.dispose()
    } finally { h.owner.dispose() }
  })
  it('retains original pending projection and refuses rendering rather than deriving assets', async () => {
    const h = harness()
    try {
      const p = projectionFor(h.owner.context, true)
      const port = { assess: vi.fn(async () => p), verify: vi.fn(async () => true) }
      const g = useArticlePreviewGeneration({ ...h.options, attachmentBusiness: () => port })
      expect(await g.generate(new AbortController().signal)).toBeNull()
      expect(g.attachmentState.value.projection).toBe(p)
      expect(g.attachmentState.value.status).toBe('blocked')
      expect(h.requestPreview).not.toHaveBeenCalled()
      expect(port.verify).not.toHaveBeenCalled()
    } finally { h.owner.dispose() }
  })
  it('borrows both read methods, verifies again after rendering, and preserves the exact projection reference', async () => {
    const h = harness()
    try {
      const p = projectionFor(h.owner.context)
      const port = { assess: vi.fn(async () => p), verify: vi.fn(async () => true) }
      const g = useArticlePreviewGeneration({ ...h.options, attachmentBusiness: () => port })
      expect(await g.generate(new AbortController().signal)).not.toBeNull()
      expect(port.verify).toHaveBeenCalledTimes(2)
      expect(g.attachmentState.value.projection).toBe(p)
      expect(g.attachmentState.value.status).toBe('ready')
    } finally { h.owner.dispose() }
  })
  it('rejects ledger/version/permission drift reported by live verification after rendering', async () => {
    const h = harness()
    try {
      const p = projectionFor(h.owner.context)
      const port = { assess: async () => p, verify: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) }
      const g = useArticlePreviewGeneration({ ...h.options, attachmentBusiness: () => port })
      expect(await g.generate(new AbortController().signal)).toBeNull()
      expect(g.attachmentState.value.status).toBe('stale')
      expect(h.target.value).toEqual(h.previous)
    } finally { h.owner.dispose() }
  })
  it.each(['digest', 'context', 'extra-field'])('rejects %s tamper before trusting an owner verification result', async (mutation) => {
    const h = harness()
    const foreign = createArticleDocumentContextAdapter({ articleId: 2, draftId: 'article:2', editorSessionId: 'session:foreign', content: 'content A', siteScope: 'site:test', userScope: 'user:test' })
    try {
      const p = projectionFor(mutation === 'context' ? foreign.context : h.owner.context)
      const candidate = Object.freeze(mutation === 'digest' ? { ...p, contentDigest: '0'.repeat(64) }
        : mutation === 'extra-field' ? { ...p, verified: true } : p)
      const port = { assess: async () => candidate, verify: vi.fn(async () => true) }
      const g = useArticlePreviewGeneration({ ...h.options, attachmentBusiness: () => port })
      expect(await g.generate(new AbortController().signal)).toBeNull()
      expect(port.verify).not.toHaveBeenCalled()
      expect(h.requestPreview).not.toHaveBeenCalled()
    } finally { h.owner.dispose(); foreign.dispose() }
  })
  it('refuses an initial owner verification rejection before calling the preview transport', async () => {
    const h = harness()
    try {
      const p = projectionFor(h.owner.context)
      const port = { assess: async () => p, verify: vi.fn(async () => false) }
      const g = useArticlePreviewGeneration({ ...h.options, attachmentBusiness: () => port })
      expect(await g.generate(new AbortController().signal)).toBeNull()
      expect(g.attachmentState.value.status).toBe('stale')
      expect(h.requestPreview).not.toHaveBeenCalled()
    } finally { h.owner.dispose() }
  })
  it('clears qualification if the original source admission factory refuses the owner', async () => {
    const h = harness()
    try {
      const g = useArticlePreviewGeneration({ ...h.options, sourceAdmission: () => { throw new Error('source-owner-refused') } })
      await expect(g.generate(new AbortController().signal)).rejects.toThrow('source-owner-refused')
      expect(g.attachmentState.value.status).toBe('failed')
      expect(g.attachmentState.value.projection).toBeNull()
    } finally { h.owner.dispose() }
  })
  it('settles cancel while an assessment ignores abort and discards its late result', async () => {
    const h = harness()
    try {
      const p = projectionFor(h.owner.context)
      const pending = deferred<typeof p>()
      const port = { assess: vi.fn(() => pending.promise), verify: vi.fn(async () => true) }
      const g = useArticlePreviewGeneration({ ...h.options, attachmentBusiness: () => port })
      const controller = new AbortController()
      const run = g.generate(controller.signal)
      await vi.waitFor(() => expect(port.assess).toHaveBeenCalledTimes(1))
      controller.abort()
      expect(await run).toBeNull()
      pending.resolve(p)
      await Promise.resolve()
      expect(h.target.value).toEqual(h.previous)
      expect(g.attachmentState.value.status).toBe('canceled')
    } finally { h.owner.dispose() }
  })
  it('does not let an older assessment overwrite a newer ready state', async () => {
    const h = harness()
    try {
      const p = projectionFor(h.owner.context)
      const old = deferred<typeof p>()
      const port = { assess: vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(p), verify: async () => true }
      const g = useArticlePreviewGeneration({ ...h.options, attachmentBusiness: () => port })
      const first = g.generate(new AbortController().signal)
      await vi.waitFor(() => expect(port.assess).toHaveBeenCalledTimes(1))
      expect(await g.generate(new AbortController().signal)).not.toBeNull()
      old.resolve(p)
      expect(await first).toBeNull()
      expect(g.attachmentState.value.status).toBe('ready')
    } finally { h.owner.dispose() }
  })
  it('withdraws ready resource identity immediately after an actual owner revision', async () => {
    const h = harness()
    try {
      const p = projectionFor(h.owner.context)
      const g = useArticlePreviewGeneration({ ...h.options, attachmentBusiness: () => ({ assess: async () => p, verify: async () => true }) })
      await g.generate(new AbortController().signal)
      expect(g.attachmentState.value.status).toBe('ready')
      h.owner.updateSource('changed')
      expect(g.attachmentState.value.status).toBe('stale')
      expect(g.attachmentState.value.projection).toBeNull()
      g.dispose()
    } finally { h.owner.dispose() }
  })
  it('consumer disposal settles an abort-ignoring assessment and leaves its host owner current', async () => {
    const h = harness()
    try {
      const p = projectionFor(h.owner.context)
      const pending = deferred<typeof p>()
      const assess = vi.fn(() => pending.promise)
      const g = useArticlePreviewGeneration({ ...h.options, attachmentBusiness: () => ({ assess, verify: async () => true }) })
      const run = g.generate(new AbortController().signal)
      await vi.waitFor(() => expect(assess).toHaveBeenCalledTimes(1))
      g.dispose()
      expect(await run).toBeNull()
      expect(h.owner.isCurrentContext(p.context)).toBe(true)
      pending.resolve(p)
      await Promise.resolve()
      expect(g.attachmentState.value.status).toBe('canceled')
      expect(g.attachmentState.value.projection).toBeNull()
      expect(await g.generate(new AbortController().signal)).toBeNull()
      g.dispose()
    } finally { h.owner.dispose() }
  })
  it('rejects a source revision change during actual business observation', async () => {
    const h = harness()
    try {
      const p = projectionFor(h.owner.context)
      const port = { assess: async () => { h.owner.updateSource('changed'); return p }, verify: vi.fn(async () => true) }
      const g = useArticlePreviewGeneration({ ...h.options, attachmentBusiness: () => port })
      expect(await g.generate(new AbortController().signal)).toBeNull()
      expect(port.verify).not.toHaveBeenCalled()
      expect(h.target.value).toEqual(h.previous)
    } finally { h.owner.dispose() }
  })
})
