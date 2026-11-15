<script setup lang="ts">
import { computed, h, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, RouterLink, useRoute, useRouter, type RouteLocationNormalized } from 'vue-router'
import { ElAlert, ElButton, ElInput, ElMessageBox, ElRadio, ElRadioGroup } from '@ozwasyd/element-plus'
import { api, ApiError, type Draft } from '../../../Contracts/client'
import { WireLimits } from '../../../Contracts/wire.generated'
import { assignTaxonomy, type TaxonomySelection } from '../../../Contracts/taxonomy-client'
import { rollbackDraft } from '../../../Contracts/revision-history'
import { setArticleSchedule } from '../../../Contracts/article-schedule'
import { setDraftRights, type RightsEdit } from '../../../Contracts/article-rights'
import { saveDraftSummary, type DraftSummaryEdit } from '../../../Contracts/article-summary-client'
import { editArticleMedia, type AttachmentEdit } from '../../../Contracts/article-media'
import { publishArticleImages, type PublishImagesSelection } from '../../../Contracts/published-media'
import ArticleTaxonomy from './ArticleTaxonomy.vue'
import ArticleProperties from './ArticleProperties.vue'
import WorkspaceTabs from '../authoring/WorkspaceTabs.vue'
import WorkspaceSourcePane from '../authoring/WorkspaceSourcePane.vue'
import ArticleLibraryRail from '../authoring/ArticleLibraryRail.vue'
import EditorInspector from '../authoring/EditorInspector.vue'
import RevisionHistory from '../authoring/RevisionHistory.vue'
import ArticleSchedule from '../authoring/ArticleSchedule.vue'
import ArticleRights from '../authoring/ArticleRights.vue'
import ArticleSummary from '../authoring/ArticleSummary.vue'
import ArticleMedia from '../authoring/ArticleMedia.vue'
import MarkdownExportControl from '../authoring/MarkdownExportControl.vue'
import { editorRecovery } from '../authoring/editorRecovery'
import { workspacePersistence } from '../authoring/workspacePersistence'
import { recentArticleOpens } from '../authoring/recentArticleOpens'
import {
  acceptEditorSourceHandoff, editorSourceHandoffKey, type EditorSourceSeek, type EditorSourceTarget,
} from '../authoring/canvasEditorHandoff'
import type { RecoveryCandidate } from '../authoring/draftJournal'
import { credentialEpoch, currentSession, identityEpoch, recheckCredential, refreshSession } from '../session'
import {
  WorkspaceRegistry,
  type DraftSave,
  type Activation,
  type ClosePlan,
  type RecentlyClosed,
  type WorkspaceBlock,
  type WorkspaceGroup,
  type WorkspaceSource,
  type WorkspaceTab,
} from '../authoring/workspaceRegistry'

type ArticleAction = 'save' | 'publish' | 'retract'
type Action = ArticleAction | 'publish-images' | 'assign-taxonomy' | 'rollback-history' | 'schedule-publication' | 'save-rights' | 'save-attachment' | 'save-summary'
type RestoreSelection = { sourceRevision: bigint; reason: string }
const route = useRoute()
const router = useRouter()
function articleRoute(location: Pick<RouteLocationNormalized, 'name' | 'params'>) {
  if (location.name === 'write') return 0
  if (location.name === 'edit') return Number(location.params.id)
  return undefined
}
const id = computed(() => articleRoute(route))
const arrivalState = history.state as Record<string, unknown> | null
const sourceToken = arrivalState?.[editorSourceHandoffKey]
if (sourceToken !== undefined && arrivalState) {
  const state = { ...arrivalState }
  delete state[editorSourceHandoffKey]
  history.replaceState(state, '')
}
let sourceArrival: { articleId: number | undefined; source?: EditorSourceTarget; epoch?: number } | undefined =
  sourceToken === undefined ? undefined : { articleId: id.value }
let sourceSessionVerified = false
const sourceSeek = shallowRef<EditorSourceSeek>()
const searchPositionUnavailable = 'The search position is no longer available. Return to article search and choose a current result.'
const workspaceTabs = shallowRef<readonly WorkspaceTab[]>([])
const sourcePanes = shallowRef<readonly WorkspaceSource<Draft>[]>([])
const hasSecondaryGroup = ref(false)
const recentlyClosed = shallowRef<readonly RecentlyClosed[]>([])
const tabsControl = ref<InstanceType<typeof WorkspaceTabs>>()
const articleInput = ref<InstanceType<typeof ElInput>>()
const openInput = ref('')
const navigationNotice = ref('')
const groupNotice = ref('')
const opening = ref(false)
const closingTabs = ref(false)
const composing = ref<number>()
let navigation = 0
type NavigationIntent = {
  path: string
  restore?: RecentlyClosed
  targetGroup?: WorkspaceGroup
  witness?: Readonly<{ sessionId: number; articleRevision: bigint }>
}
let explicitNavigation: NavigationIntent | undefined
const notice = ref('')
const taxonomyDirty = ref(false)
const summaryDirty = ref(false)
const metadataDirty = computed(() => taxonomyDirty.value || summaryDirty.value)
const taxonomyStale = ref(false)
const propertyPending = ref(false)
const revisionComparisonActive = ref(false)
const recovery = editorRecovery()
const recoveryItems = recovery.candidates
const recoveryFailure = recovery.failure
const recoveryChecking = recovery.guarded
const recoveryWorking = ref(false)
const recoveryBlocked = computed(() => recoveryWorking.value || recoveryChecking.value || recoveryItems.value.length > 0)
const failure = ref('')
const authorizationReady = ref(false)
const layoutRestoring = ref(false)
const loading = ref(false)
const reload = ref(0)
const lifetime = new AbortController()
const original = shallowRef<Draft>()
const tab = shallowRef<WorkspaceTab>()
const selectedPanelTitle = computed(() => tab.value?.title ? `Article content – ${tab.value.title}` : 'Article content')
const articleDirty = computed(() => tab.value?.risk === 'dirty' || tab.value?.risk === 'conflict')
const dirty = computed(() => articleDirty.value || metadataDirty.value)
const hasConflict = computed(() => taxonomyStale.value || tab.value?.risk === 'conflict')
const articlePending = computed(() => tab.value?.risk === 'saving')
const pending = computed(() => articlePending.value || propertyPending.value)
const canSwitch = computed(() => !layoutRestoring.value && !propertyPending.value && !metadataDirty.value && !recoveryWorking.value &&
  !closingTabs.value && composing.value === undefined && !(articlePending.value && tab.value?.articleId === 0))
const retry = computed(() => tab.value?.retry)
const encoder = new TextEncoder()
function validDraftTitle(title: string) {
  const name = title.trim()
  return name.length > 0 && encoder.encode(name).length <= WireLimits.TitleBytes && !/[\x00-\x1f\x7f-\x9f]/.test(name)
}
const validDraftBody = (body: string) => body.length <= 200_000 && !body.includes('\0') && encoder.encode(body).length <= WireLimits.BodyBytes
const validTitle = computed(() => validDraftTitle(original.value?.title ?? ''))
const validBody = computed(() => validDraftBody(original.value?.body ?? ''))
const editable = computed(() => Boolean(currentSession.value?.canAuthor && original.value?.id === id.value && !loading.value))
const cannotWrite = computed(() => closingTabs.value || pending.value || recoveryBlocked.value || hasConflict.value ||
  metadataDirty.value || !validBody.value || !validTitle.value)
const publishedPath = computed(() => original.value?.published ? `/article/${original.value.id}` : '')
const editorArea = ref<HTMLElement>()
const wideEditorArea = ref(false)
const comparisonReady = ref(false)
const selectedPanes = computed(() => sourcePanes.value.filter(pane => pane.selected))
const twoSources = computed(() => selectedPanes.value.length === 2)
const showComparison = computed(() => twoSources.value && wideEditorArea.value && comparisonReady.value)
const comparisonTab = computed(() => selectedPanes.value.find(pane => !pane.tab.active)?.tab)
const selectedLocations = computed(() => selectedPanes.value.map(pane => `${pane.tab.sessionId}:${pane.tab.group}`).join(','))
const credential = computed(() => currentSession.value?.siteSessionId)
const canChangeSummary = computed(() => !!credential.value && editable.value && tab.value?.risk === 'clean' &&
  !closingTabs.value && !pending.value && !recoveryBlocked.value && !hasConflict.value && !taxonomyDirty.value &&
  validBody.value && validTitle.value)
const canArrangeGroups = computed(() => !!credential.value && editable.value && !opening.value && !layoutRestoring.value &&
  !closingTabs.value && composing.value === undefined && !revisionComparisonActive.value)
const activeGroupTabs = computed(() => workspaceTabs.value.filter(candidate => candidate.group === tab.value?.group))
const activeGroupIndex = computed(() => activeGroupTabs.value.findIndex(candidate => candidate.active))
const canCloseGroupTabs = computed(() => editable.value && canSwitch.value && !opening.value &&
  !revisionComparisonActive.value)
const canPublishImages = computed(() => !!credential.value && editable.value && tab.value?.risk === 'clean' &&
  !cannotWrite.value && !dirty.value && !retry.value && !!original.value?.body.trim())
let deferredFocus: Readonly<{ sessionId: number; epoch: number; pane: HTMLElement }> | undefined

watch(editorArea, (area, _, cleanup) => {
  wideEditorArea.value = false
  if (!area) return
  function measure() {
    if (!area) return
    const minimum = 59 * parseFloat(getComputedStyle(document.documentElement).fontSize)
    const available = Math.min(area.clientWidth, window.visualViewport?.width ?? window.innerWidth)
    wideEditorArea.value = available >= minimum
  }
  const observer = new ResizeObserver(measure)
  observer.observe(area)
  window.visualViewport?.addEventListener('resize', measure)
  measure()
  cleanup(() => {
    observer.disconnect()
    window.visualViewport?.removeEventListener('resize', measure)
  })
})

function paneFocused(pane: WorkspaceSource<Draft>) {
  return editable.value && pane.selected && pane.tab.active && tab.value?.sessionId === pane.tab.sessionId
}

function changeComposition(pane: WorkspaceSource<Draft>, active: boolean) {
  if (active) {
    if (paneFocused(pane)) composing.value = pane.tab.sessionId
  } else if (composing.value === pane.tab.sessionId) {
    void nextTick(() => { if (composing.value === pane.tab.sessionId) composing.value = undefined })
  }
}

const failureByReason: Record<WorkspaceBlock, string> = {
  missing: 'The article is unavailable.',
  deleted: 'The article is unavailable.',
  forbidden: 'You can no longer edit this article.',
  expired: 'Log in again to continue writing.',
  unavailable: 'The server could not confirm this change. Try again.',
  'stale-reference': 'The referenced revision is no longer current. Resolve it again from the Canvas.',
}

async function workspaceBlock(error: unknown, handle: string | undefined, signal: AbortSignal): Promise<WorkspaceBlock> {
  if (!(error instanceof ApiError)) return 'unavailable'
  if (error.status === 401 || sessionMismatch(error)) {
    if (!handle || signal.aborted) return 'unavailable'
    await recheckCredential(handle, signal)
    return currentSession.value ? 'unavailable' : 'expired'
  }
  if (error.status === 403) return 'forbidden'
  if (error.status === 404) return 'missing'
  return 'unavailable'
}

function sessionMismatch(error: ApiError): boolean {
  return error.status === 409 && error.message === 'The current browser session changed. Reload before making changes.'
}

async function mutationResult(operation: () => Promise<Draft>, signal: AbortSignal): Promise<DraftSave<Draft>> {
  const handle = currentSession.value?.siteSessionId
  try {
    return { kind: 'saved', draft: await operation() }
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 409 && !sessionMismatch(error)) return { kind: 'conflict' }
      if (error.status === 400) return { kind: 'rejected' }
    }
    return { kind: 'blocked', reason: signal.aborted ? 'unavailable' : await workspaceBlock(error, handle, signal) }
  }
}

const send = (action: ArticleAction) => (draft: Draft, signal: AbortSignal, idempotencyKey: string): Promise<DraftSave<Draft>> => {
  const handle = currentSession.value?.siteSessionId
  if (!handle || signal.aborted) return Promise.resolve({ kind: 'blocked', reason: 'unavailable' })
  const title = action === 'save' ? draft.title.trim() : ''
  const body = action === 'save' ? draft.body : ''
  return mutationResult(async () => {
    const stored = await api[action]({ id: draft.id, expectedRevision: draft.revision, title, body, idempotencyKey }, signal, handle)
    if (action === 'save' && (stored.title !== title || stored.body !== body)) {
      throw new Error('The save reply did not match the submitted draft source.')
    }
    return stored
  }, signal)
}

const saveTaxonomy = (selection: TaxonomySelection) => (draft: Draft, signal: AbortSignal, idempotencyKey: string) =>
  mutationResult(async () => {
    const stored = await assignTaxonomy({
      id: draft.id, expectedRevision: draft.revision, idempotencyKey,
      categoryId: selection.categoryId, tagIds: selection.tagIds.slice(),
    }, signal)
    return { ...draft, id: stored.id, revision: stored.revision }
  }, signal)

const restoreRevision = (selection: RestoreSelection) => (draft: Draft, signal: AbortSignal, idempotencyKey: string) =>
  mutationResult(() => rollbackDraft({
    id: draft.id, expectedRevision: draft.revision, idempotencyKey, ...selection,
  }, signal), signal)

const updateSchedule = (dueUnixMs: bigint) => (draft: Draft, signal: AbortSignal, idempotencyKey: string) =>
  mutationResult(async () => {
    const result = await setArticleSchedule({
      id: draft.id, expectedRevision: draft.revision, idempotencyKey, dueUnixMs,
    }, signal)
    return { ...draft, revision: result.revision, published: result.publishedRevision !== 0n }
  }, signal)

const updateRights = (policy: RightsEdit) => (draft: Draft, signal: AbortSignal, idempotencyKey: string) =>
  mutationResult(async () => {
    const result = await setDraftRights({ ...policy, id: draft.id, expectedRevision: draft.revision, idempotencyKey }, signal)
    return { ...draft, revision: result.revision }
  }, signal)

const updateAttachment = (edit: AttachmentEdit) => (draft: Draft, signal: AbortSignal, key: string) => {
  const handle = currentSession.value?.siteSessionId
  if (!handle || signal.aborted) return Promise.resolve({ kind: 'blocked', reason: 'unavailable' } as const)
  return mutationResult(() => editArticleMedia(draft.id, draft.revision, key, edit, handle, signal), signal)
}

const updateSummary = (text: string) => (draft: Draft, signal: AbortSignal, idempotencyKey: string): Promise<DraftSave<Draft>> => {
  const handle = currentSession.value?.siteSessionId
  if (!handle || signal.aborted) return Promise.resolve({ kind: 'blocked', reason: 'unavailable' })
  return mutationResult(async () => {
    const stored = await saveDraftSummary({ id: draft.id, expectedRevision: draft.revision, idempotencyKey, text }, handle, signal)
    if (stored.title !== draft.title || stored.body !== draft.body) throw new Error('The summary reply changed the draft source.')
    return stored
  }, signal)
}

const publishImages = (assets: readonly string[]) => (draft: Draft, signal: AbortSignal, key: string): Promise<DraftSave<Draft>> => {
  const handle = currentSession.value?.siteSessionId
  if (!handle || signal.aborted) return Promise.resolve({ kind: 'blocked', reason: 'unavailable' })
  return mutationResult(() => publishArticleImages(draft.id, draft.revision, key, assets, handle, signal), signal)
}

const registry = new WorkspaceRegistry<Draft>({
  async load(articleId, signal) {
    const handle = currentSession.value?.siteSessionId
    if (!handle) return { kind: 'blocked', reason: 'unavailable' }
    try {
      const draft = await api.draft(articleId, signal, handle)
      if (signal.aborted || currentSession.value?.siteSessionId !== handle) return { kind: 'blocked', reason: 'unavailable' }
      return { kind: 'ready', draft }
    } catch (error) {
      return { kind: 'blocked', reason: signal.aborted ? 'unavailable' : await workspaceBlock(error, handle, signal) }
    }
  },
  save: send('save'),
  confirmed: recovery.confirmed,
})
const persistence = workspacePersistence(() => registry.savedLayout, () => registry.hasSecondaryGroup)
const { record: recordRecentOpen, changed: recentOpensVersion, notice: recentOpensNotice } = recentArticleOpens()
const layoutNotice = persistence.notice
const supportsSavedGroups = persistence.supportsGroups
const inspectorOpen = ref(false)
const workspaceState = { articleWorkspace: true }
const persistentWorkspace = ref(route.name === 'article-workspace' || history.state?.articleWorkspace === true)
let layoutStarted = false
let workspaceIdentity: number | undefined
let persistedSession: string | undefined
const unsubscribe = registry.subscribe(() => {
  const next = registry.activeDraft
  if (next?.id !== original.value?.id || next?.revision !== original.value?.revision) {
    taxonomyDirty.value = false
    summaryDirty.value = false
    taxonomyStale.value = false
  }
  original.value = next
  tab.value = registry.activeTab
  workspaceTabs.value = registry.tabs
  sourcePanes.value = registry.sourcePanes
  hasSecondaryGroup.value = registry.hasSecondaryGroup
  recentlyClosed.value = registry.recentlyClosed
  inspectorOpen.value = registry.inspectorOpen
  recovery.setCurrent(tab.value, next, registry.activeEditSequence)
  persistence.changed()
})
watch([twoSources, wideEditorArea, editable, () => comparisonTab.value?.sessionId, credential, identityEpoch, selectedLocations], async ([two, wide, ready, sessionId, handle], _, cleanup) => {
  comparisonReady.value = false
  const candidate = comparisonTab.value
  if (!two || !wide || !ready || !candidate || candidate.sessionId !== sessionId || !handle) return
  const controller = new AbortController()
  cleanup(() => controller.abort())
  const checked = await registry.recheckComparison(candidate, AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]))
  if (!controller.signal.aborted && checked) comparisonReady.value = true
})
watch([currentSession, identityEpoch], ([session, epoch]) => {
  const handle = session?.siteSessionId
  if (workspaceIdentity !== epoch || !session?.canAuthor) {
    persistence.reset()
    layoutStarted = false
    layoutRestoring.value = false
    persistedSession = handle
    workspaceIdentity = epoch
    registry.setIdentity(session?.canAuthor
      ? { site: location.origin, principalId: String(epoch), generation: session.generation, expiresAt: session.expiresAt }
      : null)
    return
  }
  registry.updateIdentityExpiry(session.expiresAt)
  if (handle && handle !== persistedSession) persistence.rebind(handle)
  persistedSession = handle
}, { immediate: true, flush: 'sync' })
watch([identityEpoch, () => currentSession.value?.canAuthor], ([epoch, author]) => {
  if (!author) recovery.close()
  else void recovery.attach(epoch, () => identityEpoch.value === epoch && currentSession.value?.canAuthor === true,
    () => currentSession.value?.siteSessionId)
}, { immediate: true })

onMounted(() => {
  void refreshSession(lifetime.signal, !sourceArrival).then(() => {
    sourceSessionVerified = true
  }).catch(() => {
    if (!lifetime.signal.aborted) failure.value = 'Could not verify your session.'
  }).finally(() => {
    if (!lifetime.signal.aborted) authorizationReady.value = true
  })
  window.addEventListener('beforeunload', onUnload)
  window.addEventListener('pagehide', flushWorkspace)
  window.addEventListener('offline', persistence.offline)
  document.addEventListener('visibilitychange', flushHiddenWorkspace)
})
onUnmounted(() => {
  lifetime.abort()
  recovery.close()
  persistence.reset()
  registry.setIdentity(null)
  unsubscribe()
  window.removeEventListener('beforeunload', onUnload)
  window.removeEventListener('pagehide', flushWorkspace)
  window.removeEventListener('offline', persistence.offline)
  document.removeEventListener('visibilitychange', flushHiddenWorkspace)
})
watch(identityEpoch, () => {
  ++navigation
  opening.value = false
  composing.value = undefined
  comparisonReady.value = false
  deferredFocus = undefined
  navigationNotice.value = ''
  groupNotice.value = ''
})
watch(credentialEpoch, () => {
  sourceSeek.value = undefined
  if (sourceArrival?.source?.kind === 'search') sourceArrival.source = undefined
}, { flush: 'sync' })
watch(id, () => {
  sourceArrival = undefined
  sourceSeek.value = undefined
}, { flush: 'sync' })
watch([recoveryItems, recoveryWorking, () => tab.value?.risk, propertyPending, metadataDirty, composing, closingTabs,
  revisionComparisonActive], ([items, recovering, risk, property, metadata, composition, closing, comparing]) => {
  if (sourceSeek.value?.kind === 'search' && (items.length > 0 || recovering || risk !== 'clean' || property || metadata ||
    composition !== undefined || closing || comparing)) {
    sourceSeek.value = undefined
    notice.value = searchPositionUnavailable
  }
}, { flush: 'sync' })

watch([id, identityEpoch, authorizationReady, reload, persistentWorkspace], async ([articleId, identity], _, cleanup) => {
  let valid = true
  cleanup(() => { valid = false })
  if (!authorizationReady.value || !currentSession.value?.canAuthor) {
    opening.value = false
    loading.value = false
    return
  }
  const handle = currentSession.value.siteSessionId
  if (persistentWorkspace.value && !layoutStarted && handle) {
    layoutStarted = true
    layoutRestoring.value = true
    loading.value = true
    await persistence.restore(handle, (layout, signal) => registry.restoreLayout(layout, signal))
    if (identity === identityEpoch.value) layoutRestoring.value = false
    if (!valid || identity !== identityEpoch.value) return
    if (articleId === undefined && tab.value) {
      await router.replace({ ...address(tab.value.articleId), state: workspaceState })
      if (!valid || identity !== identityEpoch.value) return
    }
  }
  if (articleId === undefined) {
    registry.idle()
    loading.value = false
    return
  }
  let source: EditorSourceTarget | undefined
  const epoch = credentialEpoch.value
  if (sourceArrival?.articleId === articleId) {
    if (!sourceArrival.source && sourceSessionVerified) {
      sourceArrival.source = acceptEditorSourceHandoff(sourceToken, articleId, epoch, handle)
      sourceArrival.epoch = epoch
    }
    source = sourceArrival.epoch === epoch ? sourceArrival.source : undefined
    if (!source) {
      failure.value = 'This editor link has expired. Return to its source and choose it again.'
      loading.value = false
      return
    }
  }
  if (!source && original.value?.id === articleId) {
    loading.value = false
    return
  }
  loading.value = true
  failure.value = ''
  notice.value = ''
  const routeIntent = navigation
  const current = () => valid && !lifetime.signal.aborted && epoch === credentialEpoch.value &&
    routeIntent === navigation && currentSession.value?.siteSessionId === handle
  const result = await activateArticle(articleId, undefined, undefined, source ? current : undefined, source?.target.revision)
  if (!valid || identity !== identityEpoch.value) return
  loading.value = false
  if (result.kind !== 'ready') {
    if (source?.kind === 'search') {
      if (sourceArrival) sourceArrival.source = undefined
      failure.value = result.kind === 'superseded' || result.kind === 'blocked' && result.reason === 'stale-reference'
        ? searchPositionUnavailable : activationFailure(result)
    } else {
      failure.value = source && result.kind === 'superseded' ? failureByReason['stale-reference'] : activationFailure(result)
    }
    return
  }
  if (!source) return
  sourceArrival = undefined
  const sessionId = result.tab.sessionId
  const revealBy = performance.now() + 6_000
  const held = () => current() && tab.value?.sessionId === sessionId && tab.value.risk === 'clean' &&
    !recoveryBlocked.value && performance.now() < revealBy
  if (source.kind === 'canvas' && source.target.sourceOffset !== null) {
    sourceSeek.value = { kind: 'canvas', sessionId, revision: source.target.revision, offset: source.target.sourceOffset, current: held }
  } else if (source.kind === 'search') {
    if (result.witnessedRevision !== source.target.revision || recoveryItems.value.length > 0) {
      notice.value = searchPositionUnavailable
      return
    }
    const edit = registry.activeEditSequence
    const target = source.target
    sourceSeek.value = { kind: 'search', sessionId, target, current: () => held() && canSwitch.value &&
      editable.value && !pending.value && !revisionComparisonActive.value && registry.activeEditSequence === edit &&
      original.value?.revision === target.revision && (currentSession.value?.expiresAt ?? 0) > Date.now() }
  }
}, { immediate: true })

function activateArticle(articleId: number, targetGroup?: WorkspaceGroup, mode?: WorkspaceTab['mode'], ready?: () => boolean,
  requiredRevision?: bigint) {
  return articleId === 0
    ? registry.startDraft({ id: 0, revision: 0n, title: '', body: '', published: false })
    : registry.openOrActivate(articleId, targetGroup, mode, ready, requiredRevision)
}

function finishSourceSeek(seek: EditorSourceSeek, success: boolean) {
  if (sourceSeek.value !== seek) return
  sourceSeek.value = undefined
  if (seek.kind === 'canvas') {
    if (!success) notice.value = 'The Canvas source position could not be opened. Resolve it again from the Canvas.'
    return
  }
  if (!success || !seek.current()) {
    notice.value = searchPositionUnavailable
    return
  }
  recordRecentOpen(seek.target.articleId, seek.target.revision)
  notice.value = 'Opened the search result at its saved position.'
}

function activationFailure(receipt: Activation): string {
  if (receipt.kind === 'blocked') return failureByReason[receipt.reason]
  if (receipt.kind === 'capacity') return 'This workspace has 100 open articles. Close a tab before opening another.'
  return ''
}

onBeforeRouteUpdate(async (to, from) => {
  if (to.path === from.path || !authorizationReady.value || !currentSession.value?.canAuthor) return true
  const intent = ++navigation
  registry.cancelOpening()
  opening.value = false
  if (!canSwitch.value) {
    navigationNotice.value = 'Apply or cancel the pending changes before switching articles.'
    return false
  }
  const articleId = articleRoute(to)
  navigationNotice.value = ''
  groupNotice.value = ''
  if (articleId === undefined) return true
  // A successful creation already has a verified persisted revision in the same session.
  if (articleId === tab.value?.articleId) return true
  const epoch = identityEpoch.value
  opening.value = true
  const explicit = explicitNavigation?.path === to.path ? explicitNavigation : undefined
  const result = await activateArticle(articleId, explicit?.targetGroup ?? explicit?.restore?.group, explicit?.restore?.mode,
    () => intent === navigation && epoch === identityEpoch.value && canSwitch.value && !lifetime.signal.aborted)
  if (intent !== navigation || epoch !== identityEpoch.value || lifetime.signal.aborted) return false
  opening.value = false
  navigationNotice.value = result.kind === 'superseded' && !canSwitch.value
    ? 'Apply or cancel the pending changes before switching articles.' : activationFailure(result)
  if (result.kind === 'ready') {
    if (explicit && result.witnessedRevision !== undefined)
      explicit.witness = { sessionId: result.tab.sessionId, articleRevision: result.witnessedRevision }
    notice.value = ''
    failure.value = result.tab.risk === 'conflict' ? 'The server has a newer revision. Copy your changes before loading it.' : ''
  }
  return result.kind === 'ready'
})

function address(articleId: number) {
  return articleId === 0 ? { name: 'write' } : { name: 'edit', params: { id: articleId } }
}

async function openSavedWorkspace() {
  const identity = identityEpoch.value
  if (!await allowLeave(true) || lifetime.signal.aborted || identity !== identityEpoch.value) return
  if (await router.replace({ name: 'article-workspace', state: workspaceState })) return
  if (lifetime.signal.aborted || identity !== identityEpoch.value) return
  registry.setIdentity(null)
  const session = currentSession.value
  if (!session?.canAuthor) return
  registry.setIdentity({ site: location.origin, principalId: String(identity),
    generation: session.generation, expiresAt: session.expiresAt })
  persistentWorkspace.value = true
}

async function navigateTo(articleId: number, restore?: RecentlyClosed, targetGroup?: WorkspaceGroup) {
  if (!canSwitch.value) return false
  if (registry.activeTab?.articleId === articleId && id.value === articleId) return true
  const destination = address(articleId)
  const intent: NavigationIntent = { restore, targetGroup, path: router.resolve(destination).path }
  const epoch = identityEpoch.value
  const handle = currentSession.value?.siteSessionId
  explicitNavigation = intent
  try {
    const failure = await router.push({ ...destination, state: persistentWorkspace.value ? workspaceState : undefined })
    const active = registry.activeTab
    if (failure || active?.articleId !== articleId || id.value !== articleId) return false
    if (explicitNavigation === intent && intent.witness && intent.witness.sessionId === active.sessionId &&
        epoch === identityEpoch.value && handle === currentSession.value?.siteSessionId)
      recordRecentOpen(articleId, intent.witness.articleRevision)
    return true
  }
  finally { if (explicitNavigation === intent) explicitNavigation = undefined }
}

function openArticle(otherGroup = false) {
  const articleId = inputArticle.value
  if (articleId === undefined) {
    navigationNotice.value = 'Enter a valid article ID.'
    return
  }
  const target = otherGroup ? tab.value?.group === 'secondary' ? 'main' : 'secondary' : undefined
  void navigateTo(articleId, undefined, target)
}

async function focusGroup(target: WorkspaceTab) {
  const epoch = identityEpoch.value
  deferredFocus = undefined
  if (!await navigateTo(target.articleId) || tab.value?.sessionId !== target.sessionId) return
  await focusSource(target, epoch)
}

async function focusSource(target: WorkspaceTab, epoch: number) {
  await nextTick()
  if (epoch !== identityEpoch.value || tab.value?.sessionId !== target.sessionId || !editable.value) return
  if (!recoveryBlocked.value && !pending.value && !metadataDirty.value) {
    document.getElementById('article-body')?.focus({ preventScroll: true })
    return
  }
  const pane = document.getElementById(`workspace-source-${target.sessionId}`)
  if (pane) {
    pane.focus({ preventScroll: true })
    deferredFocus = { sessionId: target.sessionId, epoch, pane }
  }
}

watch([recoveryBlocked, pending, metadataDirty, () => tab.value?.sessionId, editable], async ([blocked, writing, editingMetadata, sessionId, ready]) => {
  const request = deferredFocus
  if (!request) return
  if (sessionId !== request.sessionId || request.epoch !== identityEpoch.value) {
    deferredFocus = undefined
    return
  }
  if (blocked || writing || editingMetadata || !ready) return
  await nextTick()
  if (deferredFocus !== request) return
  deferredFocus = undefined
  if (document.activeElement === request.pane && tab.value?.sessionId === request.sessionId && editable.value)
    document.getElementById('article-body')?.focus({ preventScroll: true })
})

function arrangeGroups(destination?: WorkspaceGroup) {
  const current = tab.value
  if (!current || !canArrangeGroups.value) return
  const receipt = destination ? registry.moveActiveTab(current, destination, registry.revision) : registry.mergeGroups(current, registry.revision)
  if (receipt.kind !== 'changed') return
  groupNotice.value = destination
    ? `Moved the current article to the ${destination === 'main' ? 'primary' : 'secondary'} group.`
    : 'Merged both groups into the primary group.'
  deferredFocus = undefined
  void focusSource(receipt.tab, identityEpoch.value)
}

function setInspectorOpen(open: boolean) {
  if (persistentWorkspace.value && tab.value) registry.setInspectorOpen(tab.value, open)
}

const openAddress = computed(() => {
  const articleId = inputArticle.value
  return articleId === undefined ? undefined : address(articleId)
})
const inputArticle = computed(() => {
  const input = openInput.value.trim()
  const articleId = Number(input)
  return /^[1-9][0-9]{0,9}$/.test(input) && articleId <= 2_147_483_647
    ? articleId : undefined
})

function togglePin(target: WorkspaceTab) {
  if (target.mode === 'preview') registry.pin(target)
  else if (!registry.unpin(target)) navigationNotice.value = 'Save changes and close the current preview before unpinning this tab.'
}

const closeRiskLabel = {
  dirty: 'unsaved changes', saving: 'save in progress', conflict: 'save conflict',
  recovery: 'draft recovery', pending: 'pending change', blocked: 'unavailable',
} satisfies Record<Exclude<WorkspaceTab['risk'], 'clean'>, string>

async function saveAndCloseTabs(plan: ClosePlan, current: () => boolean) {
  const reservation = registry.reserveClose(plan, 'save')
  if (!reservation) return 'stale'
  const saved: string[] = []
  try {
    for (const { draft } of reservation.drafts) {
      const target = plan.tabs.find(tab => tab.articleId === draft.id)
      if (!target || !current() || !reservation.current()) return 'stale'
      const result = await registry.saveReserved(target, reservation)
      if (result.kind === 'saved') saved.push(target.title)
      if (result.kind === 'saved' && result.recoverySettled) continue
      const failure = result.kind === 'conflict' ? `${target.title} changed on the server. Reload its revision before saving.`
        : result.kind === 'saved' ? `Recovery cleanup for ${target.title} could not be confirmed.`
        : result.kind === 'rejected' ? `The server rejected changes to ${target.title}.`
        : result.kind === 'blocked' && result.reason !== 'unavailable' ? `Could not save ${target.title}. ${failureByReason[result.reason]}`
        : `Could not confirm the save for ${target.title}. Retry the same save from its tab.`
      return { message: `${saved.length ? `Saved ${saved.join(', ')}. ` : ''}${failure} The tabs are still open.` }
    }
    if (!current()) return 'stale'
    const result = registry.completeClose(reservation, true)
    if (result.kind === 'protected') return { message: `Saved ${saved.join(', ')}. The tabs are still open.` }
    return result.kind
  } finally {
    if (reservation.current()) registry.completeClose(reservation, false)
  }
}

async function confirmProtectedClose(plan: ClosePlan, current: () => boolean) {
  const drafts = registry.recoveryDraftsForClose(plan)
  const saveDrafts = drafts ?? registry.recoveryDraftsForClose(plan, true)
  const allSaved = plan.tabs.every(tab => tab.articleId > 0)
  const canSave = allSaved && !!saveDrafts?.length && plan.tabs.every(tab => tab.risk !== 'conflict') &&
    saveDrafts.every(({ draft }) => validDraftTitle(draft.title) && validDraftBody(draft.body))
  if (!drafts?.length && !canSave) return 'protected'
  const choice = ref<'keep' | 'discard' | 'save'>(drafts?.length ? 'keep' : 'save')
  const message = h(() => current() ? h('div', [
    h('ul', {
      'aria-label': 'Tabs to close', tabindex: 0,
      style: { maxBlockSize: 'min(40vh, 16rem)', overflowY: 'auto', overflowWrap: 'anywhere', paddingInlineStart: '1.5rem' },
    }, plan.tabs.map(({ title, risk, articleId, sessionId }) => h('li', { key: sessionId },
      `${title} (${risk === 'clean' ? 'up to date' : closeRiskLabel[risk]})${articleId ? ` · Article ${articleId}` : ''}`))),
    h(ElRadioGroup, {
      modelValue: choice.value, label: 'Unsaved edits',
      style: { display: 'grid', justifyItems: 'start' },
      'onUpdate:modelValue': (value: unknown) => {
        if (value === 'keep' || value === 'discard' || value === 'save') choice.value = value
      },
    }, { default: () => [
      drafts?.length ? h(ElRadio, { value: 'keep' }, () => 'Keep browser recovery copies') : null,
      canSave ? h(ElRadio, { value: 'save' }, () => 'Save drafts before closing') : null,
      allSaved && drafts?.length ? h(ElRadio, { value: 'discard' }, () => 'Discard unsaved edits from this browser') : null,
    ] }),
  ]) : h('p', 'The workspace changed while this confirmation was open.'))
  closingTabs.value = true
  try {
    const consent = await ElMessageBox.confirm(
      message, 'Close tabs with unsaved edits?', {
        type: 'warning', confirmButtonText: 'Close tabs', cancelButtonText: 'Keep writing', closeOnClickModal: false,
      })
    if (!consent.ok) return 'cancelled'
    if (!current() || registry.revision !== plan.revision) return 'stale'
    if (choice.value === 'save') return canSave ? await saveAndCloseTabs(plan, current) : 'protected'
    if (choice.value === 'discard') {
      const reservation = registry.reserveClose(plan, 'discard')
      if (!reservation) return 'stale'
      const committed = await recovery.discardCloseCopies(reservation)
      const result = registry.completeClose(reservation, committed)
      return committed || result.kind === 'stale' ? result.kind : 'discard-unavailable'
    }
    if (!drafts?.length || !await recovery.verifyCloseCopies(drafts)) return 'copies-unavailable'
    return current() ? registry.discardMany(plan).kind : 'stale'
  } catch {
    return 'cancelled'
  } finally {
    closingTabs.value = false
  }
}

function failedCloseNotice(outcome: Awaited<ReturnType<typeof confirmProtectedClose>>, plan?: ClosePlan) {
  const blocked = plan?.tabs.flatMap(({ title, risk }) => risk === 'clean' ? [] : [`${title} (${closeRiskLabel[risk]})`]) ?? []
  return typeof outcome === 'object' ? outcome.message
    : outcome === 'protected' ? `Could not close tabs. ${blocked.join(', ')}.`
    : outcome === 'copies-unavailable' ? 'Could not verify recovery copies. Save the drafts before closing these tabs.'
    : outcome === 'discard-unavailable' ? 'Could not discard the recovery copies. The tabs are still open.'
    : outcome === 'stale' ? 'Tabs changed before closing. Try again.' : ''
}

async function closeGroupTabs(event: MouseEvent, onlyRight: boolean) {
  const current = registry.activeTab
  const index = activeGroupIndex.value
  const groupTabs = activeGroupTabs.value
  if (!current || !canCloseGroupTabs.value || groupTabs[index]?.sessionId !== current.sessionId) return
  const targets = onlyRight ? groupTabs.slice(index + 1) : groupTabs.filter(candidate => !candidate.active)
  if (targets.length === 0) return
  const focused = event.currentTarget
  const epoch = identityEpoch.value
  const path = route.path
  const isCurrent = () => epoch === identityEpoch.value && !lifetime.signal.aborted &&
    route.path === path && registry.activeTab?.sessionId === current.sessionId
  const plan = registry.planClose(targets)
  const result = plan ? registry.applyClose(plan).kind : 'stale'
  const outcome = plan && result === 'protected' ? await confirmProtectedClose(plan, isCurrent) : result
  if (!isCurrent()) return
  if (outcome !== 'closed') {
    groupNotice.value = ''
    navigationNotice.value = failedCloseNotice(outcome, plan)
    await nextTick()
    if (isCurrent() && focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true })
    return
  }
  navigationNotice.value = ''
  groupNotice.value = targets.length === 1 ? 'Closed 1 tab.' : `Closed ${targets.length} tabs.`
  await nextTick()
  if (isCurrent()) tabsControl.value?.focusActive()
}

async function closeTab(target: WorkspaceTab) {
  if (closingTabs.value || target.active && !canSwitch.value) {
    navigationNotice.value = 'Apply or cancel the pending changes before closing this tab.'
    return
  }
  const focused = document.activeElement
  const epoch = identityEpoch.value
  const path = route.path
  const active = registry.activeTab?.sessionId
  const samePage = () => epoch === identityEpoch.value && !lifetime.signal.aborted && route.path === path
  const isCurrent = () => samePage() && registry.activeTab?.sessionId === active
  async function restoreFocus() {
    await nextTick()
    if (!samePage()) return
    if (focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true })
    else tabsControl.value?.focusActive()
  }

  navigationNotice.value = ''
  const plan = registry.planClose([target])
  if (!plan) return
  const ready = registry.applyClose(plan)
  if (ready.kind === 'stale') return
  if (ready.kind === 'protected') {
    if (target.risk === 'saving' || target.risk === 'pending' || (target.risk === 'recovery' &&
        (target.articleId === 0 || target.retry !== 'save'))) {
      navigationNotice.value = 'Resolve the pending changes before closing this tab.'
      return
    }
    if (target.articleId > 0 && target.risk !== 'blocked') {
      const outcome = await confirmProtectedClose(plan, isCurrent)
      if (!samePage()) return
      if (outcome !== 'closed') {
        navigationNotice.value = failedCloseNotice(outcome, plan)
        await restoreFocus()
        return
      }
    } else {
      const edit = registry.editSequence(target)
      try {
        const outcome = await ElMessageBox.confirm(`Discard changes to ${target.title} and close its tab?`, 'Close article tab?', {
          type: 'warning', confirmButtonText: 'Discard changes', cancelButtonText: 'Keep writing', closeOnClickModal: false,
        })
        if (!outcome.ok || !isCurrent() || registry.discard(target, plan.revision).kind !== 'closed') {
          await restoreFocus()
          return
        }
        if (edit !== undefined) await recovery.discardArticle(target.articleId, target.sessionId, edit)
      } catch {
        await restoreFocus()
        return
      }
    }
  }
  if (!samePage()) return
  if (target.active) {
    const next = workspaceTabs.value.find(candidate => candidate.risk !== 'blocked' && candidate.risk !== 'saving')
    const state = persistentWorkspace.value ? workspaceState : undefined
    const rejected = await router.replace({ ...(next ? address(next.articleId) : { name: 'article-workspace' }), state })
    if (rejected && !registry.activeTab) await router.replace({ name: 'article-workspace', state })
  }
  await nextTick()
  if (registry.activeTab) tabsControl.value?.focusActive()
  else articleInput.value?.focus()
}

function onUnload(event: BeforeUnloadEvent) {
  if (dirty.value || pending.value || retry.value || workspaceTabs.value.some(item => item.risk !== 'clean' && item.risk !== 'blocked')) event.preventDefault()
}

function flushWorkspace() {
  void persistence.flush()
}

function flushHiddenWorkspace() {
  if (document.visibilityState === 'hidden') flushWorkspace()
}

async function allowLeave(allTabs = false) {
  if (propertyPending.value || closingTabs.value) return false
  const candidates = (allTabs ? workspaceTabs.value : tab.value ? [tab.value] : [])
    .filter(item => item.risk !== 'clean' || item.active && metadataDirty.value)
  if (!candidates.length) return true
  if (candidates.some(item => item.risk === 'saving' || item.risk === 'pending' || item.retry)) return false
  const plan = registry.planClose(candidates)
  if (!plan) return false
  const edits = candidates.map(item => ({ item, sequence: registry.editSequence(item) }))
  try {
    const message = candidates.length === 1
      ? 'Your changes will be lost if you leave this page.'
      : `Unsaved changes in ${candidates.map(item => item.title).join(', ')} will be discarded.`
    const outcome = await ElMessageBox.confirm(message, 'Discard unsaved changes?', {
      type: 'warning',
      confirmButtonText: 'Discard changes',
      cancelButtonText: 'Keep writing',
      closeOnClickModal: false,
    })
    if (!outcome.ok || registry.discardMany(plan).kind !== 'closed') return false
    await Promise.all(edits.map(({ item, sequence }) => sequence === undefined ? undefined
      : recovery.discardArticle(item.articleId, item.sessionId, sequence)))
    return true
  } catch {
    return false
  }
}
onBeforeRouteLeave(async () => {
  ++navigation
  registry.cancelOpening()
  opening.value = false
  if (!await allowLeave(true)) return false
  await persistence.flush()
  return true
})

function edit(pane: WorkspaceSource<Draft>, field: 'title' | 'body', value: string) {
  const document = original.value
  const current = tab.value
  if (paneFocused(pane) && !closingTabs.value && !recoveryBlocked.value && !metadataDirty.value && !propertyPending.value
      && current && document && document[field] !== value) {
    const next = { ...document, [field]: value }
    if (registry.updateDraft(current, next)) recovery.persist(next, registry.activeEditSequence)
  }
}

async function restoreDraft(candidate: RecoveryCandidate) {
  const current = tab.value
  const document = original.value
  if (!current || !document || current.risk !== 'clean' || pending.value || recoveryWorking.value ||
      !recoveryItems.value.includes(candidate)) return
  const restored = { ...document, title: candidate.title, body: candidate.body }
  recoveryWorking.value = true
  try {
    if (registry.updateDraft(current, restored)) {
      if (!await recovery.remove(candidate, { draft: restored, edit: registry.activeEditSequence })) {
        recovery.dismissCandidates()
      }
    }
  } finally {
    recoveryWorking.value = false
  }
}

async function submit(action: Action, selection?: TaxonomySelection, restore?: RestoreSelection, due?: bigint, rights?: RightsEdit,
  media?: AttachmentEdit) {
  const current = tab.value
  const document = original.value
  const siteSession = currentSession.value?.siteSessionId
  if (!current || !document || !editable.value || closingTabs.value || pending.value || recoveryBlocked.value) return
  if (current.retry) {
    if (action !== current.retry) return
  } else if (action === 'publish-images' || action === 'save-summary') {
    return
  } else if (action === 'assign-taxonomy') {
    if (!selection || current.risk !== 'clean' || taxonomyStale.value || !taxonomyDirty.value || summaryDirty.value) return
  } else if (action === 'rollback-history') {
    if (!restore || current.risk !== 'clean' || cannotWrite.value) return
  } else if (action === 'schedule-publication') {
    if (due === undefined || current.risk !== 'clean' || cannotWrite.value) return
  } else if (action === 'save-rights') {
    if (!rights || current.risk !== 'clean' || cannotWrite.value) return
  } else if (action === 'save-attachment') {
    if (!media || !siteSession || current.risk !== 'clean' || cannotWrite.value) return
  } else if (cannotWrite.value || action === 'publish' && !document.body.trim()) {
    return
  }

  failure.value = ''
  notice.value = ''
  const identity = identityEpoch.value
  const requested = current.retry
    ? registry.retry(current)
    : action === 'save'
      ? registry.save(current)
      : action === 'publish' || action === 'retract'
        ? registry.commit(current, action, send(action))
        : action === 'assign-taxonomy' && selection
          ? registry.commit(current, action, saveTaxonomy(selection))
          : action === 'rollback-history' && restore
            ? registry.commit(current, action, restoreRevision(restore))
            : action === 'schedule-publication' && due !== undefined
              ? registry.commit(current, action, updateSchedule(due))
              : action === 'save-rights' && rights
                ? registry.commit(current, action, updateRights(rights))
                : action === 'save-attachment' && media && siteSession
                  ? registry.commit(current, action, updateAttachment(media)) : undefined
  if (!requested) return
  await finishSubmission(action, current, document, identity, requested)
}

async function publishSelectedImages(selection: PublishImagesSelection) {
  const current = tab.value
  const document = original.value
  if (!current || !document || !canPublishImages.value || selection.articleId !== document.id ||
      selection.revision !== document.revision || selection.credential !== credential.value) return
  failure.value = ''
  notice.value = ''
  const identity = identityEpoch.value
  const requested = registry.commit(current, 'publish-images', publishImages(selection.assets.slice()))
  await finishSubmission('publish-images', current, document, identity, requested)
}

async function saveSummary(edit: DraftSummaryEdit) {
  const current = tab.value
  const document = original.value
  if (!current || !document || !canChangeSummary.value || !summaryDirty.value ||
      edit.articleId !== document.id || edit.revision !== document.revision || edit.credential !== credential.value) return
  failure.value = ''
  notice.value = ''
  const identity = identityEpoch.value
  const requested = registry.commit(current, 'save-summary', updateSummary(edit.text))
  await finishSubmission('save-summary', current, document, identity, requested)
}

async function finishSubmission(action: Action, current: WorkspaceTab, document: Draft, identity: number,
  requested: ReturnType<typeof registry.retry>) {
  const result = await requested
  if (lifetime.signal.aborted || identity !== identityEpoch.value || id.value !== current.articleId) return
  if (result.kind === 'saved') {
    if (result.recoverySettled === false) {
      failure.value = 'Draft saved. Recovery cleanup is unfinished. Try again.'
      return
    }
    notice.value = {
      save: 'Draft saved.', publish: 'Article published.', retract: 'Article withdrawn.',
      'publish-images': 'Article and selected images published.',
      'assign-taxonomy': 'Classification saved.', 'rollback-history': 'Revision restored to a new draft.',
      'schedule-publication': 'Publication schedule updated.',
      'save-rights': 'Publication rights saved.',
      'save-attachment': 'Private attachments saved.',
      'save-summary': 'Summary saved.',
    }[action]
    if (!document.id) await router.replace({ ...address(result.articleId), state: persistentWorkspace.value ? workspaceState : undefined })
  } else if (result.kind === 'conflict') {
    failure.value = 'The server has a newer revision. Copy your changes before loading it.'
  } else if (result.kind === 'blocked') {
    failure.value = failureByReason[result.reason]
  } else if (result.kind === 'rejected') {
    failure.value = 'The server rejected this change. Check the draft and try again.'
  }
}

async function reloadDraft() {
  if (!await allowLeave()) return
  const current = tab.value
  if (current) registry.requestClose(current)
  reload.value++
}
</script>

<template>
  <main class="editor-page">
    <header class="editor-header">
      <div>
        <RouterLink class="editor-back" to="/">Back</RouterLink>
        <RouterLink v-if="currentSession?.canAuthor" class="canvas-entry" to="/user/manage/canvas">Canvases</RouterLink>
        <h1>{{ id === undefined ? 'Article workspace' : id === 0 ? 'New article' : 'Edit article' }}</h1>
        <span v-if="editable" class="metadata">{{ original?.published ? 'Published' : 'Draft' }}</span>
      </div>
      <div v-if="editable" class="editor-actions">
        <ElButton v-if="retry" type="primary" :disabled="closingTabs || pending" @click="submit(retry)">Try again</ElButton>
        <ElButton v-else native-type="button" :disabled="cannotWrite || !articleDirty" @click="submit('save')">Save draft</ElButton>
        <ElButton
          v-if="!retry" native-type="button" :type="original?.published ? 'default' : 'primary'"
          :disabled="cannotWrite || dirty || id === 0 || !original?.body.trim()"
          @click="submit('publish')"
        >
          {{ original?.published ? 'Publish revision' : 'Publish article' }}
        </ElButton>
        <ElButton v-if="original?.published && !retry" native-type="button" :disabled="cannotWrite || dirty" @click="submit('retract')">Withdraw</ElButton>
      </div>
    </header>
    <section v-if="authorizationReady && currentSession?.canAuthor" class="workspace-actions" aria-label="Article workspace">
      <WorkspaceTabs ref="tabsControl" :tabs="workspaceTabs" :disabled="!canSwitch"
        @activate="navigateTo($event.articleId)" @pin="togglePin" @close="closeTab" />
      <form class="workspace-open" @submit.prevent="openArticle()">
        <label for="workspace-article-id">Article ID</label>
        <ElInput id="workspace-article-id" ref="articleInput" v-model="openInput" class="workspace-open-field"
          :disabled="!canSwitch" />
        <ElButton native-type="submit" :disabled="!canSwitch">Open article</ElButton>
        <ElButton v-if="tab" native-type="button" :disabled="!canSwitch || inputArticle === undefined"
          @click="openArticle(true)">Open in other group</ElButton>
        <RouterLink v-if="openAddress" :to="openAddress" target="_blank" rel="noopener">Open in browser tab</RouterLink>
        <RouterLink :to="{ name: 'write', state: persistentWorkspace ? workspaceState : undefined }">New draft</RouterLink>
        <ElButton v-if="!persistentWorkspace && id !== undefined" text native-type="button" :disabled="!canSwitch" @click="openSavedWorkspace">Open saved workspace</ElButton>
      </form>
      <div v-if="twoSources && !showComparison" class="workspace-groups" role="group" aria-label="Article groups">
        <ElButton v-for="pane in selectedPanes" :key="pane.tab.sessionId" text native-type="button"
          :disabled="!canSwitch || pane.tab.active" @click="focusGroup(pane.tab)">
          {{ pane.tab.group === 'main' ? 'Focus primary group' : 'Focus secondary group' }}
        </ElButton>
      </div>
      <details v-if="tab && (hasSecondaryGroup || activeGroupTabs.length > 1)" class="workspace-group-actions">
        <summary>{{ hasSecondaryGroup ? 'Group actions' : 'Tab actions' }}</summary>
        <div>
          <template v-if="hasSecondaryGroup">
            <ElButton text native-type="button" :disabled="!canArrangeGroups || tab.group === 'main'"
              @click="arrangeGroups('main')">Move to primary group</ElButton>
            <ElButton text native-type="button" :disabled="!canArrangeGroups || tab.group === 'secondary'"
              @click="arrangeGroups('secondary')">Move to secondary group</ElButton>
            <ElButton text native-type="button" :disabled="!canArrangeGroups" @click="arrangeGroups()">Merge groups</ElButton>
          </template>
          <template v-if="activeGroupTabs.length > 1">
            <ElButton text native-type="button" :disabled="!canCloseGroupTabs"
              @click="closeGroupTabs($event, false)">Close other tabs</ElButton>
            <ElButton text native-type="button" :disabled="!canCloseGroupTabs || activeGroupIndex === activeGroupTabs.length - 1"
              @click="closeGroupTabs($event, true)">Close tabs to the right</ElButton>
          </template>
        </div>
      </details>
      <ArticleLibraryRail :article-id="tab?.articleId" :article-revision="original?.revision" :recent-opens-version="recentOpensVersion"
        :disabled="!canSwitch" :activate="navigateTo" />
      <details v-if="recentlyClosed.length">
        <summary>Recently closed</summary>
        <ul>
          <li v-for="item in recentlyClosed" :key="item.articleId">
            <ElButton text native-type="button" :disabled="!canSwitch" @click="navigateTo(item.articleId, item)">
              Reopen {{ item.title }}
            </ElButton>
          </li>
        </ul>
      </details>
      <p v-if="opening" role="status">Opening article…</p>
      <p v-if="groupNotice" role="status">{{ groupNotice }}</p>
      <p v-if="navigationNotice" role="alert">{{ navigationNotice }}</p>
      <p v-if="layoutNotice" role="status">{{ layoutNotice }}</p>
      <p v-if="hasSecondaryGroup && persistentWorkspace && !supportsSavedGroups" role="status">The second group stays open in this browser tab.</p>
      <p v-if="recentOpensNotice" role="status">{{ recentOpensNotice }}</p>
    </section>
    <p v-if="!authorizationReady || loading" role="status">Opening the editor…</p>
    <template v-else-if="!currentSession?.canAuthor">
      <ElAlert :title="failure || 'Log in with an author account to write an article.'" type="info" :closable="false" />
      <p><RouterLink :to="{ name: 'login' }">Log in</RouterLink></p>
    </template>
    <p v-else-if="id === undefined" role="status">Open an article or start a new draft.</p>
    <template v-else-if="!editable">
      <ElAlert :title="failure" type="error" :closable="false" />
      <ElButton class="retry" @click="reload++">Retry</ElButton>
    </template>
    <section v-if="authorizationReady && currentSession?.canAuthor && sourcePanes.length" v-show="editable"
      id="workspace-editor" class="editor-document" role="tabpanel" :aria-label="selectedPanelTitle">
      <div ref="editorArea" class="editor-source" :class="{ 'editor-source--split': showComparison }">
        <WorkspaceSourcePane v-for="pane in sourcePanes" :key="pane.tab.sessionId" :pane="pane" :focus="paneFocused(pane)"
          :concealed="!pane.selected || (!pane.tab.active && !showComparison)"
          :blocked="closingTabs || pending || metadataDirty || recoveryBlocked" :split="hasSecondaryGroup" :can-switch="canSwitch"
          :source-target="sourceSeek?.sessionId === pane.tab.sessionId ? sourceSeek : undefined" @source-revealed="finishSourceSeek"
          @edit="(field, value) => edit(pane, field, value)" @activate="focusGroup(pane.tab)" @compose="changeComposition(pane, $event)">
          <template #before>
            <template v-if="paneFocused(pane)">
              <p v-if="notice" class="write-notice" role="status">
                {{ notice }} <RouterLink v-if="publishedPath" :to="publishedPath">Read the published article</RouterLink>
              </p>
              <ElAlert v-if="failure" :title="failure" type="error" :closable="false" show-icon />
              <ElButton v-if="hasConflict" class="retry" @click="reloadDraft">Load latest revision</ElButton>
              <p v-if="recoveryChecking" role="status">Checking local draft recovery…</p>
            </template>
          </template>
          <template #after>
            <template v-if="paneFocused(pane)">
              <p v-if="recoveryFailure" role="status">Local draft recovery is unavailable. Save to keep your changes on the server.</p>
              <section v-if="recoveryItems.length" aria-labelledby="draft-recovery-title">
                <h2 id="draft-recovery-title">Recover an unsaved draft</h2>
                <p>Unsaved text is stored in this browser for up to seven days. It is not encrypted.</p>
                <div v-for="item in recoveryItems" :key="`${item.writer}-${item.editSequence}`">
                  <h3>{{ item.title || 'Untitled draft' }}</h3>
                  <p v-if="item.relationship === 'compare'">This recovery copy and the server draft have different revisions.</p>
                  <details>
                    <summary>Compare drafts</summary>
                    <h4>Server draft</h4><pre>{{ original?.body }}</pre>
                    <h4>Recovery copy</h4><pre>{{ item.body }}</pre>
                  </details>
                  <ElButton native-type="button" :disabled="pending || recoveryWorking || articleDirty" @click="restoreDraft(item)">Restore draft</ElButton>
                  <ElButton native-type="button" :disabled="pending || recoveryWorking" @click="recovery.remove(item)">Discard recovery copy</ElButton>
                </div>
              </section>
              <p v-if="!validBody" role="alert">The article exceeds the size limit.</p>
            </template>
          </template>
        </WorkspaceSourcePane>
      </div>
      <EditorInspector v-if="original && original.id > 0" :nested-modal-active="revisionComparisonActive"
        :opened="persistentWorkspace ? inspectorOpen : undefined" @update:opened="setInspectorOpen">
        <MarkdownExportControl :article="original.id" :revision="original.revision" :selected="original.revision"
          :disabled="pending || hasConflict" />
        <MarkdownExportControl :article="original.id" :revision="original.revision" :selected="original.revision"
          :disabled="pending || hasConflict" format="docx" />
        <MarkdownExportControl :article="original.id" :revision="original.revision" :selected="original.revision"
          :disabled="pending || hasConflict" format="html" />
        <MarkdownExportControl :article="original.id" :revision="original.revision" :selected="original.revision"
          :disabled="pending || hasConflict" format="epub" />
        <MarkdownExportControl :article="original.id" :revision="original.revision" :selected="original.revision"
          :disabled="pending || hasConflict" format="pdf" />
        <ArticleMedia :article-id="original.id" :revision="original.revision"
          :credential="credential" :can-publish="canPublishImages"
          :can-change="!!currentSession?.siteSessionId && !dirty && !pending && !recoveryBlocked && !retry && !hasConflict"
          @save="submit('save-attachment', undefined, undefined, undefined, undefined, $event)" @publish-images="publishSelectedImages" />
        <ArticleTaxonomy
          :article-id="original.id"
          :revision="original.revision"
          :identity="identityEpoch"
          :disabled="articleDirty || summaryDirty || pending || recoveryBlocked || !!retry || hasConflict"
          @change="taxonomyDirty = $event"
          @save="submit('assign-taxonomy', $event)"
          @stale="taxonomyStale = true"
        />
        <ArticleProperties
          :article-id="original.id"
          :revision="original.revision"
          :identity="identityEpoch"
          :disabled="articleDirty || metadataDirty || articlePending || recoveryBlocked || !!retry || hasConflict"
          @pending="propertyPending = $event"
        />
        <RevisionHistory
          :key="identityEpoch"
          :article-id="original.id"
          :revision="original.revision"
          :can-rollback="editable && !dirty && !pending && !recoveryBlocked && !retry && !hasConflict"
          @restore="submit('rollback-history', undefined, $event)"
          @comparison-modal="revisionComparisonActive = $event"
        />
        <ArticleSchedule
          :key="`schedule-${identityEpoch}`"
          :article-id="original.id"
          :revision="original.revision"
          :can-change="editable && !dirty && !pending && !recoveryBlocked && !retry && !hasConflict"
          @schedule="submit('schedule-publication', undefined, undefined, $event)"
        />
        <ArticleRights
          :key="`rights-${identityEpoch}`"
          :article-id="original.id"
          :revision="original.revision"
          :can-change="editable && !dirty && !pending && !recoveryBlocked && !retry && !hasConflict"
          @save="submit('save-rights', undefined, undefined, undefined, $event)"
        />
        <ArticleSummary :article-id="original.id" :revision="original.revision" :credential="credential"
          :can-change="canChangeSummary" :saving="articlePending && summaryDirty"
          @change="summaryDirty = $event" @save="saveSummary" />
      </EditorInspector>
    </section>
  </main>
</template>

<style scoped>
.canvas-entry { margin-inline-start: .75rem; }
.workspace-actions {
  margin-block: .75rem 1rem;
}
.workspace-open {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: .5rem;
  margin-block: .5rem;
}
.workspace-open-field {
  max-inline-size: min(100%, 12rem);
}
.workspace-actions summary {
  cursor: pointer;
}
.workspace-groups, .workspace-group-actions > div { display: flex; flex-wrap: wrap; gap: .5rem; }
.workspace-group-actions { margin-block: .5rem; }
.editor-document {
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas: "source" "launcher";
}
.editor-source {
  grid-area: source;
  display: grid;
  gap: .5rem;
  min-inline-size: 0;
}
.editor-source--split { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: var(--fsus-space-4); }
.editor-source--split :deep(.workspace-source__heading) { min-block-size: var(--fsus-control-height-action); }
.editor-source--split > .workspace-source { grid-row: 1; grid-column: 1; }
.editor-source--split > .workspace-source--secondary { grid-column: 2; border-inline-start: 1px solid var(--fsus-border); padding-inline-start: .75rem; }
@media (min-width: 1024px) {
  .editor-document:has(> .inspector-launcher[aria-expanded="true"]) {
    grid-template-columns: minmax(0, 1fr) minmax(18rem, 36%);
    grid-template-areas: "source pane" "launcher pane";
    align-items: start;
    column-gap: var(--fsus-space-4);
  }
}
</style>
