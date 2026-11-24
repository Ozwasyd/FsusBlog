<script setup lang="ts">
import { t } from '../siteLocale'
import { computed, nextTick, onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, RouterLink, useRoute, useRouter } from 'vue-router'
import { ElAlert, ElButton, ElDialog, ElMessageBox } from '@ozwasyd/element-plus'
import { api } from '../../../Contracts/client'
import {
  canvasGraph, defaultCanvasViewport, type CanvasGeometry, type CanvasGraphChange, type CanvasGraphCommand,
  type CanvasGraphEdge, type CanvasNode, type CanvasViewport,
} from '../../../Contracts/canvas-graph'
import { confirmCanvasLink, previewCanvasLink } from '../../../Contracts/canvas-links'
import { canvasBundle } from '../../../Contracts/canvas-bundle'
import { cancelCanvasEditorHandoff, canvasEditorHandoffKey, offerCanvasEditorHandoff } from '../authoring/canvasEditorHandoff'
import {
  filterEndpointChoices, filterMemberChoices, filterOutlineEdges, filterOutlineNodes, hasNextOutlinePage,
  resolveHistoryShortcutAction, sliceOutlineRecords, type CanvasNotice,
} from '../authoring/canvasCommands'
import { CanvasController, type CanvasFormFields, type CanvasIdentity } from '../authoring/canvasController'
import CanvasBoard from '../authoring/CanvasBoard.vue'
import CanvasBundlePanel from '../authoring/CanvasBundlePanel.vue'
import { credentialEpoch, currentSession, identityEpoch, invalidateSession, refreshSession } from '../authorSession'
import { consumeAuthoringSessionPreload, readInitialCanvasDocuments } from '../workspacePreload'

const route = useRoute()
const router = useRouter()
const articlePath = '/admin/articles/workspace'
const documentId = computed(() => typeof route.params.id === 'string' ? route.params.id.toLowerCase() : '')
const preloadedAuth = consumeAuthoringSessionPreload()
const initialCanvasDocuments = readInitialCanvasDocuments()
const ready = ref(preloadedAuth)
const tools = ref<HTMLElement>()
const graph = ref<HTMLElement>()
const ownerLife = new AbortController()

function currentIdentity(): CanvasIdentity | null {
  const session = currentSession.value
  if (!session) return null
  return {
    name: session.name,
    generation: session.generation,
    canAuthor: session.canAuthor,
    expiresAt: session.expiresAt,
    siteSessionId: session.siteSessionId,
    credentialEpoch: credentialEpoch.value,
  }
}

const controller = new CanvasController({
  transport: {
    list: signal => canvasGraph.list(signal),
    page: (id, position, signal) => canvasGraph.page(id, position, signal),
    history: (id, expectedRevision, signal) => canvasGraph.history(id, expectedRevision, signal),
    write: (command, signal) => canvasGraph.write(command, signal),
    resolveReference: (id, nodeId, revision, signal, session) => canvasGraph.resolve(id, nodeId, revision, signal, session),
    readDraft: (articleId, signal) => api.draft(articleId, signal),
    readPublicArticle: (articleId, signal) => api.publicArticle(articleId, signal),
    previewLink: (input, host, target, signal, visualOnly) => previewCanvasLink(input, host, target, signal, visualOnly),
    confirmLink: (preview, signal) => confirmCanvasLink(preview, signal),
  },
  navigation: {
    openDocument: id => router.push({ name: 'canvas-document', params: { id } }),
    openCanvasList: () => router.replace({ name: 'canvas' }),
    openEditor: async (articleId, token) => !(await router.push({
      name: 'edit',
      params: { id: articleId },
      state: { [canvasEditorHandoffKey]: token },
    })),
  },
  handoff: {
    offer: offerCanvasEditorHandoff,
    cancel: cancelCanvasEditorHandoff,
  },
  onInvalidateSession: () => invalidateSession(),
  nativeMarkdownAvailable: Boolean(import.meta.env.FSUS_MARKDOWN_NATIVE),
})

const state = shallowRef(controller.state)
const unsubscribe = controller.subscribe(() => { state.value = controller.state })

watch([documentId, identityEpoch, currentSession, ready], () => {
  controller.syncContext({
    documentId: documentId.value,
    identity: currentIdentity(),
    identityEpoch: identityEpoch.value,
    ready: ready.value,
    initialDocuments: initialCanvasDocuments,
  })
}, { immediate: true, flush: 'sync' })

const formatNotice = (notice: CanvasNotice | undefined) =>
  notice ? (notice.kind === 'text' ? notice.text : t(notice.key)) : ''

const authorized = computed(() => state.value.authorized)
const loading = computed(() => state.value.loading)
const working = computed(() => state.value.working)
const bundlePending = computed({
  get: () => state.value.bundlePending,
  set: value => controller.setBundlePending(value),
})
const stale = computed(() => state.value.stale)
const graphReadFailure = computed(() => state.value.graphReadFailure)
const message = computed(() => formatNotice(state.value.message))
const error = computed(() => formatNotice(state.value.error))
const document = computed(() => state.value.document)
const documents = computed(() => state.value.documents)
const nodes = computed(() => state.value.nodes)
const edges = computed(() => state.value.edges)
const byId = computed(() => state.value.byId)
const offset = computed(() => state.value.offset)
const view = computed({
  get: () => state.value.view,
  set: value => controller.setView(value),
})
const outlinePage = computed({
  get: () => state.value.outlinePage,
  set: value => {
    if (value < state.value.outlinePage) controller.previousOutlinePage()
    else if (value > state.value.outlinePage) controller.nextOutlinePage()
  },
})
const outlineSearch = computed({
  get: () => state.value.outlineSearch,
  set: value => controller.setOutlineSearch(value),
})
const focusBoardNode = computed({
  get: () => state.value.focusBoardNode,
  set: value => { if (!value) controller.clearFocusRequest() },
})
const loadingAll = computed(() => state.value.loadingAll)
const bulkProgress = computed(() => state.value.bulkProgress)
const nodeId = computed(() => state.value.nodeId)
const edgeId = computed(() => state.value.edgeId)
const selectedNode = computed(() => state.value.selectedNode)
const selectedEdge = computed(() => state.value.selectedEdge)
const selectedReference = computed(() => state.value.selectedReference)
const activeLink = computed(() => state.value.activeLink)
const retry = computed(() => state.value.retry)
const plan = computed(() => state.value.plan)
const linkPending = computed(() => state.value.linkPending)
const linkUnconfirmed = computed(() => state.value.linkUnconfirmed)
const historyFailure = computed(() => state.value.historyFailure)
const historyLoading = computed(() => state.value.historyLoading)
const historyActionAvailable = computed(() => state.value.historyActionAvailable)
const reference = computed(() => state.value.reference)
const referenceLoading = computed(() => state.value.referenceLoading)
const referenceError = computed(() => state.value.referenceError)
const referenceOpenNotice = computed(() => formatNotice(state.value.referenceOpenNotice))
const canOpenReference = computed(() => state.value.canOpenReference)
const disabled = computed(() => state.value.disabled)

const form = computed({
  get: () => state.value.form,
  set: value => { if (!value) controller.closeForm() },
})
function formField<K extends keyof CanvasFormFields>(key: K) {
  return computed({
    get: () => state.value[key],
    set: (value: CanvasFormFields[K]) => controller.updateForm({ [key]: value } as Partial<CanvasFormFields>),
  })
}
const title = formField('title')
const nodeKind = formField('nodeKind')
const note = formField('note')
const article = formField('article')
const anchor = formField('anchor')
const pinned = formField('pinned')
const members = computed(() => state.value.members)
const endpoint = formField('endpoint')
const editingNode = computed(() => state.value.editingNode)
const editingEdge = computed(() => state.value.editingEdge)
const choiceFilter = formField('choiceFilter')
const edgeKind = formField('edgeKind')
const label = formField('label')

const nodeTypeLabels = computed(() => ({
  'plain-text-note': t('author.canvas.note'),
  'article-reference': t('page.article'),
  'heading-reference': t('author.canvas.heading'),
  'block-reference': t('author.canvas.block'),
  'group-frame': t('author.canvas.frame'),
}))
function nodeLabel(node: CanvasNode): string {
  return 'text' in node ? node.text.slice(0, 70) : t('author.canvas.kind_reference_article', { kind: nodeTypeLabels.value[node.kind], article: node.articleId })
}
function edgeLabel(edge: CanvasGraphEdge) {
  const from = byId.value.get(edge.sourceNodeId)
  const to = byId.value.get(edge.targetNodeId)
  return edge.label || `${from ? nodeLabel(from) : t('author.canvas.unloaded_node')} → ${to ? nodeLabel(to) : t('author.canvas.unloaded_node')}`
}

const outlineQuery = computed(() => outlineSearch.value.trim().toLowerCase())
const matchingNodes = computed(() => filterOutlineNodes(nodes.value, outlineSearch.value, nodeLabel))
const matchingEdges = computed(() => filterOutlineEdges(edges.value, outlineSearch.value, edgeLabel))
const outlineNodes = computed(() => sliceOutlineRecords(matchingNodes.value, outlinePage.value))
const outlineEdges = computed(() => sliceOutlineRecords(matchingEdges.value, outlinePage.value))
const hasNextOutline = computed(() => hasNextOutlinePage(matchingNodes.value.length, matchingEdges.value.length, outlinePage.value))
const memberChoices = computed(() => filterMemberChoices(nodes.value, choiceFilter.value, nodeLabel))
const endpointChoices = computed(() => filterEndpointChoices(nodes.value, byId.value, endpoint.value, choiceFilter.value, nodeLabel))

const referenceStatus = computed(() => ({
  unavailable: t('author.canvas.this_reference_is_unavailable'),
  resolved: t('author.canvas.reference_resolved'),
  'missing-anchor': t('author.canvas.the_anchor_does_not_exist_at_this_revision'),
  'duplicate-anchor': t('author.canvas.the_anchor_is_ambiguous_at_this_revision'),
  'stale-revision': t('author.canvas.the_referenced_revision_is_unavailable'),
}))

onMounted(() => {
  if (preloadedAuth) return
  void refreshSession(ownerLife.signal).finally(() => {
    if (!ownerLife.signal.aborted) ready.value = true
  }).catch(() => { controller.setSessionVerificationError() })
})
function protectUnload(event: BeforeUnloadEvent) {
  if (controller.shouldProtectUnload) event.preventDefault()
}
onMounted(() => window.addEventListener('beforeunload', protectUnload))
onScopeDispose(() => {
  unsubscribe()
  ownerLife.abort()
  controller.dispose()
  window.removeEventListener('beforeunload', protectUnload)
})
const canNavigate = () => controller.canNavigate
onBeforeRouteUpdate(canNavigate)
onBeforeRouteLeave(canNavigate)

const load = (more = false) => controller.load(more)
const loadAll = () => controller.loadAll()
const loadHistory = () => controller.loadHistory()
const send = (command: CanvasGraphCommand) => controller.send(command)
const patch = (changes: CanvasGraphChange[] = [], name = '', viewport: CanvasViewport | null = null) =>
  controller.patch(changes, name, viewport)
const saveViewport = (viewport: CanvasViewport) => controller.saveViewport(viewport)
const zoom = (amount: number) => controller.zoom(amount)
const move = (id: string, geometry: CanvasGeometry) => controller.moveNode(id, geometry)
const chooseNode = (id: string) => controller.chooseNode(id)
const chooseEdge = (id: string) => controller.chooseEdge(id)
const showNode = () => controller.showNode()
const nameDocument = () => controller.openTitleForm()
const saveTitle = () => controller.saveTitle()
const addNode = (kind: CanvasNode['kind'] = 'plain-text-note', existing = false) => controller.openNodeForm(kind, existing)
const saveNode = () => controller.saveNode()
const addEdge = () => controller.openEdgeForm()
const showEdgeForm = (edge?: CanvasGraphEdge) => controller.openEdgeForm(edge)
const saveEdge = () => controller.saveEdge()
const resolveReference = () => controller.resolveReference()
const openReference = () => controller.openReference()
const prepareLink = () => controller.prepareLink()
const applyLink = () => controller.applyLink()
const cancelLink = () => controller.cancelLink()

function openImported(id: string) {
  void router.push({ name: 'canvas-document', params: { id } })
}

function setMembers(event: Event) {
  if (!(event.target instanceof HTMLSelectElement)) return
  const selected = Array.from(event.target.selectedOptions, option => option.value)
  controller.setFrameMembers(memberChoices.value, selected)
}

async function deleteDocument() {
  const selected = document.value
  const token = controller.contextToken
  if (!selected || disabled.value) return
  try { await ElMessageBox.confirm(t('author.canvas.delete_this_canvas_and_its_nodes_and_edges'), t('author.canvas.delete_canvas'), { confirmButtonText: t('account.message94') }) }
  catch { return }
  if (ownerLife.signal.aborted || controller.contextToken !== token) return
  await controller.deleteDocument(selected)
}

async function travel(action: 'undo' | 'redo') {
  const current = document.value
  if (!current || !historyActionAvailable.value[action]) return
  const token = controller.contextToken
  const trigger = tools.value?.querySelector<HTMLButtonElement>(`button.canvas-${action}`)
  const hadFocus = trigger === window.document.activeElement
  await controller.travel(action)
  await nextTick()
  if (!hadFocus || ownerLife.signal.aborted || controller.contextToken !== token || !controller.isAuthorized() || document.value?.id !== current.id) return
  const active = window.document.activeElement
  if (active !== trigger && active !== window.document.body) return
  if (trigger && !trigger.disabled) {
    trigger.focus()
  } else {
    const region = graph.value?.querySelector<HTMLElement>('.canvas-board, .canvas-outline')
    region?.focus({ preventScroll: true })
  }
}

function historyShortcut(event: KeyboardEvent) {
  const action = resolveHistoryShortcutAction(event)
  if (!action || !historyActionAvailable.value[action] || !(event.target instanceof HTMLElement) ||
    !graph.value?.contains(event.target) || event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return
  event.preventDefault()
  void travel(action)
}
</script>

<template>
  <main class="canvas-workspace" aria-labelledby="canvas-title" tabindex="-1" @keydown="historyShortcut">
    <header class="canvas-header">
      <div>
        <RouterLink :to="documentId ? '/admin/canvas' : articlePath">{{ documentId ? t('author.canvas.all_canvases') : t('page.article-workspace') }}</RouterLink>
        <h1 id="canvas-title">{{ document?.title ?? (documentId ? t('page.canvas-document') : t('author.canvas.canvases')) }}</h1>
      </div>
      <div v-if="authorized && ready" class="canvas-toolbar">
        <template v-if="!documentId">
          <ElButton type="primary" :disabled="disabled" @click="nameDocument">{{ t('author.canvas.new_canvas') }}</ElButton>
          <CanvasBundlePanel :key="identityEpoch" :disabled="disabled" @imported="openImported" @pending="bundlePending = $event" @expired="invalidateSession()" />
        </template>
        <template v-else-if="document">
          <ElButton :disabled="disabled" @click="nameDocument">{{ t('author.canvas.rename_canvas') }}</ElButton>
          <a v-if="!disabled" :href="canvasBundle.downloadHref(document.id, document.revision)" download="canvas.fsuscanvas"
            class="canvas-bundle-export" :title="t('author.canvas.download_revision_revision_notes_are_unencrypted', { revision: String(document.revision) })">{{ t('author.canvas.export_canvas_bundle') }}</a>
        </template>
      </div>
    </header>

    <p v-if="!ready" role="status">{{ t('author.canvas.verifying_author_session') }}</p>
    <RouterLink v-else-if="!authorized" :to="{ name: 'login', query: { redirect: route.fullPath } }">{{ t('author.canvas.log_in_to_access_canvas') }}</RouterLink>
    <template v-else>
      <ElAlert v-if="error" type="error" :title="error" :closable="false" />
      <p v-if="message" role="status">{{ message }}</p>
      <p v-if="loading && !document" role="status">{{ t('author.canvas.loading_canvas') }}</p>
      <div v-if="stale || retry || graphReadFailure" class="canvas-toolbar">
        <ElButton v-if="stale || graphReadFailure" :disabled="loading" @click="load()">{{ t('author.canvas.reload_canvas') }}</ElButton>
        <ElButton v-if="retry" :disabled="working" @click="send(retry)">{{ t('author.canvas.retry_change') }}</ElButton>
      </div>
      <section v-if="!documentId && !loading" :aria-label="t('author.canvas.canvas_documents')">
        <p v-if="!documents.length">{{ t('author.canvas.no_canvases_yet') }}</p>
        <ul v-else class="canvas-list">
          <li v-for="item in documents" :key="item.id">
            <RouterLink :to="{ name: 'canvas-document', params: { id: item.id } }">{{ item.title }}</RouterLink>
            <span>{{ t('author.canvas.nodes_nodes_edges_edges', { nodes: item.nodeCount, edges: item.edgeCount }) }}</span>
          </li>
        </ul>
      </section>

      <section v-if="document" :aria-label="t('author.canvas.canvas_document')">
        <div ref="tools" class="canvas-toolbar" role="group" :aria-label="t('author.canvas.canvas_tools')">
          <ElButton class="canvas-undo" native-type="button" :disabled="!historyActionAvailable.undo" @click="travel('undo')">{{ t('author.canvas.undo') }}</ElButton>
          <ElButton class="canvas-redo" native-type="button" :disabled="!historyActionAvailable.redo" @click="travel('redo')">{{ t('author.canvas.redo') }}</ElButton>
          <ElButton v-if="historyFailure" native-type="button" :disabled="disabled || historyLoading" @click="loadHistory()">{{ t('author.canvas.retry_canvas_history') }}</ElButton>
          <ElButton native-type="button" :disabled="disabled" @click="addNode()">{{ t('author.canvas.add_note') }}</ElButton>
          <ElButton native-type="button" :disabled="disabled" @click="addNode('article-reference')">{{ t('author.canvas.add_reference') }}</ElButton>
          <ElButton native-type="button" :disabled="disabled" @click="addNode('group-frame')">{{ t('author.canvas.add_frame') }}</ElButton>
          <ElButton native-type="button" :disabled="disabled || !selectedNode" @click="addEdge">{{ t('author.canvas.connect') }}</ElButton>
          <ElButton native-type="button" :disabled="disabled" @click="zoom(-250)">{{ t('author.canvas.zoom_out') }}</ElButton>
          <ElButton native-type="button" :disabled="disabled" @click="zoom(250)">{{ t('author.canvas.zoom_in') }}</ElButton>
          <ElButton native-type="button" :disabled="disabled" @click="saveViewport(defaultCanvasViewport)">{{ t('author.canvas.reset_view') }}</ElButton>
          <button type="button" class="canvas-mode" :aria-pressed="view === 'outline'" @click="view = view === 'canvas' ? 'outline' : 'canvas'">{{ t('author.canvas.outline') }}</button>
        </div>
        <div ref="graph" class="canvas-graph">
          <CanvasBoard v-if="view === 'canvas'" :nodes="nodes" :edges="edges" :viewport="document.viewport"
            :selected-node-id="nodeId" :selected-edge-id="edgeId" :focus-request-id="focusBoardNode" :disabled="disabled"
            @focus-request-handled="focusBoardNode = ''"
            @select-node="chooseNode" @select-edge="chooseEdge" @move-node="move" @viewport="saveViewport" />
          <section v-else class="canvas-outline" :aria-label="t('author.canvas.canvas_outline')" tabindex="-1">
            <label for="canvas-outline-search">{{ t('author.canvas.find_loaded_records') }}</label>
            <input id="canvas-outline-search" v-model="outlineSearch" type="search" />
            <h2>{{ t('author.canvas.nodes') }}</h2>
            <p v-if="!matchingNodes.length">{{ outlineQuery ? t('author.canvas.no_matching_loaded_nodes') : t('author.canvas.no_nodes_in_this_canvas') }}</p>
            <ul v-else>
              <li v-for="node in outlineNodes" :key="node.id">
                <button type="button" :aria-pressed="nodeId === node.id" @click="chooseNode(node.id)">{{ nodeLabel(node) }}</button>
              </li>
            </ul>
            <h2>{{ t('author.canvas.edges') }}</h2>
            <p v-if="!matchingEdges.length">{{ outlineQuery ? t('author.canvas.no_matching_loaded_edges') : t('author.canvas.no_loaded_edges') }}</p>
            <ul v-else>
              <li v-for="edge in outlineEdges" :key="edge.id">
                <button type="button" :aria-pressed="edgeId === edge.id" @click="chooseEdge(edge.id)">{{ edgeLabel(edge) }}</button>
              </li>
            </ul>
            <div class="canvas-toolbar" role="group" :aria-label="t('author.canvas.outline_pages')">
              <ElButton :disabled="outlinePage === 0" @click="outlinePage--">{{ t('author.canvas.previous_outline_page') }}</ElButton>
              <ElButton :disabled="!hasNextOutline" @click="outlinePage++">{{ t('author.canvas.next_outline_page') }}</ElButton>
            </div>
          </section>
          <aside class="canvas-selection" :aria-label="t('author.canvas.selected_canvas_record')">
            <template v-if="selectedNode">
              <h2>{{ nodeTypeLabels[selectedNode.kind] }}</h2>
              <p v-if="'text' in selectedNode">{{ selectedNode.text }}</p>
              <p v-else>{{ t('author.canvas.article_article', { article: selectedNode.articleId }) }}<template v-if="selectedNode.pinnedRevision">{{ t('author.canvas.revision_revision', { revision: String(selectedNode.pinnedRevision) }) }}</template></p>
              <p v-if="'anchor' in selectedNode">{{ t('author.canvas.anchor_anchor', { anchor: selectedNode.anchor }) }}</p>
              <p v-if="selectedNode.kind === 'group-frame'">{{ t(selectedNode.memberIds.length === 1 ? 'author.canvas.count_member' : 'author.canvas.count_members', { count: selectedNode.memberIds.length }) }}</p>
              <div v-if="selectedReference" class="canvas-reference-preview" role="region" :aria-label="t('author.canvas.canvas_reference_preview')">
                <ElButton native-type="button" :disabled="disabled || referenceLoading" @click="resolveReference">
                  {{ t('author.canvas.resolve_reference') }}
                </ElButton>
                <p v-if="referenceLoading" role="status">{{ t('author.canvas.resolving_reference') }}</p>
                <p v-if="referenceError" role="alert">{{ t('author.canvas.could_not_resolve_the_reference_try_again') }}</p>
                <template v-if="reference">
                  <p role="status">{{ referenceStatus[reference.state] }}</p>
                  <template v-if="reference.articleRevision !== null">
                    <h3 v-if="reference.title">{{ reference.title }}</h3>
                    <p>{{ reference.pinned ? t('author.canvas.pinned_revision') : t('author.canvas.resolved_revision') }} {{ reference.articleRevision }}</p>
                    <p v-if="reference.state === 'resolved' && reference.excerpt" class="canvas-reference-excerpt">{{ reference.excerpt }}</p>
                    <ElButton v-if="canOpenReference" native-type="button" :disabled="disabled || referenceLoading" @click="openReference">{{ t('author.canvas.open_in_editor') }}</ElButton>
                    <p v-if="referenceOpenNotice" role="status">{{ referenceOpenNotice }}</p>
                  </template>
                </template>
              </div>
              <div class="canvas-toolbar">
                <ElButton v-if="view === 'outline'" :disabled="disabled" @click="showNode">{{ t('author.canvas.show_on_canvas') }}</ElButton>
                <ElButton :disabled="disabled" @click="addNode(selectedNode.kind, true)">{{ t('author.canvas.edit_node') }}</ElButton>
                <ElButton :disabled="disabled" @click="patch([{ kind: 'remove-node', id: selectedNode.id }])">{{ t('author.canvas.remove_node') }}</ElButton>
              </div>
            </template>
            <template v-else-if="selectedEdge">
              <h2>{{ selectedEdge.kind === 'visual-only' ? t('author.canvas.visual_connection') : t('author.canvas.explicit_reference') }}</h2>
              <p>{{ edgeLabel(selectedEdge) }}</p>
              <div class="canvas-toolbar">
                <ElButton v-if="activeLink" :disabled="disabled" @click="prepareLink">
                  {{ selectedEdge.kind === 'visual-only' ? t('author.canvas.review_visual_connection') : t('author.canvas.review_article_link') }}
                </ElButton>
                <ElButton :disabled="disabled" @click="showEdgeForm(selectedEdge)">{{ t('author.canvas.edit_edge') }}</ElButton>
                <ElButton :disabled="disabled" @click="patch([{ kind: 'remove-edge', id: selectedEdge.id }])">{{ t('author.canvas.remove_edge') }}</ElButton>
              </div>
            </template>
            <template v-else>
              <h2>{{ t('author.canvas.selection') }}</h2>
              <p>{{ t('author.canvas.select_a_node_or_edge') }}</p>
            </template>
          </aside>
        </div>
        <footer class="canvas-toolbar canvas-footer">
          <span>{{ t('author.canvas.revision_revision_nodes_nodecount_nodes_edges_edgecount_edges', { revision: String(document.revision), nodes: nodes.length, nodeCount: document.nodeCount, edges: edges.length, edgeCount: document.edgeCount }) }}</span>
          <p v-if="loadingAll" role="status">{{ t('author.canvas.loading_progress_of_total_records', { progress: bulkProgress, total: document.nodeCount + document.edgeCount }) }}</p>
          <ElButton v-if="offset !== null" :disabled="disabled" @click="load(true)">{{ t('author.canvas.load_more_records') }}</ElButton>
          <ElButton v-if="offset !== null" :disabled="disabled" @click="loadAll()">{{ t('author.canvas.load_all_records') }}</ElButton>
          <ElButton type="danger" text :disabled="disabled" @click="deleteDocument">{{ t('author.canvas.delete_canvas') }}</ElButton>
        </footer>
      </section>
    </template>

    <ElDialog v-if="authorized" :model-value="!!form" :title="form === 'title' ? (document ? t('author.canvas.rename_canvas') : t('author.canvas.new_canvas')) :
      form === 'node' ? (editingNode ? t('author.canvas.edit_node') : t('author.canvas.add_node')) : (editingEdge ? t('author.canvas.edit_edge') : t('author.canvas.connect_nodes'))"
      append-to-body :close-on-click-modal="!working && !retry" :close-on-press-escape="!working && !retry"
      :show-close="!working && !retry" @close="() => { if (!working && !retry) form = undefined }">
      <form v-if="form === 'title'" class="canvas-form" @submit.prevent="saveTitle">
        <label for="canvas-name">{{ t('author.canvas.canvas_title') }}</label>
        <input id="canvas-name" v-model="title" maxlength="128" :disabled="working || !!retry" />
        <ElButton native-type="submit" type="primary" :disabled="working || !!retry || !title.trim()">{{ t('author.canvas.save_canvas') }}</ElButton>
      </form>
      <form v-else-if="form === 'node'" class="canvas-form" @submit.prevent="saveNode">
        <label v-if="nodeKind === 'article-reference' || nodeKind === 'heading-reference' || nodeKind === 'block-reference'" for="canvas-reference">{{ t('author.canvas.reference_type') }}</label>
        <select v-if="nodeKind === 'article-reference' || nodeKind === 'heading-reference' || nodeKind === 'block-reference'"
          id="canvas-reference" v-model="nodeKind" :disabled="!!editingNode || working || !!retry">
          <option value="article-reference">{{ t('page.article') }}</option><option value="heading-reference">{{ t('author.canvas.heading') }}</option><option value="block-reference">{{ t('author.canvas.block') }}</option>
        </select>
        <template v-if="nodeKind === 'plain-text-note' || nodeKind === 'group-frame'">
          <label for="canvas-node-text">{{ nodeKind === 'group-frame' ? t('author.canvas.frame_name') : t('author.canvas.note_text') }}</label>
          <textarea id="canvas-node-text" v-model="note" :maxlength="nodeKind === 'group-frame' ? 128 : 8192" rows="4" :disabled="working || !!retry" />
          <template v-if="nodeKind === 'group-frame'">
            <label for="canvas-filter-members">{{ t('author.canvas.filter_loaded_frame_members') }}</label>
            <input id="canvas-filter-members" v-model="choiceFilter" :disabled="working || !!retry" />
            <label for="canvas-members">{{ t('author.canvas.loaded_frame_members') }}</label>
            <select id="canvas-members" multiple :disabled="working || !!retry" @change="setMembers">
              <option v-for="node in memberChoices" :key="node.id" :value="node.id" :selected="members.includes(node.id)">{{ nodeLabel(node) }}</option>
            </select>
            <p>{{ t('author.canvas.count_selected', { count: members.length }) }}</p>
          </template>
        </template>
        <template v-else>
          <label for="canvas-article">{{ t('admin.moderation.m35') }}</label><input id="canvas-article" v-model="article" inputmode="numeric" :disabled="working || !!retry" />
          <template v-if="nodeKind !== 'article-reference'">
            <label for="canvas-anchor">{{ t('author.canvas.anchor_id') }}</label><input id="canvas-anchor" v-model="anchor" maxlength="64" :disabled="working || !!retry" />
          </template>
          <label for="canvas-pin">{{ t('author.canvas.pinned_revision_optional') }}</label><input id="canvas-pin" v-model="pinned" inputmode="numeric" :disabled="working || !!retry" />
        </template>
        <ElButton native-type="submit" type="primary" :disabled="working || !!retry">{{ t('author.canvas.save_node') }}</ElButton>
      </form>
      <form v-else-if="form === 'edge'" class="canvas-form" @submit.prevent="saveEdge">
        <label for="canvas-filter-endpoint">{{ t('author.canvas.filter_loaded_nodes') }}</label>
        <input id="canvas-filter-endpoint" v-model="choiceFilter" :disabled="working || !!retry" />
        <label for="canvas-endpoint">{{ t('author.canvas.target_node') }}</label>
        <select id="canvas-endpoint" v-model="endpoint" :disabled="working || !!retry">
          <option value="" disabled>{{ t('author.canvas.choose_a_loaded_node') }}</option>
          <option v-if="editingEdge && !byId.has(editingEdge.targetNodeId)" :value="editingEdge.targetNodeId">{{ t('author.canvas.current_target') }}</option>
          <option v-for="node in endpointChoices" :key="node.id" :value="node.id">{{ nodeLabel(node) }}</option>
        </select>
        <label for="canvas-edge-kind">{{ t('author.canvas.edge_type') }}</label>
        <select id="canvas-edge-kind" v-model="edgeKind" :disabled="working || !!retry">
          <option value="visual-only">{{ t('author.canvas.visual_connection') }}</option><option value="explicit-reference-note">{{ t('author.canvas.explicit_reference') }}</option>
        </select>
        <label for="canvas-edge-label">{{ t('author.canvas.edge_label_optional') }}</label>
        <input id="canvas-edge-label" v-model="label" maxlength="128" :disabled="working || !!retry" />
        <ElButton native-type="submit" type="primary" :disabled="working || !!retry || !endpoint">{{ t('author.canvas.save_edge') }}</ElButton>
      </form>
      <p v-if="form && error" role="alert">{{ error }}</p>
      <ElButton v-if="retry" :disabled="working" @click="send(retry)">{{ t('author.canvas.retry_change') }}</ElButton>
      <ElButton v-else-if="form" :disabled="working" @click="form = undefined">{{ t('nav.cancel') }}</ElButton>
    </ElDialog>

    <ElDialog v-if="authorized" :model-value="!!plan" :title="t('author.canvas.review_article_link')" append-to-body :show-close="!linkPending && !linkUnconfirmed"
      :close-on-press-escape="!linkPending && !linkUnconfirmed" :close-on-click-modal="!linkPending && !linkUnconfirmed" @close="cancelLink">
      <div v-if="plan">
        <p>{{ t('author.canvas.add_this_markdown_to_the_end_of_article_article_s_private_draft', { article: plan.hostArticleId }) }}</p>
        <p v-if="plan.edgeKind === 'visual-only'">{{ t('author.canvas.use_the_selected_visual_connection_as_an_article_link_the_connection_stays_in_the_canvas') }}</p>
        <pre class="canvas-link-preview">{{ plan.insertedMarkdown }}</pre>
        <p v-if="error" role="alert">{{ error }}</p>
        <div class="canvas-toolbar">
          <ElButton :disabled="linkPending || linkUnconfirmed" @click="cancelLink">{{ t('nav.cancel') }}</ElButton>
          <ElButton type="primary" :disabled="linkPending" @click="applyLink">{{ linkUnconfirmed ? t('author.canvas.retry_confirmation') : t('author.canvas.confirm_link') }}</ElButton>
        </div>
      </div>
    </ElDialog>
  </main>
</template>

<style scoped>
.canvas-workspace { width: min(78rem, 100% - 2rem); margin: 0 auto; padding: 1.5rem 0 3rem; }
.canvas-header, .canvas-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.canvas-header { justify-content: space-between; margin-bottom: 1rem; }
.canvas-header h1 { margin: .25rem 0 0; overflow-wrap: anywhere; }
.canvas-toolbar { margin: .5rem 0; }
.canvas-toolbar :deep(.el-button + .el-button) { margin-left: 0; }
.canvas-list { list-style: none; padding: 0; }
.canvas-list li { display: flex; gap: 1rem; justify-content: space-between; border-bottom: 1px solid var(--fsus-border); padding: .8rem 0; }
.canvas-mode, .canvas-outline button { background: var(--fsus-paper); color: inherit; border: 1px solid var(--fsus-border); border-radius: var(--fsus-radius-control); padding: .45rem .65rem; font: inherit; cursor: pointer; }
.canvas-mode[aria-pressed="true"], .canvas-outline button[aria-pressed="true"] { color: var(--fsus-color-action-primary); border-color: currentColor; }
@media (forced-colors: active) { .canvas-mode[aria-pressed="true"], .canvas-outline button[aria-pressed="true"] { outline: 2px solid Highlight; } }
.canvas-graph { display: grid; grid-template-columns: minmax(0, 1fr) 16rem; gap: 1rem; }
.canvas-selection, .canvas-outline { border: 1px solid var(--fsus-border); border-radius: var(--fsus-radius-panel); padding: .8rem; min-width: 0; overflow-wrap: anywhere; }
.canvas-selection p { white-space: pre-wrap; }
.canvas-reference-preview h3 { margin: .6rem 0 .35rem; }
.canvas-reference-excerpt { border-inline-start: 2px solid var(--fsus-border); padding-inline-start: .6rem; }
.canvas-selection h2, .canvas-outline h2 { margin: 0 0 .5rem; font-size: 1.1rem; }
.canvas-outline input { display: block; max-width: 100%; margin-block: .25rem .9rem; }
.canvas-outline ul { list-style: none; margin: 0 0 1rem; padding: 0; display: grid; gap: .4rem; }
.canvas-form { display: grid; gap: .6rem; }
.canvas-form input, .canvas-form select, .canvas-form textarea { font: inherit; color: inherit; background: var(--fsus-paper); border: 1px solid var(--fsus-border); border-radius: var(--fsus-radius-control); padding: .5rem; min-width: 0; }
.canvas-form :deep(.el-button) { justify-self: start; }
.canvas-link-preview { white-space: pre-wrap; overflow-wrap: anywhere; padding: .8rem; border: 1px solid var(--fsus-border); }
.canvas-footer { margin-top: .8rem; justify-content: space-between; }
@media (max-width: 700px) { .canvas-graph { grid-template-columns: minmax(0, 1fr); gap: .7rem; } }
</style>
