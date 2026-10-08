// @vitest-environment happy-dom

import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ElMarkdownEditor,
  ElDrawer,
  ElIcon,
  type MarkdownEditorDispatchResult,
  type MarkdownEditorTransaction,
  type MarkdownEditorTransactionEvent
} from '@ozwasyd/element-plus'
import ArticleWriteEditor from '@/components/admin/article/ArticleWriteEditor.vue'
import { useAdminArticleWrite } from '@/composables/useAdminArticleWrite'
import type { ArticleEditorContinuityPort } from '@/services/authoring/articleEditorContinuity'
import { renderMarkdownResultWithRuntime } from '@ozwasyd/element-plus/markdown-runtime'
import { calculateOpenArticleDocumentDigest as digest } from '@/services/authoring/openArticleDocumentRegistry'
import { useAdminStore } from '@/store/admin'

// Only transport/upload setup is replaced. The production Writer, editor host,
// document authority, binding, leases, cache, projection and renderer are real.
// This mounts the production editor host, not App.vue's private route boundary.
// Permission revocation through its authGeneration/isClearing route owner remains
// unverified here; the binding offers no direct revoke/permission API.
// Candidate: FsusBlog 790b3abb4c6de0da2d9fe177c04c05e7ce8695cc.
// Binding and consumption are supplied by the caller below through the shipped
// three-layer getter/events. This does not qualify the full Write.vue route.
const network = vi.hoisted(() => ({
  route: { params: {} as Record<string, string>, query: {} },
  article: vi.fn(), draft: vi.fn(), save: vi.fn(), publish: vi.fn(), update: vi.fn(),
  preview: vi.fn(), prepublish: vi.fn()
}))

vi.mock('vue-router', () => ({
  useRoute: () => network.route,
  useRouter: () => ({ push: vi.fn() })
}))
vi.mock('@/api/article', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/article')>(),
  getAdminArticleById: network.article,
  createArticle: network.publish,
  updateArticle: network.update
}))
vi.mock('@/api/authoring', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/authoring')>(),
  getServerDraft: network.draft,
  saveServerDraft: network.save,
  discardServerDraft: vi.fn(),
  listAssetLibrary: vi.fn().mockResolvedValue([]),
  listArticleRevisions: vi.fn().mockResolvedValue([]),
  previewArticleDraft: network.preview,
  checkArticlePrepublish: network.prepublish
}))
vi.mock('@/api/category', () => ({ getCategories: vi.fn().mockResolvedValue([]), createCategory: vi.fn() }))
vi.mock('@/api/tag', () => ({ getTags: vi.fn().mockResolvedValue([]), createTag: vi.fn() }))
vi.mock('@/api/system', () => ({
  getAdminSiteConfig: vi.fn().mockResolvedValue({ siteName: 'Writer QA', enableArticleRights: false, rights: {} }),
  getAdminSiteComplianceConfig: vi.fn().mockResolvedValue({})
}))
vi.mock('@/composables/useImageUploadPreferences', () => ({
  useImageUploadPreferences: () => ({ options: {}, wasmOnlyMode: { value: false }, setOptions: vi.fn(), setWasmOnlyMode: vi.fn() })
}))
vi.mock('@/composables/useImageUploadRuntime', () => ({ useImageUploadRuntime: () => ({}) }))
vi.mock('@/composables/useImageUploadFlow', () => ({ useImageUploadFlow: () => ({ run: vi.fn(), cancel: vi.fn() }) }))

type Writer = ReturnType<typeof useAdminArticleWrite>
type Bound = ReturnType<Writer['authoringEditorRuntime']['bindEditor']>
const mounted: VueWrapper[] = []
const source = '# PRIVATE-WRITER-2245\n\nIdentical body across documents.'
const options = {
  surface: 'source' as const,
  configuration: { allowLatex: true, allowMermaid: true, baseUrl: null },
  identity: { themeDigest: digest({ theme: 'writer-integration' }), locale: 'zh-CN' },
  cachePolicy: { maxEntryBytes: 262144, maxAgeMs: 60000, maxReceipts: 16 }
}
const capture = { affinity: 'after' as const, viewportOffset: 0, percentage: 0, surface: 'source' as const, tool: 'none' as const }

async function mountWriter(articleId: number) {
  network.route.params = { id: String(articleId) }
  let writer!: Writer
  let bound: Bound | null = null
  const observed = { transactions: [] as boolean[], selections: [] as boolean[], focus: [] as boolean[] }
  const Host = defineComponent({
    setup() {
      writer = useAdminArticleWrite()
      return () => writer.pageLoading.value
        ? h('p', 'Loading writer')
        : h(ArticleWriteEditor, {
            modelValue: writer.articleForm.content,
            documentIdentity: writer.authoringDocumentIdentity.value,
            articleIdentity: `article:${articleId}`,
            'onUpdate:modelValue': (value: string) => { writer.articleForm.content = value },
            onTransaction: (event: MarkdownEditorTransactionEvent) => {
              if (bound) observed.transactions.push(bound.binding.consumeTransaction(event))
            },
            onSelectionChange: (event: Parameters<Bound['binding']['consumeSelection']>[0]) => {
              if (bound) observed.selections.push(bound.binding.consumeSelection(event))
            },
            onEditorFocus: (event: 'focusin' | 'focusout') => {
              if (bound) observed.focus.push(bound.binding.consumeFocus(event))
            }
          })
    }
  })
  const wrapper = mount(Host, { attachTo: document.body, global: { components: { ElDrawer, ElIcon } } })
  mounted.push(wrapper)
  await vi.waitFor(() => {
    expect(writer.pageLoading.value, 'Writer transport setup must finish before binding').toBe(false)
  }, { timeout: 2500, interval: 10 })
  await nextTick()
  const editorHost = wrapper.findComponent(ArticleWriteEditor)
  const hostPort = editorHost.vm as unknown as { getAuthoringEditorPort(): ArticleEditorContinuityPort | null }
  const commands = hostPort.getAuthoringEditorPort()
  expect(commands, 'the production three-layer getter must expose the mounted public editor').not.toBeNull()
  if (!commands) throw new Error('article-write-host-port-unavailable')
  expect(hostPort.getAuthoringEditorPort()).toBe(commands)
  // Nested lookup verifies public instance identity only; the caller acquires
  // its port exclusively through ArticleWriteEditor.getAuthoringEditorPort().
  const editor = wrapper.findComponent(ElMarkdownEditor)
  expect(editor.exists(), 'production ArticleWriteEditor must mount the actual public FsusUI editor').toBe(true)
  expect(commands.dispatchTransaction).toBe(editor.vm.dispatchTransaction)
  bound = writer.authoringEditorRuntime.bindEditor(commands, options)
  expect(bound.binding.initialize()).toBe(true)
  const dispatch = (transaction: MarkdownEditorTransaction): MarkdownEditorDispatchResult => commands.dispatchTransaction(transaction)
  return { wrapper, writer, editor, editorHost, bound, runtime: bound.binding, observed, dispatch }
}

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  const store = useAdminStore()
  store.setAdminPrincipal({ id: `writer-qa-${expect.getState().currentTestName?.replace(/[^a-zA-Z0-9]/g, '').slice(-48)}`,
    displayName: 'Writer QA', source: 'independent', permissions: ['article.write'], adminSessionStatus: 'active' })
  network.article.mockImplementation(async (id: number) => ({ id, title: 'Private document', content: '', status: 0, tags: [], rights: {} }))
  network.draft.mockResolvedValue(null)
  network.save.mockResolvedValue({ clientRevision: 'writer-qa-local', serverRevision: 1, savedAt: Date.now(), updatedAt: new Date().toISOString() })
})

afterEach(() => {
  mounted.splice(0).reverse().forEach(wrapper => wrapper.unmount())
  vi.restoreAllMocks()
})

describe('mounted production Writer draft boundaries (real local FsusUI)', () => {
  it('consumes real transaction, selection and focus events through the three-layer host port', async () => {
    const host = await mountWriter(224501)
    const transaction = host.dispatch({ changes: [{ from: 0, to: 0, insert: source }], history: 'separate', origin: 'programmatic',
      selection: { start: 2, end: 9, direction: 'backward' } })
    expect(transaction.accepted).toBe(true)
    await nextTick()
    expect(host.writer.articleForm.content).toBe(source)
    expect(host.observed.transactions.at(-1)).toBe(true)
    expect(host.observed.selections.at(-1)).toBe(true)
    expect(host.editorHost.emitted('transaction')).toHaveLength(host.observed.transactions.length)
    expect(host.editorHost.emitted('selection-change')?.length).toBeGreaterThan(0)
    const textarea = host.wrapper.get('textarea').element as HTMLTextAreaElement
    textarea.focus()
    await nextTick()
    expect(document.activeElement).toBe(textarea)
    expect(host.observed.focus.at(-1)).toBe(true)
    const context = host.runtime.continuity.capture(host.runtime.positionBinding(), capture)
    expect(context.document.contextDigest).toBe(host.writer.authoringDocumentContext.value.contextDigest)
    expect(context.anchor.range).toEqual({ start: 2, end: 9 })
    expect(context.history).toEqual(transaction.history)
    expect(context.focus).toBe('editor')
    textarea.blur()
    await nextTick()
    expect(host.observed.focus.at(-1)).toBe(true)
    expect(host.runtime.continuity.capture(host.runtime.positionBinding(), capture).focus).toBe('outside')
  })

  it('isolates identical bodies in different mounted documents and rejects an old tool result', async () => {
    const first = await mountWriter(224502)
    const firstChange = first.dispatch({ changes: [{ from: 0, to: 0, insert: source }], history: 'separate', origin: 'programmatic' })
    expect(first.observed.transactions.at(-1)).toBe(true)
    const publicRender = await renderMarkdownResultWithRuntime({ source, mode: 'editor', ...options.configuration })
    const receipt = await first.runtime.autoRefresh()
    const oldContext = first.runtime.context
    const oldRender = first.runtime.renderState.content?.result
    const oldTool = first.runtime.beginToolTask('publish-preview')
    first.wrapper.unmount()
    expect(oldTool.signal.aborted).toBe(true)
    expect(first.runtime.retainedRender).toBeNull()

    const second = await mountWriter(224503)
    const secondChange = second.dispatch({ changes: [{ from: 0, to: 0, insert: source }], history: 'separate', origin: 'programmatic' })
    expect(secondChange.accepted).toBe(true)
    expect(second.observed.transactions.at(-1)).toBe(true)
    expect(second.runtime.context.documentId).not.toBe(oldContext.documentId)
    expect(second.runtime.context.contentDigest).toBe(oldContext.contentDigest)
    expect(second.runtime.context.contextDigest).not.toBe(oldContext.contextDigest)
    expect(second.runtime.renderState.content).toBeNull()
    expect(second.runtime.consumeTransaction(firstChange)).toBe(false)
    expect(oldTool.accept(firstChange).accepted).toBe(false)
    const secondReceipt = await second.runtime.autoRefresh()
    // Check available context/lease boundaries before reporting a real runtime
    // initialization failure; never replace the unavailable renderer result.
    expect(publicRender.ok, publicRender.ok ? undefined : JSON.stringify(publicRender.error,
      (_key, value) => value instanceof Error ? { message: value.message, stack: value.stack } : value)).toBe(true)
    expect(receipt?.status, receipt?.reason ?? 'missing render receipt').toBe('committed')
    expect(secondReceipt?.status, secondReceipt?.reason ?? 'missing render receipt').toBe('committed')
    expect(second.runtime.renderState.content!.result.resultRef).not.toBe(oldRender!.resultRef)
    expect(second.runtime.retainedRender?.render.rawSource).toBe(source)
    expect(network.publish).not.toHaveBeenCalled()
    expect(network.update).not.toHaveBeenCalled()
    expect(network.preview).not.toHaveBeenCalled()
  })

  it('cancels superseded and closed tool leases without admitting late public renderer results', async () => {
    const host = await mountWriter(224504)
    expect(host.dispatch({ changes: [{ from: 0, to: 0, insert: source }], history: 'separate', origin: 'programmatic' }).accepted).toBe(true)
    expect(host.observed.transactions.at(-1)).toBe(true)
    const preview = host.runtime.beginToolTask('publish-preview')
    const compare = host.runtime.beginToolTask('source-compare')
    expect(preview.signal.aborted).toBe(true)
    expect(compare.isCurrent()).toBe(true)
    const pendingRender = host.runtime.autoRefresh()
    host.runtime.cancelToolTask()
    const renderReceipt = await pendingRender
    expect(compare.signal.aborted).toBe(true)
    expect(compare.accept(renderReceipt).accepted).toBe(false)
    expect(renderReceipt?.status, renderReceipt?.reason ?? 'missing render receipt').toBe('committed')
    // Closing a tool must not cancel the independently owned editor render.
    expect(host.runtime.retainedRender?.render.rawSource).toBe(source)
    expect(host.runtime.attachmentTaskLeases).toEqual([])
    expect(network.publish).not.toHaveBeenCalled()
    expect(network.prepublish).not.toHaveBeenCalled()
  })

  it('unmounts during a pending renderer request, releases attachments and rejects late leases', async () => {
    const host = await mountWriter(224505)
    expect(host.dispatch({ changes: [{ from: 0, to: 0, insert: source }], history: 'separate', origin: 'programmatic' }).accepted).toBe(true)
    expect(host.observed.transactions.at(-1)).toBe(true)
    const attachments = host.writer.authoringAttachmentRuntime
    const anchor = attachments.captureAnchor({ start: source.length, end: source.length, direction: 'none' }, capture)
    const attachment = attachments.commitCreated(attachments.capture({ origin: 'pick', anchor,
      files: [{ name: 'private.png', mimeType: 'image/png', byteLength: 5 }] }))[0]!
    const preview = host.runtime.beginToolTask('publish-preview')
    const pendingRender = host.runtime.autoRefresh()
    // Yield once so the real producer starts; no mocked scheduler or renderer.
    // This proves pending-request cancellation even if WASM initialization fails;
    // it does not prove disposal after a successful held renderer result.
    await Promise.resolve()
    expect(host.runtime.renderState.refreshState).toBe('running')
    host.wrapper.unmount()
    const receipt = await pendingRender
    expect(receipt?.status).toBe('canceled')
    await flushPromises()
    expect(attachment.signal.aborted).toBe(true)
    expect(preview.signal.aborted).toBe(true)
    expect(preview.accept(receipt).accepted).toBe(false)
    expect(host.runtime.attachmentTaskLeases).toEqual([])
    expect(host.runtime.renderState.content).toBeNull()
    expect(host.runtime.retainedRender).toBeNull()
    expect(host.writer.articleForm.content).toBe('')
    expect(() => host.runtime.beginToolTask('publish-preview')).toThrow('article-editor-runtime-binding-disposed')
    expect(host.runtime.consumeSelection({ documentIdentity: host.writer.authoringDocumentIdentity.value,
      revision: host.runtime.context.sourceRevision, selection: { start: 0, end: 0, direction: 'none' } })).toBe(false)
  })
})
