<script setup lang="ts">
import { t } from '../siteLocale'
import { computed, nextTick, onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, RouterLink, useRoute, useRouter } from 'vue-router'
import { ElAlert, ElButton, ElDialog, ElMessageBox } from '@ozwasyd/element-plus'
import { api, ApiError } from '../../../Contracts/client'
import {
  canvasGraph, defaultCanvasViewport, encodeCanvasGraphCommand,
  type CanvasGeometry, type CanvasGraphChange, type CanvasGraphCommand,
  type CanvasGraphEdge, type CanvasGraphHeader, type CanvasGraphHistory, type CanvasNode,
  type CanvasReferenceResolution, type CanvasViewport,
} from '../../../Contracts/canvas-graph'
import { confirmCanvasLink, previewCanvasLink } from '../../../Contracts/canvas-links'
import type { CanvasLinkPlan } from '../../../Contracts/wire.generated'
import CanvasBoard from '../authoring/CanvasBoard.vue'
import CanvasBundlePanel from '../authoring/CanvasBundlePanel.vue'
import { canvasEditorHandoffKey, cancelCanvasEditorHandoff, offerCanvasEditorHandoff } from '../authoring/canvasEditorHandoff'
import { canvasBundle } from '../../../Contracts/canvas-bundle'
import { credentialEpoch, currentSession, identityEpoch, invalidateSession, refreshSession } from '../session'

const route = useRoute()
const router = useRouter()
const articlePath = '/user/manage/article/workspace'
const documentId = computed(() => typeof route.params.id === 'string' ? route.params.id.toLowerCase() : '')
const authorized = computed(() => currentSession.value?.canAuthor === true && currentSession.value.expiresAt > Date.now())
const ready = ref(false)
const loading = ref(false)
const working = ref(false)
const bundlePending = ref(false)
const stale = ref(false)
const message = ref('')
const error = ref('')
const title = ref('')
const document = shallowRef<CanvasGraphHeader>()
const documents = shallowRef<readonly CanvasGraphHeader[]>([])
const nodes = shallowRef<readonly CanvasNode[]>([])
const edges = shallowRef<readonly CanvasGraphEdge[]>([])
const offset = ref<number | null>(null)
const view = ref<'canvas' | 'outline'>('canvas')
const outlinePage = ref(0)
const outlineSearch = ref('')
const focusBoardNode = ref('')
const loadingAll = ref(false)
const completeGraph = ref(false)
const bulkProgress = ref(0)
const nodeId = ref('')
const edgeId = ref('')
const retry = shallowRef<CanvasGraphCommand>()
const plan = shallowRef<CanvasLinkPlan & { edgeKind: CanvasGraphEdge['kind'] }>()
const linkPending = ref(false)
const linkUnconfirmed = ref(false)
const graphReadFailure = ref(false)
const history = shallowRef<CanvasGraphHistory>()
const historyFailure = ref(false)
const historyLoading = ref(false)
const tools = ref<HTMLElement>()
const graph = ref<HTMLElement>()
let historyRequest: AbortController | undefined
const reference = shallowRef<CanvasReferenceResolution>()
const referenceLoading = ref(false)
const referenceError = ref(false)
const referenceOpenNotice = ref('')
let referenceRequest: AbortController | undefined
const form = ref<'title' | 'node' | 'edge'>()
const nodeKind = ref<CanvasNode['kind']>('plain-text-note')
const note = ref('')
const article = ref('')
const anchor = ref('')
const pinned = ref('')
const members = ref<string[]>([])
const endpoint = ref('')
const editingEdge = shallowRef<CanvasGraphEdge>()
const choiceFilter = ref('')
const edgeKind = ref<CanvasGraphEdge['kind']>('visual-only')
const label = ref('')
const selectedNode = computed(() => nodes.value.find(node => node.id === nodeId.value))
const selectedEdge = computed(() => edges.value.find(edge => edge.id === edgeId.value))
const selectedReference = computed(() => {
  const node = selectedNode.value
  return node && 'articleId' in node ? node : undefined
})
const canOpenReference = computed(() => reference.value?.state === 'resolved' &&
  !!currentSession.value?.siteSessionId && (reference.value.sourceOffset === null || import.meta.env.FSUS_MARKDOWN_NATIVE))
const byId = computed(() => new Map(nodes.value.map(node => [node.id, node])))
const involved = computed(() => selectedEdge.value && {
  from: byId.value.get(selectedEdge.value.sourceNodeId), to: byId.value.get(selectedEdge.value.targetNodeId),
})
const activeLink = computed(() => {
  const pair = involved.value
  if (!pair || pair.from?.kind !== 'article-reference' || pair.to?.kind !== 'article-reference' ||
    pair.from.pinnedRevision || pair.to.pinnedRevision || pair.from.articleId === pair.to.articleId) return undefined
  return { from: pair.from, to: pair.to }
})
const disabled = computed(() => loading.value || loadingAll.value || working.value || linkPending.value || !!plan.value || !!retry.value || stale.value || graphReadFailure.value || bundlePending.value)
const historyActionAvailable = computed(() => {
  const current = document.value
  const position = history.value
  const ready = !disabled.value && !form.value && current && position?.revision === current.revision
  return {
    undo: Boolean(ready && position.undoRevision !== null),
    redo: Boolean(ready && position.redoRevision !== null),
  }
})
const extent = computed(() => outlinePage.value * 50)
const outlineQuery = computed(() => outlineSearch.value.trim().toLowerCase())
const matchingNodes = computed(() => outlineQuery.value ? nodes.value.filter(node =>
  nodeLabel(node).toLowerCase().includes(outlineQuery.value) ||
  ('anchor' in node && node.anchor.includes(outlineQuery.value))) : nodes.value)
const matchingEdges = computed(() => outlineQuery.value ? edges.value.filter(edge =>
  edgeLabel(edge).toLowerCase().includes(outlineQuery.value)) : edges.value)
const outlineNodes = computed(() => matchingNodes.value.slice(extent.value, extent.value + 50))
const outlineEdges = computed(() => matchingEdges.value.slice(extent.value, extent.value + 50))
const hasNextOutline = computed(() => extent.value + 50 < Math.max(matchingNodes.value.length, matchingEdges.value.length))
watch(outlineSearch, () => { outlinePage.value = 0 })
watch([view, nodeId], () => { focusBoardNode.value = '' }, { flush: 'sync' })
const matchesChoice = (node: CanvasNode) => nodeLabel(node).toLowerCase().includes(choiceFilter.value.trim().toLowerCase())
const memberChoices = computed(() => nodes.value.filter(node => node.kind !== 'group-frame' && matchesChoice(node)).slice(0, 256))
const endpointChoices = computed(() => {
  const selected = byId.value.get(endpoint.value)
  return [...(selected ? [selected] : []),
    ...nodes.value.filter(node => node.id !== endpoint.value && matchesChoice(node)).slice(0, selected ? 255 : 256)]
})
const ownerLife = new AbortController()
let scope = new AbortController()

function scoped(signal: AbortSignal) {
  return scope.signal === signal && !signal.aborted && authorized.value
}

function reset() {
  scope.abort()
  scope = new AbortController()
  document.value = undefined
  documents.value = []
  nodes.value = []
  edges.value = []
  nodeId.value = ''
  edgeId.value = ''
  offset.value = null
  outlinePage.value = 0
  outlineSearch.value = ''
  focusBoardNode.value = ''
  loadingAll.value = false
  completeGraph.value = false
  bulkProgress.value = 0
  retry.value = undefined
  plan.value = undefined
  form.value = undefined
  working.value = false
  bundlePending.value = false
  loading.value = false
  stale.value = false
  graphReadFailure.value = false
  history.value = undefined
  historyFailure.value = false
  historyLoading.value = false
  historyRequest?.abort()
  historyRequest = undefined
  clearReference()
  linkPending.value = false
  linkUnconfirmed.value = false
  error.value = ''
  message.value = ''
  title.value = ''
}

function recordError(cause: unknown, signal: AbortSignal, fallback: string, reading = false): boolean {
  if (!scoped(signal)) return false
  if (!(cause instanceof ApiError)) {
    error.value = fallback
    return false
  }
  if (cause.status === 401) {
    invalidateSession()
  } else if (cause.status === 403 || cause.status === 404 && reading) {
    nodes.value = []
    edges.value = []
    document.value = undefined
    documents.value = []
    history.value = undefined
    historyFailure.value = false
    plan.value = undefined
    retry.value = undefined
    error.value = t('author.canvas.canvas_is_unavailable')
  } else if (cause.status === 409) {
    stale.value = true
    error.value = t('author.canvas.the_canvas_changed_reload_the_current_revision')
  } else if (cause.status === 400 || cause.status === 404) {
    error.value = cause.message
  } else {
    error.value = fallback
    return false
  }
  return true
}

async function loadHistory(current = document.value) {
  const signal = scope.signal
  if (!current || !scoped(signal)) return
  historyRequest?.abort()
  const request = new AbortController()
  historyRequest = request
  historyLoading.value = true
  history.value = undefined
  historyFailure.value = false

  const isLatest = () => request === historyRequest && !request.signal.aborted && scoped(signal) &&
    document.value?.id === current.id && document.value.revision === current.revision
  try {
    const next = await canvasGraph.history(current.id, current.revision, request.signal)
    if (!isLatest()) return
    if (next.revision !== current.revision) throw Error('Canvas history revision changed')
    history.value = next
  } catch (cause) {
    if (!isLatest()) return
    if (cause instanceof ApiError && [401, 403, 404, 409].includes(cause.status)) {
      recordError(cause, signal, t('author.canvas.could_not_load_canvas_history'), true)
    } else {
      historyFailure.value = true
    }
  } finally {
    if (request === historyRequest && scoped(signal)) {
      historyLoading.value = false
      historyRequest = undefined
    }
  }
}

async function load(more = false, confirmed?: CanvasGraphHeader) {
  const signal = scope.signal
  if (!scoped(signal) || loading.value || (more && offset.value === null)) return
  loading.value = true
  error.value = ''
  try {
    if (!documentId.value) {
      const value = await canvasGraph.list(signal)
      if (scoped(signal)) documents.value = value
    } else {
      const previous = more ? document.value : undefined
      const id = documentId.value
      const page = await canvasGraph.page(id, confirmed ? { revision: confirmed.revision }
        : previous && offset.value !== null ? { revision: previous.revision, offset: offset.value } : {}, signal)
      if (!scoped(signal)) return
      document.value = page.header
      nodes.value = more ? [...nodes.value, ...page.nodes] : page.nodes
      edges.value = more ? [...edges.value, ...page.edges] : page.edges
      offset.value = page.nextOffset
      if (!more) {
        outlinePage.value = 0
        if (page.nextOffset !== null && page.nextOffset === page.header.nodeCount) {
          const edgePage = await canvasGraph.page(id, { revision: page.header.revision, offset: page.nextOffset }, signal)
          if (!scoped(signal)) return
          edges.value = edgePage.edges
          offset.value = edgePage.nextOffset
        }
      }
      if (offset.value === null) {
        if (nodeId.value && !byId.value.has(nodeId.value)) nodeId.value = ''
        if (edgeId.value && !edges.value.some(edge => edge.id === edgeId.value)) edgeId.value = ''
      }
    }
    if (scoped(signal)) {
      stale.value = false
      graphReadFailure.value = false
      if (!more && document.value) {
        if (confirmed) await loadHistory(document.value)
        else void loadHistory(document.value)
      }
      if (completeGraph.value && offset.value !== null && !more) await loadAll()
    }
  } catch (cause) {
    if (scoped(signal)) graphReadFailure.value = true
    recordError(cause, signal, t('author.canvas.could_not_load_the_canvas'), true)
  } finally {
    if (scoped(signal)) loading.value = false
  }
}

async function loadAll() {
  const current = document.value
  const signal = scope.signal
  let next = offset.value
  if (!current || next === null || loadingAll.value || !scoped(signal)) return
  loadingAll.value = true
  error.value = ''
  bulkProgress.value = nodes.value.length + edges.value.length
  const nextNodes = [...nodes.value]
  const nextEdges = [...edges.value]

  try {
    while (next !== null) {
      const page = await canvasGraph.page(current.id, { revision: current.revision, offset: next }, signal)
      if (!scoped(signal) || current !== document.value) return
      nextNodes.push(...page.nodes)
      nextEdges.push(...page.edges)
      bulkProgress.value = nextNodes.length + nextEdges.length
      next = page.nextOffset
    }
    if (nextNodes.length !== current.nodeCount || nextEdges.length !== current.edgeCount) {
      throw new Error('Canvas pages did not cover the advertised counts')
    }
    if (!scoped(signal) || current !== document.value) return
    nodes.value = nextNodes
    edges.value = nextEdges
    offset.value = null
    completeGraph.value = true
    if (nodeId.value && !byId.value.has(nodeId.value)) nodeId.value = ''
    if (edgeId.value && !nextEdges.some(edge => edge.id === edgeId.value)) edgeId.value = ''
  } catch (cause) {
    if (!scoped(signal)) return
    completeGraph.value = false
    if (cause instanceof ApiError && [401, 403, 404, 409].includes(cause.status)) {
      recordError(cause, signal, t('author.canvas.could_not_load_all_canvas_records'), true)
    } else {
      error.value = t('author.canvas.could_not_load_all_canvas_records_try_again')
    }
  } finally {
    if (scoped(signal)) loadingAll.value = false
  }
}

watch([documentId, identityEpoch, ready], () => {
  reset()
  if (ready.value && authorized.value) void load()
}, { immediate: true, flush: 'sync' })
onMounted(() => {
  void refreshSession(ownerLife.signal).finally(() => {
    if (!ownerLife.signal.aborted) ready.value = true
  }).catch(() => { error.value = t('author.canvas.could_not_verify_your_session') })
})
function protectUnload(event: BeforeUnloadEvent) {
  if (working.value || bundlePending.value || retry.value || linkUnconfirmed.value || linkPending.value) event.preventDefault()
}
onMounted(() => window.addEventListener('beforeunload', protectUnload))
onScopeDispose(() => {
  ownerLife.abort()
  scope.abort()
  historyRequest?.abort()
  clearReference()
  window.removeEventListener('beforeunload', protectUnload)
})
function canNavigate() {
  return !working.value && !bundlePending.value && !linkPending.value && !form.value && !plan.value &&
    !retry.value && !linkUnconfirmed.value
}
onBeforeRouteUpdate(canNavigate)
onBeforeRouteLeave(canNavigate)

function clearReference() {
  referenceRequest?.abort()
  referenceRequest = undefined
  reference.value = undefined
  referenceLoading.value = false
  referenceError.value = false
  referenceOpenNotice.value = ''
}

watch([document, selectedReference, view, stale], clearReference, { flush: 'sync' })

const referenceStatus = computed(() => ({
  unavailable: t('author.canvas.this_reference_is_unavailable'),
  resolved: t('author.canvas.reference_resolved'),
  'missing-anchor': t('author.canvas.the_anchor_does_not_exist_at_this_revision'),
  'duplicate-anchor': t('author.canvas.the_anchor_is_ambiguous_at_this_revision'),
  'stale-revision': t('author.canvas.the_referenced_revision_is_unavailable'),
}))

async function resolveReference() {
  const current = document.value
  const node = selectedReference.value
  const signal = scope.signal
  if (!current || !node || disabled.value || !scoped(signal) || referenceLoading.value) return
  clearReference()
  const request = new AbortController()
  referenceRequest = request
  referenceLoading.value = true
  const isLatest = () => scoped(signal) && request === referenceRequest && !request.signal.aborted &&
    document.value === current && selectedReference.value === node

  try {
    const result = await canvasGraph.resolve(current.id, node.id, current.revision, request.signal)
    if (!isLatest()) return
    if (result.canvasId !== current.id || result.nodeId !== node.id || result.canvasRevision !== current.revision ||
      (result.articleId !== null && (result.articleId !== node.articleId ||
        result.pinned !== (node.pinnedRevision !== null) ||
        (node.pinnedRevision !== null && result.articleRevision !== node.pinnedRevision)))) {
      referenceError.value = true
      return
    }
    reference.value = result
  } catch (cause) {
    if (!isLatest()) return
    if (cause instanceof ApiError && [401, 403, 404, 409].includes(cause.status)) {
      recordError(cause, signal, t('author.canvas.could_not_resolve_the_reference'), true)
    } else {
      referenceError.value = true
    }
  } finally {
    if (referenceRequest === request) {
      referenceLoading.value = false
      referenceRequest = undefined
    }
  }
}

async function openReference() {
  const canvas = document.value
  const node = selectedReference.value
  const preview = reference.value
  const handle = currentSession.value?.siteSessionId
  const epoch = credentialEpoch.value
  const signal = scope.signal
  if (!canvas || !node || !canOpenReference.value || !preview?.articleId || preview.articleRevision === null ||
    !handle || disabled.value || referenceLoading.value || !scoped(signal) || !canNavigate()) return

  const request = new AbortController()
  referenceRequest = request
  referenceLoading.value = true
  referenceOpenNotice.value = ''
  const isLatest = () => scoped(signal) && request === referenceRequest && !request.signal.aborted &&
    document.value === canvas && selectedReference.value === node && credentialEpoch.value === epoch && canNavigate()

  let token: string | undefined
  try {
    const result = await canvasGraph.resolve(canvas.id, node.id, canvas.revision, request.signal, handle)
    if (!isLatest()) return
    if (result.state !== 'resolved' || result.articleId !== preview.articleId ||
      result.articleRevision !== preview.articleRevision || result.sourceOffset !== preview.sourceOffset || result.pinned !== preview.pinned) {
      referenceOpenNotice.value = preview.pinned && result.state === 'stale-revision'
        ? t('author.canvas.the_pinned_revision_cannot_be_opened_as_the_current_draft')
        : t('author.canvas.could_not_open_this_reference_at_its_resolved_position_resolve_it_again')
      return
    }
    token = offerCanvasEditorHandoff({ articleId: preview.articleId, revision: preview.articleRevision, sourceOffset: result.sourceOffset }, epoch)
    if (await router.push({ name: 'edit', params: { id: preview.articleId }, state: { [canvasEditorHandoffKey]: token } })) {
      cancelCanvasEditorHandoff(token)
      if (isLatest()) referenceOpenNotice.value = t('author.canvas.the_editor_could_not_be_opened_try_again')
    }
  } catch (cause) {
    if (token) cancelCanvasEditorHandoff(token)
    if (isLatest()) {
      if (cause instanceof ApiError && cause.status === 401) invalidateSession()
      referenceOpenNotice.value = t('author.canvas.the_editor_could_not_be_opened_resolve_the_reference_again')
    }
  } finally {
    if (referenceRequest === request) {
      referenceLoading.value = false
      referenceRequest = undefined
    }
  }
}

function openImported(id: string) {
  void router.push({ name: 'canvas-document', params: { id } })
}

function chooseNode(id: string) { nodeId.value = id; edgeId.value = '' }
function chooseEdge(id: string) { edgeId.value = id; nodeId.value = '' }
async function showNode() {
  const node = selectedNode.value
  const viewport = document.value?.viewport
  if (!node || !viewport) return
  const signal = scope.signal
  view.value = 'canvas'
  await saveViewport({ ...viewport, x: Math.max(-1_000_000_000, node.geometry.x - 3500),
    y: Math.max(-1_000_000_000, node.geometry.y - 3500) })
  if (scoped(signal) && selectedNode.value?.id === node.id && view.value === 'canvas' && !stale.value)
    focusBoardNode.value = node.id
}

async function send(command: CanvasGraphCommand) {
  const signal = scope.signal
  if (!scoped(signal) || working.value || linkPending.value || stale.value ||
    (retry.value && retry.value !== command)) return
  try { encodeCanvasGraphCommand(command) }
  catch { error.value = t('author.canvas.check_the_canvas_text_reference_and_size_limits'); return }
  working.value = true
  message.value = ''
  error.value = ''
  retry.value = command
  try {
    const result = await canvasGraph.write(command, signal)
    if (!scoped(signal)) return
    retry.value = undefined
    working.value = false
    form.value = undefined
    message.value = command.action === 'undo' ? t('author.canvas.canvas_change_undone')
      : command.action === 'redo' ? t('author.canvas.canvas_change_redone') : t('author.canvas.canvas_saved')
    if (command.action === 'create') {
      await router.push({ name: 'canvas-document', params: { id: result.id } })
    } else if (result.deleted) {
      await router.replace({ name: 'canvas' })
    } else if (command.action === 'undo' || command.action === 'redo') {
      await load(false, result)
    } else if (command.changes.length === 0) {
      document.value = result
      // A later continuation must use the newly confirmed revision.
      void loadHistory(result)
    } else if (completeGraph.value && command.changes.length === 1 &&
      command.changes[0].kind === 'upsert-node' && byId.value.has(command.changes[0].node.id) &&
      result.nodeCount === nodes.value.length && result.edgeCount === edges.value.length) {
      // An existing node upsert changes no incident records. The exact CAS
      // receipt confirms this immutable candidate without refetching all pages.
      const changed = command.changes[0].node
      nodes.value = nodes.value.map(node => node.id === changed.id ? changed : node)
      document.value = result
      void loadHistory(result)
    } else {
      await load(false, result)
    }
  } catch (cause) {
    if (recordError(cause, signal, t('author.canvas.could_not_confirm_the_change_retry_the_same_request'))) retry.value = undefined
  } finally {
    if (scoped(signal)) working.value = false
  }
}

async function travel(action: 'undo' | 'redo') {
  const current = document.value
  if (!current || !historyActionAvailable.value[action]) return
  const signal = scope.signal
  const trigger = tools.value?.querySelector<HTMLButtonElement>(`button.canvas-${action}`)
  const hadFocus = trigger === window.document.activeElement
  await send({
    id: current.id, commandId: crypto.randomUUID(), expectedRevision: current.revision,
    action, title: '', viewport: null, changes: [],
  })
  await nextTick()
  if (!hadFocus || !scoped(signal) || document.value?.id !== current.id) return
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
  if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.ctrlKey === event.metaKey) return
  const key = event.key.toLowerCase()
  const action = key === 'z' ? (event.shiftKey ? 'redo' : 'undo') : key === 'y' && !event.shiftKey ? 'redo' : undefined
  if (!action || !historyActionAvailable.value[action] || !(event.target instanceof HTMLElement) ||
    !graph.value?.contains(event.target) || event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return
  event.preventDefault()
  void travel(action)
}

function patch(changes: CanvasGraphChange[] = [], name = '', viewport: CanvasViewport | null = null) {
  if (!document.value || disabled.value) return
  return send({
    id: document.value.id, commandId: crypto.randomUUID(), expectedRevision: document.value.revision,
    action: 'edit', title: name, viewport, changes,
  })
}
function saveViewport(viewport: CanvasViewport) {
  const saved = document.value?.viewport
  if (saved && (viewport.x !== saved.x || viewport.y !== saved.y || viewport.zoom !== saved.zoom)) return patch([], '', viewport)
}
function zoom(amount: number) {
  const viewport = document.value?.viewport
  if (viewport) saveViewport({ ...viewport, zoom: Math.min(4000, Math.max(100, viewport.zoom + amount)) })
}
function move(id: string, geometry: CanvasGeometry) {
  const node = byId.value.get(id)
  if (node) patch([{ kind: 'upsert-node', node: { ...node, geometry } }])
}

function nameDocument() {
  title.value = document.value?.title ?? ''
  form.value = 'title'
}
function saveTitle() {
  const next = title.value.trim()
  if (!next || next === document.value?.title) return
  if (document.value) patch([], next)
  else void send({ id: crypto.randomUUID(), commandId: crypto.randomUUID(), expectedRevision: 0n,
    action: 'create', title: next, viewport: null, changes: [] })
}
function addNode(kind: CanvasNode['kind'] = 'plain-text-note', existing = false) {
  const node = existing ? selectedNode.value : undefined
  choiceFilter.value = ''
  nodeKind.value = node?.kind ?? kind
  note.value = node && 'text' in node ? node.text : ''
  article.value = node && 'articleId' in node ? String(node.articleId) : ''
  anchor.value = node && 'anchor' in node ? node.anchor : ''
  pinned.value = node && 'pinnedRevision' in node ? node.pinnedRevision?.toString() ?? '' : ''
  members.value = node?.kind === 'group-frame' ? [...node.memberIds] : []
  editingNode.value = node
  form.value = 'node'
}
const editingNode = shallowRef<CanvasNode>()
function saveNode() {
  const canvas = document.value
  if (!canvas) return
  const current = editingNode.value
  const id = current?.id ?? crypto.randomUUID()
  const shift = (canvas.nodeCount % 8) * 3400
  const geometry = current?.geometry ?? {
    x: Math.min(1_000_000_000, canvas.viewport.x + 3500 + shift),
    y: Math.min(1_000_000_000, canvas.viewport.y + 3500 + shift), width: 17000, height: 10000,
  }
  const kind = nodeKind.value
  const base = { id, geometry }
  let node: CanvasNode
  if (kind === 'plain-text-note') node = { ...base, kind, text: note.value }
  else if (kind === 'group-frame') node = { ...base, kind, text: note.value, memberIds: members.value }
  else {
    if (!/^[1-9]\d{0,9}$/.test(article.value) || Number(article.value) > 2_147_483_647 ||
      pinned.value && !/^[1-9]\d{0,18}$/.test(pinned.value)) {
      error.value = t('author.canvas.enter_a_valid_article_id_and_optional_pinned_revision')
      return
    }
    const referenced = { ...base, articleId: Number(article.value), pinnedRevision: pinned.value ? BigInt(pinned.value) : null }
    node = kind === 'article-reference' ? { ...referenced, kind } : { ...referenced, kind, anchor: anchor.value }
  }
  patch([{ kind: 'upsert-node', node }])
}
function setMembers(event: Event) {
  if (!(event.target instanceof HTMLSelectElement)) return
  const shown = new Set(memberChoices.value.map(node => node.id))
  const hidden = members.value.filter(member => !shown.has(member))
  const selected = Array.from(event.target.selectedOptions, option => option.value)
  members.value = [...hidden, ...selected]
}
function addEdge() {
  if (!selectedNode.value) return
  showEdgeForm()
}
function showEdgeForm(edge?: CanvasGraphEdge) {
  editingEdge.value = edge
  endpoint.value = edge?.targetNodeId ?? ''
  choiceFilter.value = ''
  edgeKind.value = edge?.kind ?? 'visual-only'
  label.value = edge?.label ?? ''
  form.value = 'edge'
}
function saveEdge() {
  const prior = editingEdge.value
  const sourceNodeId = prior?.sourceNodeId ?? selectedNode.value?.id
  if (!sourceNodeId || !byId.value.has(endpoint.value) && prior?.targetNodeId !== endpoint.value) return
  patch([{ kind: 'upsert-edge', edge: { id: prior?.id ?? crypto.randomUUID(), sourceNodeId,
    targetNodeId: endpoint.value, kind: edgeKind.value, order: prior?.order ?? document.value?.edgeCount ?? 0,
    label: label.value || null } }])
}
async function deleteDocument() {
  const selected = document.value
  const signal = scope.signal
  if (!selected || disabled.value) return
  try { await ElMessageBox.confirm(t('author.canvas.delete_this_canvas_and_its_nodes_and_edges'), t('author.canvas.delete_canvas'), { confirmButtonText: t('author.canvas.delete') }) }
  catch { return }
  if (!scoped(signal) || document.value !== selected) return
  await send({ id: selected.id, expectedRevision: selected.revision, commandId: crypto.randomUUID(),
    action: 'delete', title: '', viewport: null, changes: [] })
}

async function prepareLink() {
  const pair = activeLink.value
  const edge = selectedEdge.value
  const canvas = document.value
  const signal = scope.signal
  if (!pair || !edge || !canvas || disabled.value) return
  linkPending.value = true
  error.value = ''
  try {
    const [host, target] = await Promise.all([api.draft(pair.from.articleId, signal), api.publicArticle(pair.to.articleId, signal)])
    if (!scoped(signal) || document.value !== canvas || selectedEdge.value !== edge) return
    const preview = await previewCanvasLink({ canvasId: canvas.id, edgeId: edge.id, canvasRevision: canvas.revision,
      hostRevision: host.revision, targetRevision: target.revision, sourceOffset: host.body.length }, host.id, target.id, signal,
    edge.kind === 'visual-only')
    if (scoped(signal) && document.value === canvas && selectedEdge.value === edge) plan.value = { ...preview, edgeKind: edge.kind }
  } catch (cause) { recordError(cause, signal, t('author.canvas.could_not_prepare_the_article_link')) }
  finally { if (scoped(signal)) linkPending.value = false }
}
async function applyLink() {
  const preview = plan.value
  const signal = scope.signal
  if (!preview || !scoped(signal) || linkPending.value) return
  linkPending.value = true
  error.value = ''
  try {
    await confirmCanvasLink(preview, signal)
    if (!scoped(signal)) return
    plan.value = undefined
    linkUnconfirmed.value = false
    message.value = t('author.canvas.link_added_to_a_new_article_draft')
    await load()
  } catch (cause) {
    const rejected = recordError(cause, signal, t('author.canvas.the_outcome_is_uncertain_retry_the_same_link_confirmation'))
    if (scoped(signal)) {
      if (rejected) plan.value = undefined
      linkUnconfirmed.value = !rejected
    }
  } finally { if (scoped(signal)) linkPending.value = false }
}
function cancelLink() {
  if (!linkPending.value && !linkUnconfirmed.value) plan.value = undefined
}

const nodeTypeLabels = computed(() => ({
  'plain-text-note': t('author.canvas.note'), 'article-reference': t('author.canvas.article'), 'heading-reference': t('author.canvas.heading'),
  'block-reference': t('author.canvas.block'), 'group-frame': t('author.canvas.frame'),
}))
function nodeLabel(node: CanvasNode): string {
  return 'text' in node ? node.text.slice(0, 70) : t('author.canvas.kind_reference_article', { kind: nodeTypeLabels.value[node.kind], article: node.articleId })
}
function edgeLabel(edge: CanvasGraphEdge) {
  const from = byId.value.get(edge.sourceNodeId)
  const to = byId.value.get(edge.targetNodeId)
  return edge.label || `${from ? nodeLabel(from) : t('author.canvas.unloaded_node')} → ${to ? nodeLabel(to) : t('author.canvas.unloaded_node')}`
}
</script>

<template>
  <main class="canvas-workspace" aria-labelledby="canvas-title" @keydown="historyShortcut">
    <header class="canvas-header">
      <div>
        <RouterLink :to="documentId ? '/user/manage/canvas' : articlePath">{{ documentId ? t('author.canvas.all_canvases') : t('author.canvas.article_workspace') }}</RouterLink>
        <h1 id="canvas-title">{{ document?.title ?? (documentId ? t('author.canvas.canvas') : t('author.canvas.canvases')) }}</h1>
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
    <RouterLink v-else-if="!authorized" to="/login">{{ t('author.canvas.log_in_to_access_canvas') }}</RouterLink>
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
          <option value="article-reference">{{ t('author.canvas.article') }}</option><option value="heading-reference">{{ t('author.canvas.heading') }}</option><option value="block-reference">{{ t('author.canvas.block') }}</option>
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
          <label for="canvas-article">{{ t('author.canvas.article_id') }}</label><input id="canvas-article" v-model="article" inputmode="numeric" :disabled="working || !!retry" />
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
      <ElButton v-else-if="form" :disabled="working" @click="form = undefined">{{ t('author.canvas.cancel') }}</ElButton>
    </ElDialog>

    <ElDialog v-if="authorized" :model-value="!!plan" :title="t('author.canvas.review_article_link')" append-to-body :show-close="!linkPending && !linkUnconfirmed"
      :close-on-press-escape="!linkPending && !linkUnconfirmed" :close-on-click-modal="!linkPending && !linkUnconfirmed" @close="cancelLink">
      <div v-if="plan">
        <p>{{ t('author.canvas.add_this_markdown_to_the_end_of_article_article_s_private_draft', { article: plan.hostArticleId }) }}</p>
        <p v-if="plan.edgeKind === 'visual-only'">{{ t('author.canvas.use_the_selected_visual_connection_as_an_article_link_the_connection_stays_in_the_canvas') }}</p>
        <pre class="canvas-link-preview">{{ plan.insertedMarkdown }}</pre>
        <p v-if="error" role="alert">{{ error }}</p>
        <div class="canvas-toolbar">
          <ElButton :disabled="linkPending || linkUnconfirmed" @click="cancelLink">{{ t('author.canvas.cancel') }}</ElButton>
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
