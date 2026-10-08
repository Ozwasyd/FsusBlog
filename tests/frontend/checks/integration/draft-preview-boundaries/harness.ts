import { createApp, h, nextTick, shallowRef } from 'vue'
import { ElMarkdownRenderer } from '@ozwasyd/element-plus'
import { MARKDOWN_RENDERER_VERSION, createMarkdownAnchorMap } from '@ozwasyd/element-plus/markdown-runtime'
import { ArticleFsusUiRenderProducer } from '@/services/authoring/articleFsusUiRenderProducer'
import { ArticleRenderCache, type ArticleRenderProducer, type ArticleRenderRequest, type ArticleRenderResult } from '@/services/authoring/articleRenderCache'
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext'
import { ArticleAnchorContextAdapter } from '@/services/authoring/articleAnchorContext'
import { calculateOpenArticleDocumentDigest as digest } from '@/services/authoring/openArticleDocumentRegistry'

// This isolated consumer exercises the real cache, public renderer and anchor owners.
// It is deliberately not a published-preview route or an authentication endpoint.
const configuration = { allowLatex: true, allowMermaid: true, baseUrl: null }
let source = '# Private draft boundary\n\nSame body in two documents.'
const owner = createArticleDocumentContextAdapter({ articleId: 11, draftId: 'draft:browser-a',
  editorSessionId: 'session:browser', siteScope: 'site:browser', userScope: 'user:browser-a', content: source })
const producer = new ArticleFsusUiRenderProducer(() => source, configuration, 2_000_000)
let holdNext = false
let heldResult: ArticleRenderResult | null = null
let releaseDelivery: (() => void) | null = null
let deliveryCompleted: Promise<void> | null = null

// Test-only scheduling delays delivery of an actual public-renderer result. It never
// manufactures results or receipts, and makes no claim to interrupt synchronous WASM.
const scheduledProducer: ArticleRenderProducer = {
  async render(request: ArticleRenderRequest) {
    const hold = holdNext
    holdNext = false
    const result = await producer.render(request)
    if (hold) {
      heldResult = result
      await new Promise<void>(resolve => { releaseDelivery = resolve })
    }
    return result
  },
  verify: (request, result) => producer.verify(request, result),
  release: resultRef => producer.release(resultRef),
}
const cache = new ArticleRenderCache(owner, {
  rendererVersion: MARKDOWN_RENDERER_VERSION, projectionVersion: MARKDOWN_RENDERER_VERSION,
  featureConfigurationDigest: digest(configuration), themeDigest: digest({ theme: 'browser' }), locale: 'en-US',
}, scheduledProducer, { maxEntryBytes: 2_000_000, maxAgeMs: 60_000, maxReceipts: 16 })
const anchors = new ArticleAnchorContextAdapter(owner)
const state = shallowRef(cache.state)
const retained = shallowRef<ReturnType<typeof producer.resolve>>(null)
const identity = shallowRef(owner.context)
const receipt = shallowRef<Awaited<ReturnType<typeof cache.refresh>> | null>(null)
const errors: string[] = []
let pending: Promise<void> | null = null
let savedAnchor: ReturnType<typeof anchors.capture> | null = null

const sync = async () => {
  state.value = cache.state
  retained.value = state.value.content ? producer.resolve(state.value.content.result) : null
  identity.value = owner.context
  await nextTick()
}
const refresh = async () => {
  const result = cache.refresh()
  await sync()
  receipt.value = await result
  await sync()
}
const startHeld = async () => {
  holdNext = true
  heldResult = null
  pending = refresh()
  deliveryCompleted = pending
  await sync()
}
const update = async () => {
  source = '# Late private draft boundary\n\nResult must never replace a canceled or revoked view.'
  owner.updateSource(source)
  await sync()
}
const switchDocument = async (userScope = owner.context.userScope) => {
  owner.switchDocument({ articleId: 22, draftId: 'draft:browser-b', content: source, userScope })
  await sync()
}
const captureAnchor = () => {
  const binding = { document: owner.context, map: createMarkdownAnchorMap({ identity: owner.documentIdentity, source }) }
  savedAnchor = anchors.capture(binding, { start: 0, end: 4, direction: 'forward' },
    { affinity: 'after', viewportOffset: 0, percentage: 0, surface: 'source', tool: 'publish-preview' })
}
const restoreAnchor = () => {
  if (!savedAnchor) throw new Error('browser-anchor-not-captured')
  return anchors.restore(savedAnchor, { document: owner.context,
    map: createMarkdownAnchorMap({ identity: owner.documentIdentity, source }) },
  { origin: 'tool', now: performance.now(), viewportHeight: innerHeight, reducedMotion: true })
}
const invoke = (action: () => void | Promise<void>) => async () => {
  try { await action() } catch (error) { errors.push(String(error)) }
}

createApp({ setup: () => () => h('main', [
  h('p', { 'data-testid': 'qualification' }, 'Isolated real owner and public-renderer integration; no deployed preview or permission proof.'),
  ...[
    ['refresh', refresh], ['update', update], ['hold', startHeld],
    ['cancel', async () => { cache.cancel(); await pending; await sync() }],
    ['release', async () => { releaseDelivery?.(); releaseDelivery = null; await deliveryCompleted; await sync() }],
    ['switch-document', () => switchDocument()], ['switch-user', () => switchDocument('user:browser-b')],
    ['capture-anchor', captureAnchor],
    ['dispose-owner', async () => { owner.dispose(); await pending; await sync() }],
  ].map(([id, action]) => h('button', { 'data-testid': id, onClick: invoke(action as () => void | Promise<void>) }, id)),
  h('section', { 'data-testid': 'preview' }, retained.value ? h(ElMarkdownRenderer, {
    key: identity.value.contextDigest, content: retained.value.render.rawSource,
    initialRender: retained.value.render, contentVersion: identity.value.contextDigest,
    mode: 'editor', ...configuration,
  }) : h('p', { 'data-testid': 'fallback' }, state.value.fallback ?? 'No cached render')),
  h('output', { 'data-testid': 'state' }, JSON.stringify({ document: identity.value, state: state.value,
    receipt: receipt.value, held: heldResult?.status ?? null, errors })),
]) }).mount('#app')

Object.assign(window, { draftBoundaryHarness: {
  snapshot: () => ({ document: owner.context, state: cache.state, receipt: receipt.value,
    heldResult, heldResolved: heldResult ? producer.resolve(heldResult) !== null : null,
    retained: cache.state.content ? producer.resolve(cache.state.content.result) : null,
    receipts: cache.receipts, errors }),
  restoreAnchor,
} })
