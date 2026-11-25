<script setup lang="ts">
import { t } from '../siteLocale'
import { computed, nextTick, onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, RouterLink, useRoute, useRouter } from 'vue-router'
import { ElAlert, ElButton, ElDialog, ElMessageBox } from '@ozwasyd/element-plus'
import { api } from '../../../Contracts/client'
import { canvasGraph, defaultCanvasViewport, type CanvasGraphEdge, type CanvasNode } from '../../../Contracts/canvas-graph'
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

const route = useRoute(), router = useRouter()
const articlePath = '/admin/articles/workspace'
const documentId = computed(() => typeof route.params.id === 'string' ? route.params.id.toLowerCase() : '')
const preloadedAuth = consumeAuthoringSessionPreload(), initialCanvasDocuments = readInitialCanvasDocuments()
const ready = ref(preloadedAuth), tools = ref<HTMLElement>(), graph = ref<HTMLElement>()
const ownerLife = new AbortController()

function currentIdentity(): CanvasIdentity | null {
  const session = currentSession.value
  return session ? { name: session.name, generation: session.generation, canAuthor: session.canAuthor, expiresAt: session.expiresAt, siteSessionId: session.siteSessionId, credentialEpoch: credentialEpoch.value } : null
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
    openEditor: async (articleId, token) => !(await router.push({ name: 'edit', params: { id: articleId }, state: { [canvasEditorHandoffKey]: token } })),
  },
  handoff: { offer: offerCanvasEditorHandoff, cancel: cancelCanvasEditorHandoff },
  onInvalidateSession: () => invalidateSession(),
  nativeMarkdownAvailable: Boolean(import.meta.env.FSUS_MARKDOWN_NATIVE),
})

const state = shallowRef(controller.state)
const unsubscribe = controller.subscribe(() => { state.value = controller.state })

watch([documentId, identityEpoch, currentSession, ready], () => {
  controller.syncContext({ documentId: documentId.value, identity: currentIdentity(), identityEpoch: identityEpoch.value, ready: ready.value, initialDocuments: initialCanvasDocuments })
}, { immediate: true, flush: 'sync' })

const formatNotice = (notice: CanvasNotice | undefined) => notice ? (notice.kind === 'text' ? notice.text : t(notice.key)) : ''
const message = computed(() => formatNotice(state.value.message))
const error = computed(() => formatNotice(state.value.error))
const referenceOpenNotice = computed(() => formatNotice(state.value.referenceOpenNotice))
const outlineSearch = computed({ get: () => state.value.outlineSearch, set: value => controller.setOutlineSearch(value) })
const field = <K extends keyof CanvasFormFields>(key: K) => computed({
  get: () => state.value[key],
  set: (value: CanvasFormFields[K]) => controller.updateForm({ [key]: value } as Partial<CanvasFormFields>),
})
const title = field('title'), nodeKind = field('nodeKind'), note = field('note'), article = field('article'), anchor = field('anchor')
const pinned = field('pinned'), endpoint = field('endpoint'), choiceFilter = field('choiceFilter'), edgeKind = field('edgeKind'), label = field('label')

const nodeTypeLabels = computed(() => ({
  'plain-text-note': t('author.canvas.note'), 'article-reference': t('page.article'),
  'heading-reference': t('author.canvas.heading'), 'block-reference': t('author.canvas.block'), 'group-frame': t('author.canvas.frame'),
}))
const nodeLabel = (node: CanvasNode) =>
  'text' in node ? node.text.slice(0, 70) : t('author.canvas.kind_reference_article', { kind: nodeTypeLabels.value[node.kind], article: node.articleId })
function edgeLabel(edge: CanvasGraphEdge) {
  const from = state.value.byId.get(edge.sourceNodeId), to = state.value.byId.get(edge.targetNodeId)
  return edge.label || `${from ? nodeLabel(from) : t('author.canvas.unloaded_node')} → ${to ? nodeLabel(to) : t('author.canvas.unloaded_node')}`
}

const outlineQuery = computed(() => state.value.outlineSearch.trim().toLowerCase())
const matchingNodes = computed(() => filterOutlineNodes(state.value.nodes, state.value.outlineSearch, nodeLabel))
const matchingEdges = computed(() => filterOutlineEdges(state.value.edges, state.value.outlineSearch, edgeLabel))
const outlineNodes = computed(() => sliceOutlineRecords(matchingNodes.value, state.value.outlinePage))
const outlineEdges = computed(() => sliceOutlineRecords(matchingEdges.value, state.value.outlinePage))
const hasNextOutline = computed(() => hasNextOutlinePage(matchingNodes.value.length, matchingEdges.value.length, state.value.outlinePage))
const memberChoices = computed(() => filterMemberChoices(state.value.nodes, choiceFilter.value, nodeLabel))
const endpointChoices = computed(() => filterEndpointChoices(state.value.nodes, state.value.byId, endpoint.value, choiceFilter.value, nodeLabel))

const referenceStatus = computed(() => ({
  unavailable: t('author.canvas.this_reference_is_unavailable'), resolved: t('author.canvas.reference_resolved'),
  'missing-anchor': t('author.canvas.the_anchor_does_not_exist_at_this_revision'),
  'duplicate-anchor': t('author.canvas.the_anchor_is_ambiguous_at_this_revision'),
  'stale-revision': t('author.canvas.the_referenced_revision_is_unavailable'),
}))

const protectUnload = (event: BeforeUnloadEvent) => { if (controller.shouldProtectUnload) event.preventDefault() }
onMounted(() => {
  window.addEventListener('beforeunload', protectUnload)
  if (!preloadedAuth) void refreshSession(ownerLife.signal)
    .finally(() => { if (!ownerLife.signal.aborted) ready.value = true })
    .catch(() => { controller.setSessionVerificationError() })
})
onScopeDispose(() => { unsubscribe(); ownerLife.abort(); controller.dispose(); window.removeEventListener('beforeunload', protectUnload) })
const canNavigate = () => controller.canNavigate
onBeforeRouteUpdate(canNavigate)
onBeforeRouteLeave(canNavigate)

const openImported = (id: string) => { void router.push({ name: 'canvas-document', params: { id } }) }
function setMembers(event: Event) {
  if (event.target instanceof HTMLSelectElement)
    controller.setFrameMembers(memberChoices.value, Array.from(event.target.selectedOptions, option => option.value))
}

async function deleteDocument() {
  const selected = state.value.document, token = controller.contextToken
  if (!selected || state.value.disabled) return
  try { await ElMessageBox.confirm(t('author.canvas.delete_this_canvas_and_its_nodes_and_edges'), t('author.canvas.delete_canvas'), { confirmButtonText: t('account.message94') }) }
  catch { return }
  if (ownerLife.signal.aborted || controller.contextToken !== token) return
  await controller.deleteDocument(selected)
}

async function travel(action: 'undo' | 'redo') {
  const current = state.value.document
  if (!current || !state.value.historyActionAvailable[action]) return
  const token = controller.contextToken
  const trigger = tools.value?.querySelector<HTMLButtonElement>(`button.canvas-${action}`)
  const hadFocus = trigger === window.document.activeElement
  await controller.travel(action)
  await nextTick()
  if (!hadFocus || ownerLife.signal.aborted || controller.contextToken !== token || !controller.isAuthorized() || state.value.document?.id !== current.id) return
  const active = window.document.activeElement
  if (active !== trigger && active !== window.document.body) return
  if (trigger && !trigger.disabled) trigger.focus()
  else graph.value?.querySelector<HTMLElement>('.canvas-board, .canvas-outline')?.focus({ preventScroll: true })
}

function historyShortcut(event: KeyboardEvent) {
  const action = resolveHistoryShortcutAction(event)
  if (!action || !state.value.historyActionAvailable[action] || !(event.target instanceof HTMLElement) ||
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
        <h1 id="canvas-title">{{ state.document?.title ?? (documentId ? t('page.canvas-document') : t('author.canvas.canvases')) }}</h1>
      </div>
      <div v-if="state.authorized && ready" class="canvas-toolbar">
        <template v-if="!documentId">
          <ElButton type="primary" :disabled="state.disabled" @click="controller.openTitleForm()">{{ t('author.canvas.new_canvas') }}</ElButton>
          <CanvasBundlePanel :key="identityEpoch" :disabled="state.disabled" @imported="openImported" @pending="controller.setBundlePending($event)" @expired="invalidateSession()" />
        </template>
        <template v-else-if="state.document">
          <ElButton :disabled="state.disabled" @click="controller.openTitleForm()">{{ t('author.canvas.rename_canvas') }}</ElButton>
          <a v-if="!state.disabled" :href="canvasBundle.downloadHref(state.document.id, state.document.revision)" download="canvas.fsuscanvas"
            class="canvas-bundle-export" :title="t('author.canvas.download_revision_revision_notes_are_unencrypted', { revision: String(state.document.revision) })">{{ t('author.canvas.export_canvas_bundle') }}</a>
        </template>
      </div>
    </header>

    <p v-if="!ready" role="status">{{ t('author.canvas.verifying_author_session') }}</p>
    <RouterLink v-else-if="!state.authorized" :to="{ name: 'login', query: { redirect: route.fullPath } }">{{ t('author.canvas.log_in_to_access_canvas') }}</RouterLink>
    <template v-else>
      <ElAlert v-if="error" type="error" :title="error" :closable="false" />
      <p v-if="message" role="status">{{ message }}</p>
      <p v-if="state.loading && !state.document" role="status">{{ t('author.canvas.loading_canvas') }}</p>
      <div v-if="state.stale || state.retry || state.graphReadFailure" class="canvas-toolbar">
        <ElButton v-if="state.stale || state.graphReadFailure" :disabled="state.loading" @click="controller.load()">{{ t('author.canvas.reload_canvas') }}</ElButton>
        <ElButton v-if="state.retry" :disabled="state.working" @click="controller.send(state.retry)">{{ t('author.canvas.retry_change') }}</ElButton>
      </div>
      <section v-if="!documentId && !state.loading" :aria-label="t('author.canvas.canvas_documents')">
        <p v-if="!state.documents.length">{{ t('author.canvas.no_canvases_yet') }}</p>
        <ul v-else class="canvas-list">
          <li v-for="item in state.documents" :key="item.id">
            <RouterLink :to="{ name: 'canvas-document', params: { id: item.id } }">{{ item.title }}</RouterLink>
            <span>{{ t('author.canvas.nodes_nodes_edges_edges', { nodes: item.nodeCount, edges: item.edgeCount }) }}</span>
          </li>
        </ul>
      </section>

      <section v-if="state.document" :aria-label="t('author.canvas.canvas_document')">
        <div ref="tools" class="canvas-toolbar" role="group" :aria-label="t('author.canvas.canvas_tools')">
          <ElButton class="canvas-undo" native-type="button" :disabled="!state.historyActionAvailable.undo" @click="travel('undo')">{{ t('author.canvas.undo') }}</ElButton>
          <ElButton class="canvas-redo" native-type="button" :disabled="!state.historyActionAvailable.redo" @click="travel('redo')">{{ t('author.canvas.redo') }}</ElButton>
          <ElButton v-if="state.historyFailure" native-type="button" :disabled="state.disabled || state.historyLoading" @click="controller.loadHistory()">{{ t('author.canvas.retry_canvas_history') }}</ElButton>
          <ElButton native-type="button" :disabled="state.disabled" @click="controller.openNodeForm('plain-text-note')">{{ t('author.canvas.add_note') }}</ElButton>
          <ElButton native-type="button" :disabled="state.disabled" @click="controller.openNodeForm('article-reference')">{{ t('author.canvas.add_reference') }}</ElButton>
          <ElButton native-type="button" :disabled="state.disabled" @click="controller.openNodeForm('group-frame')">{{ t('author.canvas.add_frame') }}</ElButton>
          <ElButton native-type="button" :disabled="state.disabled || !state.selectedNode" @click="controller.openEdgeForm()">{{ t('author.canvas.connect') }}</ElButton>
          <ElButton native-type="button" :disabled="state.disabled" @click="controller.zoom(-250)">{{ t('author.canvas.zoom_out') }}</ElButton>
          <ElButton native-type="button" :disabled="state.disabled" @click="controller.zoom(250)">{{ t('author.canvas.zoom_in') }}</ElButton>
          <ElButton native-type="button" :disabled="state.disabled" @click="controller.saveViewport(defaultCanvasViewport)">{{ t('author.canvas.reset_view') }}</ElButton>
          <button type="button" class="canvas-mode" :aria-pressed="state.view === 'outline'" @click="controller.setView(state.view === 'canvas' ? 'outline' : 'canvas')">{{ t('author.canvas.outline') }}</button>
        </div>
        <div ref="graph" class="canvas-graph">
          <CanvasBoard v-if="state.view === 'canvas'" :nodes="state.nodes" :edges="state.edges" :viewport="state.document.viewport"
            :selected-node-id="state.nodeId" :selected-edge-id="state.edgeId" :focus-request-id="state.focusBoardNode" :disabled="state.disabled"
            @focus-request-handled="controller.clearFocusRequest()"
            @select-node="controller.chooseNode($event)" @select-edge="controller.chooseEdge($event)"
            @move-node="(id, geometry) => controller.moveNode(id, geometry)" @viewport="controller.saveViewport($event)" />
          <section v-else class="canvas-outline" :aria-label="t('author.canvas.canvas_outline')" tabindex="-1">
            <label for="canvas-outline-search">{{ t('author.canvas.find_loaded_records') }}</label>
            <input id="canvas-outline-search" v-model="outlineSearch" type="search" />
            <h2>{{ t('author.canvas.nodes') }}</h2>
            <p v-if="!matchingNodes.length">{{ outlineQuery ? t('author.canvas.no_matching_loaded_nodes') : t('author.canvas.no_nodes_in_this_canvas') }}</p>
            <ul v-else>
              <li v-for="node in outlineNodes" :key="node.id">
                <button type="button" :aria-pressed="state.nodeId === node.id" @click="controller.chooseNode(node.id)">{{ nodeLabel(node) }}</button>
              </li>
            </ul>
            <h2>{{ t('author.canvas.edges') }}</h2>
            <p v-if="!matchingEdges.length">{{ outlineQuery ? t('author.canvas.no_matching_loaded_edges') : t('author.canvas.no_loaded_edges') }}</p>
            <ul v-else>
              <li v-for="edge in outlineEdges" :key="edge.id">
                <button type="button" :aria-pressed="state.edgeId === edge.id" @click="controller.chooseEdge(edge.id)">{{ edgeLabel(edge) }}</button>
              </li>
            </ul>
            <div class="canvas-toolbar" role="group" :aria-label="t('author.canvas.outline_pages')">
              <ElButton :disabled="state.outlinePage === 0" @click="controller.previousOutlinePage()">{{ t('author.canvas.previous_outline_page') }}</ElButton>
              <ElButton :disabled="!hasNextOutline" @click="controller.nextOutlinePage()">{{ t('author.canvas.next_outline_page') }}</ElButton>
            </div>
          </section>
          <aside class="canvas-selection" :aria-label="t('author.canvas.selected_canvas_record')">
            <template v-if="state.selectedNode">
              <h2>{{ nodeTypeLabels[state.selectedNode.kind] }}</h2>
              <p v-if="'text' in state.selectedNode">{{ state.selectedNode.text }}</p>
              <p v-else>{{ t('author.canvas.article_article', { article: state.selectedNode.articleId }) }}<template v-if="state.selectedNode.pinnedRevision">{{ t('author.canvas.revision_revision', { revision: String(state.selectedNode.pinnedRevision) }) }}</template></p>
              <p v-if="'anchor' in state.selectedNode">{{ t('author.canvas.anchor_anchor', { anchor: state.selectedNode.anchor }) }}</p>
              <p v-if="state.selectedNode.kind === 'group-frame'">{{ t(state.selectedNode.memberIds.length === 1 ? 'author.canvas.count_member' : 'author.canvas.count_members', { count: state.selectedNode.memberIds.length }) }}</p>
              <div v-if="state.selectedReference" class="canvas-reference-preview" role="region" :aria-label="t('author.canvas.canvas_reference_preview')">
                <ElButton native-type="button" :disabled="state.disabled || state.referenceLoading" @click="controller.resolveReference()">{{ t('author.canvas.resolve_reference') }}</ElButton>
                <p v-if="state.referenceLoading" role="status">{{ t('author.canvas.resolving_reference') }}</p>
                <p v-if="state.referenceError" role="alert">{{ t('author.canvas.could_not_resolve_the_reference_try_again') }}</p>
                <template v-if="state.reference">
                  <p role="status">{{ referenceStatus[state.reference.state] }}</p>
                  <template v-if="state.reference.articleRevision !== null">
                    <h3 v-if="state.reference.title">{{ state.reference.title }}</h3>
                    <p>{{ state.reference.pinned ? t('author.canvas.pinned_revision') : t('author.canvas.resolved_revision') }} {{ state.reference.articleRevision }}</p>
                    <p v-if="state.reference.state === 'resolved' && state.reference.excerpt" class="canvas-reference-excerpt">{{ state.reference.excerpt }}</p>
                    <ElButton v-if="state.canOpenReference" native-type="button" :disabled="state.disabled || state.referenceLoading" @click="controller.openReference()">{{ t('author.canvas.open_in_editor') }}</ElButton>
                    <p v-if="referenceOpenNotice" role="status">{{ referenceOpenNotice }}</p>
                  </template>
                </template>
              </div>
              <div class="canvas-toolbar">
                <ElButton v-if="state.view === 'outline'" :disabled="state.disabled" @click="controller.showNode()">{{ t('author.canvas.show_on_canvas') }}</ElButton>
                <ElButton :disabled="state.disabled" @click="controller.openNodeForm(state.selectedNode.kind, true)">{{ t('author.canvas.edit_node') }}</ElButton>
                <ElButton :disabled="state.disabled" @click="controller.patch([{ kind: 'remove-node', id: state.selectedNode.id }])">{{ t('author.canvas.remove_node') }}</ElButton>
              </div>
            </template>
            <template v-else-if="state.selectedEdge">
              <h2>{{ state.selectedEdge.kind === 'visual-only' ? t('author.canvas.visual_connection') : t('author.canvas.explicit_reference') }}</h2>
              <p>{{ edgeLabel(state.selectedEdge) }}</p>
              <div class="canvas-toolbar">
                <ElButton v-if="state.activeLink" :disabled="state.disabled" @click="controller.prepareLink()">
                  {{ state.selectedEdge.kind === 'visual-only' ? t('author.canvas.review_visual_connection') : t('author.canvas.review_article_link') }}
                </ElButton>
                <ElButton :disabled="state.disabled" @click="controller.openEdgeForm(state.selectedEdge)">{{ t('author.canvas.edit_edge') }}</ElButton>
                <ElButton :disabled="state.disabled" @click="controller.patch([{ kind: 'remove-edge', id: state.selectedEdge.id }])">{{ t('author.canvas.remove_edge') }}</ElButton>
              </div>
            </template>
            <template v-else>
              <h2>{{ t('author.canvas.selection') }}</h2>
              <p>{{ t('author.canvas.select_a_node_or_edge') }}</p>
            </template>
          </aside>
        </div>
        <footer class="canvas-toolbar canvas-footer">
          <span>{{ t('author.canvas.revision_revision_nodes_nodecount_nodes_edges_edgecount_edges', { revision: String(state.document.revision), nodes: state.nodes.length, nodeCount: state.document.nodeCount, edges: state.edges.length, edgeCount: state.document.edgeCount }) }}</span>
          <p v-if="state.loadingAll" role="status">{{ t('author.canvas.loading_progress_of_total_records', { progress: state.bulkProgress, total: state.document.nodeCount + state.document.edgeCount }) }}</p>
          <ElButton v-if="state.offset !== null" :disabled="state.disabled" @click="controller.load(true)">{{ t('author.canvas.load_more_records') }}</ElButton>
          <ElButton v-if="state.offset !== null" :disabled="state.disabled" @click="controller.loadAll()">{{ t('author.canvas.load_all_records') }}</ElButton>
          <ElButton type="danger" text :disabled="state.disabled" @click="deleteDocument">{{ t('author.canvas.delete_canvas') }}</ElButton>
        </footer>
      </section>
    </template>

    <ElDialog v-if="state.authorized" :model-value="!!state.form" :title="state.form === 'title' ? (state.document ? t('author.canvas.rename_canvas') : t('author.canvas.new_canvas')) :
      state.form === 'node' ? (state.editingNode ? t('author.canvas.edit_node') : t('author.canvas.add_node')) : (state.editingEdge ? t('author.canvas.edit_edge') : t('author.canvas.connect_nodes'))"
      append-to-body :close-on-click-modal="!state.working && !state.retry" :close-on-press-escape="!state.working && !state.retry"
      :show-close="!state.working && !state.retry" @close="() => { if (!state.working && !state.retry) controller.closeForm() }">
      <form v-if="state.form === 'title'" class="canvas-form" @submit.prevent="controller.saveTitle()">
        <label for="canvas-name">{{ t('author.canvas.canvas_title') }}</label>
        <input id="canvas-name" v-model="title" maxlength="128" :disabled="state.working || !!state.retry" />
        <ElButton native-type="submit" type="primary" :disabled="state.working || !!state.retry || !title.trim()">{{ t('author.canvas.save_canvas') }}</ElButton>
      </form>
      <form v-else-if="state.form === 'node'" class="canvas-form" @submit.prevent="controller.saveNode()">
        <label v-if="nodeKind === 'article-reference' || nodeKind === 'heading-reference' || nodeKind === 'block-reference'" for="canvas-reference">{{ t('author.canvas.reference_type') }}</label>
        <select v-if="nodeKind === 'article-reference' || nodeKind === 'heading-reference' || nodeKind === 'block-reference'"
          id="canvas-reference" v-model="nodeKind" :disabled="!!state.editingNode || state.working || !!state.retry">
          <option value="article-reference">{{ t('page.article') }}</option><option value="heading-reference">{{ t('author.canvas.heading') }}</option><option value="block-reference">{{ t('author.canvas.block') }}</option>
        </select>
        <template v-if="nodeKind === 'plain-text-note' || nodeKind === 'group-frame'">
          <label for="canvas-node-text">{{ nodeKind === 'group-frame' ? t('author.canvas.frame_name') : t('author.canvas.note_text') }}</label>
          <textarea id="canvas-node-text" v-model="note" :maxlength="nodeKind === 'group-frame' ? 128 : 8192" rows="4" :disabled="state.working || !!state.retry" />
          <template v-if="nodeKind === 'group-frame'">
            <label for="canvas-filter-members">{{ t('author.canvas.filter_loaded_frame_members') }}</label>
            <input id="canvas-filter-members" v-model="choiceFilter" :disabled="state.working || !!state.retry" />
            <label for="canvas-members">{{ t('author.canvas.loaded_frame_members') }}</label>
            <select id="canvas-members" multiple :disabled="state.working || !!state.retry" @change="setMembers">
              <option v-for="node in memberChoices" :key="node.id" :value="node.id" :selected="state.members.includes(node.id)">{{ nodeLabel(node) }}</option>
            </select>
            <p>{{ t('author.canvas.count_selected', { count: state.members.length }) }}</p>
          </template>
        </template>
        <template v-else>
          <label for="canvas-article">{{ t('admin.moderation.m35') }}</label><input id="canvas-article" v-model="article" inputmode="numeric" :disabled="state.working || !!state.retry" />
          <template v-if="nodeKind !== 'article-reference'">
            <label for="canvas-anchor">{{ t('author.canvas.anchor_id') }}</label><input id="canvas-anchor" v-model="anchor" maxlength="64" :disabled="state.working || !!state.retry" />
          </template>
          <label for="canvas-pin">{{ t('author.canvas.pinned_revision_optional') }}</label><input id="canvas-pin" v-model="pinned" inputmode="numeric" :disabled="state.working || !!state.retry" />
        </template>
        <ElButton native-type="submit" type="primary" :disabled="state.working || !!state.retry">{{ t('author.canvas.save_node') }}</ElButton>
      </form>
      <form v-else-if="state.form === 'edge'" class="canvas-form" @submit.prevent="controller.saveEdge()">
        <label for="canvas-filter-endpoint">{{ t('author.canvas.filter_loaded_nodes') }}</label>
        <input id="canvas-filter-endpoint" v-model="choiceFilter" :disabled="state.working || !!state.retry" />
        <label for="canvas-endpoint">{{ t('author.canvas.target_node') }}</label>
        <select id="canvas-endpoint" v-model="endpoint" :disabled="state.working || !!state.retry">
          <option value="" disabled>{{ t('author.canvas.choose_a_loaded_node') }}</option>
          <option v-if="state.editingEdge && !state.byId.has(state.editingEdge.targetNodeId)" :value="state.editingEdge.targetNodeId">{{ t('author.canvas.current_target') }}</option>
          <option v-for="node in endpointChoices" :key="node.id" :value="node.id">{{ nodeLabel(node) }}</option>
        </select>
        <label for="canvas-edge-kind">{{ t('author.canvas.edge_type') }}</label>
        <select id="canvas-edge-kind" v-model="edgeKind" :disabled="state.working || !!state.retry">
          <option value="visual-only">{{ t('author.canvas.visual_connection') }}</option><option value="explicit-reference-note">{{ t('author.canvas.explicit_reference') }}</option>
        </select>
        <label for="canvas-edge-label">{{ t('author.canvas.edge_label_optional') }}</label>
        <input id="canvas-edge-label" v-model="label" maxlength="128" :disabled="state.working || !!state.retry" />
        <ElButton native-type="submit" type="primary" :disabled="state.working || !!state.retry || !endpoint">{{ t('author.canvas.save_edge') }}</ElButton>
      </form>
      <p v-if="state.form && error" role="alert">{{ error }}</p>
      <ElButton v-if="state.retry" :disabled="state.working" @click="controller.send(state.retry)">{{ t('author.canvas.retry_change') }}</ElButton>
      <ElButton v-else-if="state.form" :disabled="state.working" @click="controller.closeForm()">{{ t('nav.cancel') }}</ElButton>
    </ElDialog>

    <ElDialog v-if="state.authorized" :model-value="!!state.plan" :title="t('author.canvas.review_article_link')" append-to-body :show-close="!state.linkPending && !state.linkUnconfirmed"
      :close-on-press-escape="!state.linkPending && !state.linkUnconfirmed" :close-on-click-modal="!state.linkPending && !state.linkUnconfirmed" @close="controller.cancelLink()">
      <div v-if="state.plan">
        <p>{{ t('author.canvas.add_this_markdown_to_the_end_of_article_article_s_private_draft', { article: state.plan.hostArticleId }) }}</p>
        <p v-if="state.plan.edgeKind === 'visual-only'">{{ t('author.canvas.use_the_selected_visual_connection_as_an_article_link_the_connection_stays_in_the_canvas') }}</p>
        <pre class="canvas-link-preview">{{ state.plan.insertedMarkdown }}</pre>
        <p v-if="error" role="alert">{{ error }}</p>
        <div class="canvas-toolbar">
          <ElButton :disabled="state.linkPending || state.linkUnconfirmed" @click="controller.cancelLink()">{{ t('nav.cancel') }}</ElButton>
          <ElButton type="primary" :disabled="state.linkPending" @click="controller.applyLink()">{{ state.linkUnconfirmed ? t('author.canvas.retry_confirmation') : t('author.canvas.confirm_link') }}</ElButton>
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
