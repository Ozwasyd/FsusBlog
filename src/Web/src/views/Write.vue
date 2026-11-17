<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { computed, h, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, RouterLink, useRoute, useRouter, type RouteLocationNormalized } from 'vue-router'
import { ElAlert, ElButton, ElInput, ElMessageBox, ElRadio, ElRadioGroup } from '@ozwasyd/element-plus'
import { api, ApiError, type Draft } from '../../../Contracts/client'
import { assignTaxonomy, type TaxonomySelection } from '../../../Contracts/taxonomy-client'
import { rollbackDraft } from '../../../Contracts/revision-history'
import { setArticleSchedule } from '../../../Contracts/article-schedule'
import { setDraftRights, type RightsEdit } from '../../../Contracts/article-rights'
import { saveDraftSummary, type DraftSummaryEdit } from '../../../Contracts/article-summary-client'
import { saveWithBodyEdits, saveWithBodyInsertion, saveWithBodyInsertions, type BodyEdit } from '../../../Contracts/article-body-insertion'
import { editArticleMedia, type AttachmentEdit } from '../../../Contracts/article-media'
import { publishArticleImages, type PublishImagesSelection } from '../../../Contracts/published-media'
import ArticleTaxonomy from './ArticleTaxonomy.vue'
import ArticleProperties from './ArticleProperties.vue'
import WorkspaceTabs from '../authoring/WorkspaceTabs.vue'
import WorkspaceSourcePane from '../authoring/WorkspaceSourcePane.vue'
import ArticleLibraryRail from '../authoring/ArticleLibraryRail.vue'
import ArticleQuickSwitcher from '../authoring/ArticleQuickSwitcher.vue'
import EditorInspector from '../authoring/EditorInspector.vue'
import AuthorPluginPreview from '../authoring/AuthorPluginPreview.vue'
import RevisionHistory from '../authoring/RevisionHistory.vue'
import ArticleSchedule from '../authoring/ArticleSchedule.vue'
import ArticleRights from '../authoring/ArticleRights.vue'
import ArticleSummary from '../authoring/ArticleSummary.vue'
import ArticleMedia from '../authoring/ArticleMedia.vue'
import MarkdownExportControl from '../authoring/MarkdownExportControl.vue'
import DocumentExportTasks from '../authoring/DocumentExportTasks.vue'
import DraftMarkdownImport from '../authoring/DraftMarkdownImport.vue'
import { normalizeDraftTitle, validDraftBody, validDraftTitle, type DraftMarkdown } from '../authoring/draftMarkdownImport'
import { editorRecovery } from '../authoring/editorRecovery'
import { workspacePersistence } from '../authoring/workspacePersistence'
import { recentArticleOpens } from '../authoring/recentArticleOpens'
import {
  acceptEditorSourceHandoff, editorSourceHandoffKey, type EditorSourceSeek, type EditorSourceTarget,
  type HistoricalSearchSeek, type PropertySearchSeek,
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
const sourceInspectorPending = ref(sourceToken !== undefined)
const sourceSeek = shallowRef<EditorSourceSeek>()
const historicalSeek = shallowRef<HistoricalSearchSeek>()
const propertySeek = shallowRef<PropertySearchSeek>()
const summarySeek = computed(() => {
  const seek = sourceSeek.value
  if (seek?.kind === 'search' && seek.target.field === 'summary') return seek
})
const searchPositionUnavailable: MessageKey = 'author.write.theSearchPositionIsNoLongerAvailableReturn'
const workspaceTabs = shallowRef<readonly WorkspaceTab[]>([])
const workspaceRevision = ref(0)
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
type ArticleSelection = { revision: bigint; current: () => boolean }
type NavigationIntent = {
  path: string
  restore?: RecentlyClosed
  targetGroup?: WorkspaceGroup
  selection?: ArticleSelection
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
const summaryEditor = shallowRef<InstanceType<typeof ArticleSummary>>()
const taxonomyEditor = shallowRef<InstanceType<typeof ArticleTaxonomy>>()
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
const selectedPanelTitle = computed(() => tab.value?.title ? t('author.write.contentTitle', { title: tab.value.title }) : t('author.write.articleContent'))
const articleDirty = computed(() => tab.value?.risk === 'dirty' || tab.value?.risk === 'conflict')
const dirty = computed(() => articleDirty.value || metadataDirty.value)
const hasConflict = computed(() => taxonomyStale.value || tab.value?.risk === 'conflict')
const articlePending = computed(() => tab.value?.risk === 'saving')
const pending = computed(() => articlePending.value || propertyPending.value)
const canSwitch = computed(() => !layoutRestoring.value && !propertyPending.value && !metadataDirty.value && !recoveryWorking.value &&
  !closingTabs.value && composing.value === undefined && !(articlePending.value && tab.value?.articleId === 0))
const retry = computed(() => tab.value?.retry)
const validTitle = computed(() => validDraftTitle(original.value?.title ?? ''))
const validBody = computed(() => validDraftBody(original.value?.body ?? ''))
const editable = computed(() => Boolean(currentSession.value?.canAuthor && original.value?.id === id.value && !loading.value))
const cannotWrite = computed(() => closingTabs.value || pending.value || recoveryBlocked.value || hasConflict.value ||
  metadataDirty.value || !validBody.value || !validTitle.value)
const publishedPath = computed(() => original.value?.published ? `/article/${original.value.id}` : '')
const minimumEditorWidthRem = 29
const splitterWidthRem = 1
const editorArea = ref<HTMLElement>()
const splitter = ref<HTMLElement>()
const editorMeasure = shallowRef({ width: 0, rem: 16 })
const preferredPrimaryWidth = ref(50)
const comparisonReady = ref(false)
const selectedPanes = computed(() => sourcePanes.value.filter(pane => pane.selected))
const twoSources = computed(() => selectedPanes.value.length === 2)
const trackWidth = computed(() => editorMeasure.value.width - splitterWidthRem * editorMeasure.value.rem)
const minimumShare = computed(() => trackWidth.value > 0
  ? Math.max(30, Math.ceil(100 * minimumEditorWidthRem * editorMeasure.value.rem / trackWidth.value)) : 100)
const wideEditorArea = computed(() => minimumShare.value <= 50)
const primaryWidth = computed(() => Math.max(minimumShare.value, Math.min(100 - minimumShare.value, preferredPrimaryWidth.value)))
const showComparison = computed(() => twoSources.value && wideEditorArea.value && comparisonReady.value)
const splitColumns = computed(() => showComparison.value
  ? `minmax(0, ${primaryWidth.value}fr) ${splitterWidthRem}rem minmax(0, ${100 - primaryWidth.value}fr)` : undefined)
const primaryPane = computed(() => selectedPanes.value.find(pane => pane.tab.group === 'main')?.tab)
const comparisonTab = computed(() => selectedPanes.value.find(pane => !pane.tab.active)?.tab)
const selectedLocations = computed(() => selectedPanes.value.map(pane => `${pane.tab.sessionId}:${pane.tab.group}`).join(','))
const credential = computed(() => currentSession.value?.siteSessionId)
const canImportDraft = computed(() => !!credential.value && editable.value && canSwitch.value && !opening.value &&
  !pending.value && !recoveryBlocked.value && !hasConflict.value && !retry.value && tab.value?.risk === 'clean' &&
  original.value?.id === 0 && original.value.title === '' && original.value.body === '')
const canPreviewPlugin = computed(() => !!credential.value && editable.value && canSwitch.value && !opening.value &&
  !pending.value && !recoveryBlocked.value && !hasConflict.value && !retry.value && tab.value?.risk === 'clean' &&
  original.value !== undefined && original.value.id > 0 && original.value.revision > 0n)
const canChangeSummary = computed(() => !!credential.value && editable.value && tab.value?.risk === 'clean' &&
  !closingTabs.value && !pending.value && !recoveryBlocked.value && !hasConflict.value && !taxonomyDirty.value &&
  validBody.value && validTitle.value)
const canArrangeGroups = computed(() => !!credential.value && editable.value && !opening.value && !layoutRestoring.value &&
  !closingTabs.value && composing.value === undefined && !revisionComparisonActive.value)
const otherGroup = computed<WorkspaceGroup | undefined>(() => tab.value && (tab.value.group === 'main' ? 'secondary' : 'main'))
const activeGroupTabs = computed(() => workspaceTabs.value.filter(candidate => candidate.group === tab.value?.group))
const activeGroupIndex = computed(() => activeGroupTabs.value.findIndex(candidate => candidate.active))
const canCloseGroupTabs = computed(() => editable.value && canSwitch.value && !opening.value &&
  !revisionComparisonActive.value)
const canPublishImages = computed(() => !!credential.value && editable.value && tab.value?.risk === 'clean' &&
  !cannotWrite.value && !dirty.value && !retry.value && !!original.value?.body.trim())
let deferredFocus: Readonly<{ sessionId: number; epoch: number; pane: HTMLElement }> | undefined

watch(editorArea, (area, _, cleanup) => {
  editorMeasure.value = { width: 0, rem: 16 }
  if (!area) return
  function measure() {
    if (!area) return
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize)
    const width = Math.min(area.clientWidth, window.visualViewport?.width ?? window.innerWidth)
    editorMeasure.value = { width, rem }
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

let resizing: { pointer: number; start: number; width: number; direction: number; tracks: number } | undefined

function direction() {
  return editorArea.value && getComputedStyle(editorArea.value).direction === 'rtl' ? -1 : 1
}

function resizePrimary(width: number) {
  if (showComparison.value) preferredPrimaryWidth.value = Math.max(minimumShare.value,
    Math.min(100 - minimumShare.value, Math.round(width)))
}

function startResize(event: PointerEvent) {
  const divider = splitter.value
  if (!showComparison.value || !divider || resizing || !event.isPrimary || event.button !== 0) return
  event.preventDefault()
  divider.setPointerCapture(event.pointerId)
  divider.focus({ preventScroll: true })
  resizing = { pointer: event.pointerId, start: event.clientX, width: primaryWidth.value, direction: direction(), tracks: trackWidth.value }
}

function dragResize(event: PointerEvent) {
  const drag = resizing
  if (drag?.pointer === event.pointerId)
    resizePrimary(drag.width + drag.direction * (event.clientX - drag.start) / drag.tracks * 100)
}

function endResize(event: PointerEvent) {
  if (resizing?.pointer === event.pointerId) resizing = undefined
}

function keyboardResize(event: KeyboardEvent) {
  if (!showComparison.value || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  const width = event.key === 'ArrowLeft' ? primaryWidth.value - direction() :
    event.key === 'ArrowRight' ? primaryWidth.value + direction() :
    event.key === 'Home' ? minimumShare.value : event.key === 'End' ? 100 - minimumShare.value : undefined
  if (width === undefined) return
  event.preventDefault()
  resizePrimary(width)
}

watch(identityEpoch, () => { preferredPrimaryWidth.value = 50 }, { flush: 'sync' })
watch(showComparison, async (wide, previous) => {
  if (wide) return
  resizing = undefined
  const divider = splitter.value
  const current = tab.value
  const epoch = identityEpoch.value
  if (!previous || !divider || document.activeElement !== divider || !current) return
  await nextTick()
  if (!showComparison.value && (document.activeElement === document.body || document.activeElement === divider))
    await focusSource(current, epoch)
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

const failureByReason: Record<WorkspaceBlock, MessageKey> = {
  missing: 'author.write.theArticleIsUnavailable',
  deleted: 'author.write.theArticleIsUnavailable',
  forbidden: 'author.write.youCanNoLongerEditThisArticle',
  expired: 'author.write.logInAgainToContinueWriting',
  unavailable: 'author.write.theServerCouldNotConfirmThisChangeTry',
  'stale-reference': 'author.write.theReferencedRevisionIsNoLongerCurrentResolve',
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

const send = (action: ArticleAction) => (draft: Draft, signal: AbortSignal, idempotencyKey: string,
  edits?: readonly BodyEdit[]): Promise<DraftSave<Draft>> => {
  const handle = currentSession.value?.siteSessionId
  if (!handle || signal.aborted) return Promise.resolve({ kind: 'blocked', reason: 'unavailable' })
  const title = action === 'save' ? normalizeDraftTitle(draft.title) : ''
  const body = action === 'save' ? draft.body : ''
  return mutationResult(async () => {
    const input = { id: draft.id, expectedRevision: draft.revision, title, body, idempotencyKey }
    let stored: Draft
    if (action === 'save' && edits?.length) {
      if (edits.some(edit => edit.removedLength > 0)) {
        stored = await saveWithBodyEdits({ ...input, edits }, handle, signal)
      } else {
        const insertions = edits.map(edit => ({ offset: edit.offset, length: edit.insert.length }))
        stored = insertions.length === 1
          ? await saveWithBodyInsertion({ ...input, ...insertions[0] }, handle, signal)
          : await saveWithBodyInsertions({ ...input, insertions }, handle, signal)
      }
    } else {
      stored = await api[action](input, signal, handle)
    }
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
      const reason = signal.aborted ? 'unavailable' : await workspaceBlock(error, handle, signal)
      return { kind: 'blocked', reason: reason !== 'expired' && currentSession.value?.siteSessionId !== handle ? 'unavailable' : reason }
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
  workspaceRevision.value = registry.revision
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
    if (!lifetime.signal.aborted) failure.value = t('author.write.couldNotVerifyYourSession')
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
  historicalSeek.value = undefined
  propertySeek.value = undefined
  if (sourceArrival?.source && sourceArrival.source.kind !== 'canvas') sourceArrival.source = undefined
}, { flush: 'sync' })
watch(id, () => {
  sourceArrival = undefined
  sourceInspectorPending.value = false
  sourceSeek.value = undefined
  historicalSeek.value = undefined
  propertySeek.value = undefined
}, { flush: 'sync' })
watch([recoveryItems, recoveryWorking, () => tab.value?.risk, propertyPending, metadataDirty, composing, closingTabs,
  revisionComparisonActive], ([items, recovering, risk, property, metadata, composition, closing, comparing]) => {
  const busy = items.length > 0 || recovering || risk !== 'clean' || property || metadata || composition !== undefined || closing
  if (sourceSeek.value?.kind === 'search' && (busy || comparing)) {
    sourceSeek.value = undefined
    notice.value = t(searchPositionUnavailable)
  }
  if (propertySeek.value && (busy || comparing)) finishPropertySeek(propertySeek.value, false)
  if (historicalSeek.value && busy) {
    historicalSeek.value = undefined
    notice.value = t(searchPositionUnavailable)
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
      sourceInspectorPending.value = false
      failure.value = t('author.write.thisEditorLinkHasExpiredReturnToIts')
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
  const requiredRevision = source?.kind === 'search-history' ? source.currentRevision : source?.target.revision
  const result = await activateArticle(articleId, undefined, undefined, source ? current : undefined, requiredRevision)
  if (!valid || identity !== identityEpoch.value) return
  loading.value = false
  if (result.kind !== 'ready') {
    sourceInspectorPending.value = false
    if (source && source.kind !== 'canvas') {
      if (sourceArrival) sourceArrival.source = undefined
      failure.value = result.kind === 'superseded' || result.kind === 'blocked' && result.reason === 'stale-reference'
        ? t(searchPositionUnavailable) : activationFailure(result)
    } else {
      failure.value = source && result.kind === 'superseded' ? t(failureByReason['stale-reference']) : activationFailure(result)
    }
    return
  }
  if (!source) {
    sourceInspectorPending.value = false
    return
  }
  sourceArrival = undefined
  const sessionId = result.tab.sessionId
  const revealBy = performance.now() + 6_000
  const held = () => current() && tab.value?.sessionId === sessionId && tab.value.risk === 'clean' &&
    !recoveryBlocked.value && performance.now() < revealBy
  if (source.kind === 'canvas' && source.target.sourceOffset !== null) {
    sourceSeek.value = { kind: 'canvas', sessionId, revision: source.target.revision, offset: source.target.sourceOffset, current: held }
  } else if (source.kind === 'search') {
    if (result.witnessedRevision !== source.target.revision || recoveryItems.value.length > 0) {
      sourceInspectorPending.value = false
      notice.value = t(searchPositionUnavailable)
      return
    }
    const edit = registry.activeEditSequence
    const target = source.target
    // A restored mobile drawer must never open before the source caret receives focus.
    setInspectorOpen(target.field === 'summary')
    sourceSeek.value = { kind: 'search', sessionId, target, current: () => held() && canSwitch.value &&
      editable.value && !pending.value && !revisionComparisonActive.value && registry.activeEditSequence === edit &&
      original.value?.revision === target.revision && (currentSession.value?.expiresAt ?? 0) > Date.now() }
  } else if (source.kind === 'search-history') {
    const { currentRevision, target } = source
    if (!handle || !persistentWorkspace.value || result.witnessedRevision !== currentRevision ||
      recoveryItems.value.length > 0 || recoveryWorking.value || revisionComparisonActive.value) {
      sourceInspectorPending.value = false
      notice.value = t(searchPositionUnavailable)
      return
    }
    const edit = registry.activeEditSequence
    historicalSeek.value = { target, currentRevision, credential: handle, current: () =>
      current() && tab.value?.sessionId === sessionId && tab.value.risk === 'clean' && !recoveryBlocked.value &&
      canSwitch.value && editable.value && !pending.value && registry.activeEditSequence === edit &&
      original.value?.revision === currentRevision && (currentSession.value?.expiresAt ?? 0) > Date.now() }
    setInspectorOpen(true)
  } else if (source.kind === 'property-search') {
    const { target } = source
    if (!handle || !persistentWorkspace.value || result.witnessedRevision !== target.revision ||
      recoveryItems.value.length > 0 || recoveryWorking.value || revisionComparisonActive.value) {
      sourceInspectorPending.value = false
      notice.value = t(searchPositionUnavailable)
      return
    }
    const edit = registry.activeEditSequence
    const seek: PropertySearchSeek = { target, credential: handle, current: () =>
      propertySeek.value === seek && inspectorOpen.value && held() && canSwitch.value && editable.value &&
      !pending.value && !revisionComparisonActive.value && registry.activeEditSequence === edit &&
      original.value?.id === target.articleId && original.value.revision === target.revision &&
      (currentSession.value?.expiresAt ?? 0) > Date.now() }
    propertySeek.value = seek
    setInspectorOpen(true)
  }
  sourceInspectorPending.value = false
}, { immediate: true })

function activateArticle(articleId: number, targetGroup?: WorkspaceGroup, mode?: WorkspaceTab['mode'], ready?: () => boolean,
  requiredRevision?: bigint, allowRetainedEdits = false) {
  return articleId === 0
    ? registry.startDraft({ id: 0, revision: 0n, title: '', body: '', published: false })
    : registry.openOrActivate(articleId, targetGroup, mode, ready, requiredRevision, allowRetainedEdits)
}

function finishSourceSeek(seek: EditorSourceSeek, success: boolean) {
  if (sourceSeek.value !== seek) return
  sourceSeek.value = undefined
  if (seek.kind === 'canvas') {
    if (!success) notice.value = t('author.write.theCanvasSourcePositionCouldNotBeOpened')
    return
  }
  if (!success || !seek.current()) {
    notice.value = t(searchPositionUnavailable)
    return
  }
  recordRecentOpen(seek.target.articleId, seek.target.revision)
  notice.value = seek.target.precision === 'rebased' ? t('author.write.openedTheSearchResultAtItsVerifiedPosition')
    : t('author.write.openedTheSearchResultAtItsSavedPosition')
}

function finishHistoricalSeek(seek: HistoricalSearchSeek, success: boolean) {
  if (historicalSeek.value !== seek) return
  if (!success || !seek.current()) {
    historicalSeek.value = undefined
    notice.value = t(searchPositionUnavailable)
    return
  }
  recordRecentOpen(seek.target.articleId, seek.currentRevision)
  notice.value = t('author.write.openedTheSearchResultInItsEarlierSaved')
}

function closeHistoricalSeek(seek: HistoricalSearchSeek) {
  if (historicalSeek.value === seek) historicalSeek.value = undefined
}

function finishPropertySeek(seek: PropertySearchSeek, success: boolean) {
  if (propertySeek.value !== seek) return
  const revealed = success && seek.current()
  propertySeek.value = undefined
  if (!revealed) {
    notice.value = t(searchPositionUnavailable)
    return
  }
  recordRecentOpen(seek.target.articleId, seek.target.revision)
  notice.value = t('author.write.openedTheSearchResultAtItsSavedProperty')
}

function activationFailure(receipt: Activation): string {
  if (receipt.kind === 'blocked') return t(failureByReason[receipt.reason])
  if (receipt.kind === 'capacity') return t('author.write.thisWorkspaceHas100OpenArticlesCloseA')
  return ''
}

onBeforeRouteUpdate(async (to, from) => {
  if (to.path === from.path || !authorizationReady.value || !currentSession.value?.canAuthor) return true
  const intent = ++navigation
  registry.cancelOpening()
  opening.value = false
  if (!canSwitch.value) {
    navigationNotice.value = t('author.write.applyOrCancelThePendingChangesBeforeSwitching')
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
  const selection = explicit?.selection
  const result = await activateArticle(articleId, explicit?.targetGroup ?? explicit?.restore?.group, explicit?.restore?.mode,
    () => intent === navigation && epoch === identityEpoch.value && canSwitch.value && !lifetime.signal.aborted &&
      (!selection || selection.current()),
    selection?.revision, !!selection)
  if (intent !== navigation || epoch !== identityEpoch.value || lifetime.signal.aborted) return false
  opening.value = false
  if (!selection) navigationNotice.value = result.kind === 'superseded' && !canSwitch.value
    ? t('author.write.applyOrCancelThePendingChangesBeforeSwitching') : activationFailure(result)
  if (result.kind === 'ready') {
    if (explicit && result.witnessedRevision !== undefined)
      explicit.witness = { sessionId: result.tab.sessionId, articleRevision: result.witnessedRevision }
    notice.value = ''
    failure.value = result.tab.risk === 'conflict' ? t('author.write.theServerHasANewerRevisionCopyYour') : ''
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

async function navigateTo(articleId: number, restore?: RecentlyClosed, targetGroup?: WorkspaceGroup, selection?: ArticleSelection) {
  if (!canSwitch.value || (selection && (opening.value || !selection.current()))) return false
  if (registry.activeTab?.articleId === articleId && id.value === articleId) {
    if (!selection) return true
    const result = await activateArticle(articleId, undefined, undefined,
      () => selection.current() && canSwitch.value && !lifetime.signal.aborted, selection.revision, true)
    if (result.kind !== 'ready' || !selection.current() || registry.activeTab?.sessionId !== result.tab.sessionId ||
        id.value !== articleId) return false
    recordRecentOpen(articleId, selection.revision)
    return true
  }
  const destination = address(articleId)
  const intent: NavigationIntent = { restore, targetGroup, selection, path: router.resolve(destination).path }
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

async function reopenRecent(item: RecentlyClosed, event: MouseEvent) {
  const opener = event.currentTarget
  const current = registry.activeTab
  const epoch = identityEpoch.value
  if (await navigateTo(item.articleId, item) || !current || !(opener instanceof HTMLElement)) return
  await nextTick()
  if (!opener.isConnected && document.activeElement === document.body) await focusSource(current, epoch)
}

function activateQuickResult(articleId: number, revision: bigint, current: () => boolean, targetGroup?: WorkspaceGroup) {
  return navigateTo(articleId, undefined, targetGroup, { revision, current })
}

function focusQuickResult(articleId: number) {
  const active = registry.activeTab
  if (active?.articleId === articleId) void focusSource(active, identityEpoch.value)
}

function quickResultHref(articleId: number) {
  return router.resolve(address(articleId)).href
}

function openArticle(splitGroup = false) {
  const articleId = inputArticle.value
  if (articleId === undefined) {
    navigationNotice.value = t('author.write.enterAValidArticleId')
    return
  }
  void navigateTo(articleId, undefined, splitGroup ? otherGroup.value : undefined)
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

function canMoveBackgroundTab(target: WorkspaceTab) {
  return canArrangeGroups.value && registry.canMoveBackgroundTab(target)
}

function moveBackgroundTab(target: WorkspaceTab, revision: number) {
  if (!canArrangeGroups.value) return
  const destination = target.group === 'main' ? 'secondary' : 'main'
  const receipt = registry.moveBackgroundTab(target, destination, revision)
  if (receipt.kind === 'changed')
    groupNotice.value = t(destination === 'main' ? 'author.write.movedTitlePrimary' : 'author.write.movedTitleSecondary', { title: receipt.tab.title })
}

function arrangeGroups(destination?: WorkspaceGroup) {
  const current = tab.value
  if (!current || !canArrangeGroups.value) return
  const receipt = destination ? registry.moveActiveTab(current, destination, registry.revision) : registry.mergeGroups(current, registry.revision)
  if (receipt.kind !== 'changed') return
  groupNotice.value = destination
    ? t(destination === 'main' ? 'author.write.movedPrimary' : 'author.write.movedSecondary')
    : t('author.write.mergedBothGroupsIntoThePrimaryGroup')
  deferredFocus = undefined
  void focusSource(receipt.tab, identityEpoch.value)
}

function setInspectorOpen(open: boolean) {
  if (persistentWorkspace.value && tab.value) registry.setInspectorOpen(tab.value, open)
  if (!open && summarySeek.value) finishSourceSeek(summarySeek.value, false)
  if (!open && propertySeek.value) finishPropertySeek(propertySeek.value, false)
  if (!open) historicalSeek.value = undefined
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
  else if (!registry.unpin(target)) navigationNotice.value = t('author.write.saveChangesAndCloseTheCurrentPreviewBefore')
}

const closeRiskLabel = {
  dirty: 'author.write.unsavedChanges', saving: 'author.write.saveInProgress', conflict: 'author.write.saveConflict',
  recovery: 'author.write.draftRecovery', pending: 'author.write.pendingChange', blocked: 'author.write.unavailable',
} satisfies Record<Exclude<WorkspaceTab['risk'], 'clean'>, MessageKey>

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
      const failure = result.kind === 'conflict' ? t('author.write.changedOnServer', { title: target.title })
        : result.kind === 'saved' ? t('author.write.cleanupUnconfirmed', { title: target.title })
        : result.kind === 'rejected' ? t('author.write.rejectedTitle', { title: target.title })
        : result.kind === 'blocked' && result.reason !== 'unavailable' ? t('author.write.saveBlocked', { title: target.title, reason: t(failureByReason[result.reason]) })
        : t('author.write.saveUnconfirmed', { title: target.title })
      return { message: t('author.write.tabsStillOpenFailure', { saved: saved.length ? t('author.write.savedTitlesPrefix', { titles: saved.join(', ') }) : '', failure }) }
    }
    if (!current()) return 'stale'
    const result = registry.completeClose(reservation, true)
    if (result.kind === 'protected') return { message: t('author.write.savedTitlesOpen', { titles: saved.join(', ') }) }
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
      'aria-label': t('author.write.tabsToClose'), tabindex: 0,
      style: { maxBlockSize: 'min(40vh, 16rem)', overflowY: 'auto', overflowWrap: 'anywhere', paddingInlineStart: '1.5rem' },
    }, plan.tabs.map(({ title, risk, articleId, sessionId }) => h('li', { key: sessionId },
      `${title} (${risk === 'clean' ? t('author.write.upToDate') : t(closeRiskLabel[risk])})${articleId ? t('author.write.articleSuffix', { id: articleId }) : ''}`))),
    h(ElRadioGroup, {
      modelValue: choice.value, label: t('author.write.unsavedEdits'),
      style: { display: 'grid', justifyItems: 'start' },
      'onUpdate:modelValue': (value: unknown) => {
        if (value === 'keep' || value === 'discard' || value === 'save') choice.value = value
      },
    }, { default: () => [
      drafts?.length ? h(ElRadio, { value: 'keep' }, () => t('author.write.keepBrowserRecoveryCopies')) : null,
      canSave ? h(ElRadio, { value: 'save' }, () => t('author.write.saveDraftsBeforeClosing')) : null,
      allSaved && drafts?.length ? h(ElRadio, { value: 'discard' }, () => t('author.write.discardUnsavedEditsFromThisBrowser')) : null,
    ] }),
  ]) : h('p', t('author.write.theWorkspaceChangedWhileThisConfirmationWasOpen')))
  closingTabs.value = true
  try {
    const consent = await ElMessageBox.confirm(
      message, t('author.write.closeTabsWithUnsavedEdits'), {
        type: 'warning', confirmButtonText: t('author.write.closeTabs'), cancelButtonText: t('author.write.keepWriting'), closeOnClickModal: false,
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
  const blocked = plan?.tabs.flatMap(({ title, risk }) => risk === 'clean' ? [] : [`${title} (${t(closeRiskLabel[risk])})`]) ?? []
  return typeof outcome === 'object' ? outcome.message
    : outcome === 'protected' ? t('author.write.closeBlocked', { tabs: blocked.join(', ') })
    : outcome === 'copies-unavailable' ? t('author.write.couldNotVerifyRecoveryCopiesSaveTheDrafts')
    : outcome === 'discard-unavailable' ? t('author.write.couldNotDiscardTheRecoveryCopiesTheTabs')
    : outcome === 'stale' ? t('author.write.tabsChangedBeforeClosingTryAgain') : ''
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
  groupNotice.value = targets.length === 1 ? t('author.write.closed1Tab') : t('author.write.closedTabs', { count: targets.length })
  await nextTick()
  if (isCurrent()) tabsControl.value?.focusActive()
}

async function closeTab(target: WorkspaceTab) {
  if (closingTabs.value || target.active && !canSwitch.value) {
    navigationNotice.value = t('author.write.applyOrCancelThePendingChangesBeforeClosing')
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
      navigationNotice.value = t('author.write.resolveThePendingChangesBeforeClosingThisTab')
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
        const outcome = await ElMessageBox.confirm(t('author.write.discardTitle', { title: target.title }), t('author.write.closeArticleTab'), {
          type: 'warning', confirmButtonText: t('author.write.discardChanges'), cancelButtonText: t('author.write.keepWriting'), closeOnClickModal: false,
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
      ? t('author.write.yourChangesWillBeLostIfYouLeave')
      : t('author.write.discardTitles', { titles: candidates.map(item => item.title).join(', ') })
    const outcome = await ElMessageBox.confirm(message, t('author.write.discardUnsavedChanges'), {
      type: 'warning',
      confirmButtonText: t('author.write.discardChanges'),
      cancelButtonText: t('author.write.keepWriting'),
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

function edit(pane: WorkspaceSource<Draft>, field: 'title' | 'body', value: string, edits?: readonly BodyEdit[]) {
  const document = original.value
  const current = tab.value
  if (paneFocused(pane) && !closingTabs.value && !recoveryBlocked.value && !metadataDirty.value && !propertyPending.value
      && current && document && document[field] !== value) {
    const next = { ...document, [field]: value }
    if (registry.updateDraft(current, next, field === 'body' ? edits : undefined)) recovery.persist(next, registry.activeEditSequence)
  }
}

async function loadImportedDraft(pane: WorkspaceSource<Draft>, imported: DraftMarkdown) {
  const active = tab.value
  const draft = original.value
  const handle = credential.value
  if (!active || !draft || !handle || !canImportDraft.value || !paneFocused(pane) || lifetime.signal.aborted ||
      (currentSession.value?.expiresAt ?? 0) <= Date.now()) return
  const next = { ...draft, ...imported }
  if (!registry.updateDraft(active, next)) return
  recovery.persist(next, registry.activeEditSequence)
  notice.value = t('author.write.markdownLoadedSaveToKeepThisDraft')
  await nextTick()
  if (!lifetime.signal.aborted && credential.value === handle && tab.value?.sessionId === active.sessionId)
    document.getElementById('article-title')?.focus()
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
      failure.value = t('author.write.draftSavedRecoveryCleanupIsUnfinishedTryAgain')
      return
    }
    notice.value = {
      save: t('author.write.draftSaved'), publish: t('author.write.articlePublished'), retract: t('author.write.articleWithdrawn'),
      'publish-images': t('author.write.articleAndSelectedImagesPublished'),
      'assign-taxonomy': t('author.write.classificationSaved'), 'rollback-history': t('author.write.revisionRestoredToANewDraft'),
      'schedule-publication': t('author.write.publicationScheduleUpdated'),
      'save-rights': t('author.write.publicationRightsSaved'),
      'save-attachment': t('author.write.privateArticleMediaSaved'),
      'save-summary': t('author.write.summarySaved'),
    }[action]
    if (!document.id) await router.replace({ ...address(result.articleId), state: persistentWorkspace.value ? workspaceState : undefined })
  } else if (result.kind === 'conflict') {
    failure.value = t('author.write.theServerHasANewerRevisionCopyYour')
  } else if (result.kind === 'blocked') {
    failure.value = t(failureByReason[result.reason])
  } else if (result.kind === 'rejected') {
    failure.value = t('author.write.theServerRejectedThisChangeCheckTheDraft')
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
        <RouterLink class="editor-back" to="/">{{ t('author.write.back') }}</RouterLink>
        <RouterLink v-if="currentSession?.canAuthor" class="canvas-entry" to="/user/manage/canvas">{{ t('author.write.canvases') }}</RouterLink>
        <h1>{{ id === undefined ? t('author.write.articleWorkspace') : id === 0 ? t('author.write.newArticle') : t('author.write.editArticle') }}</h1>
        <span v-if="editable" class="metadata">{{ original?.published ? t('author.write.published') : t('author.write.draft') }}</span>
      </div>
      <div v-if="editable" class="editor-actions">
        <ElButton v-if="retry" type="primary" :disabled="closingTabs || pending" @click="submit(retry)">{{ t('author.write.tryAgain') }}</ElButton>
        <ElButton v-else native-type="button" :disabled="cannotWrite || !articleDirty" @click="submit('save')">{{ t('author.write.saveDraft') }}</ElButton>
        <ElButton
          v-if="!retry" native-type="button" :type="original?.published ? 'default' : 'primary'"
          :disabled="cannotWrite || dirty || id === 0 || !original?.body.trim()"
          @click="submit('publish')"
        >
          {{ original?.published ? t('author.write.publishRevision') : t('author.write.publishArticle') }}
        </ElButton>
        <ElButton v-if="original?.published && !retry" native-type="button" :disabled="cannotWrite || dirty" @click="submit('retract')">{{ t('author.write.withdraw') }}</ElButton>
      </div>
    </header>
    <section v-if="authorizationReady && currentSession?.canAuthor" class="workspace-actions" :aria-label="t('author.write.articleWorkspace')">
      <WorkspaceTabs ref="tabsControl" :tabs="workspaceTabs" :disabled="!canSwitch" :workspace-revision="workspaceRevision"
        :can-move-background="canMoveBackgroundTab"
        @activate="navigateTo($event.articleId)" @pin="togglePin" @close="closeTab" @move="moveBackgroundTab" />
      <form class="workspace-open" @submit.prevent="openArticle()">
        <label for="workspace-article-id">{{ t('author.write.articleId') }}</label>
        <ElInput id="workspace-article-id" ref="articleInput" v-model="openInput" class="workspace-open-field"
          :disabled="!canSwitch" />
        <ElButton native-type="submit" :disabled="!canSwitch">{{ t('author.write.openArticle') }}</ElButton>
        <ElButton v-if="tab" native-type="button" :disabled="!canSwitch || inputArticle === undefined"
          @click="openArticle(true)">{{ t('author.write.openInOtherGroup') }}</ElButton>
        <RouterLink v-if="openAddress" :to="openAddress" target="_blank" rel="noopener">{{ t('author.write.openInBrowserTab') }}</RouterLink>
        <RouterLink :to="{ name: 'write', state: persistentWorkspace ? workspaceState : undefined }">{{ t('author.write.newDraft') }}</RouterLink>
        <ElButton v-if="!persistentWorkspace && id !== undefined" text native-type="button" :disabled="!canSwitch" @click="openSavedWorkspace">{{ t('author.write.openSavedWorkspace') }}</ElButton>
      </form>
      <div v-if="twoSources && !showComparison" class="workspace-groups" role="group" :aria-label="t('author.write.articleGroups')">
        <ElButton v-for="pane in selectedPanes" :key="pane.tab.sessionId" text native-type="button"
          :disabled="!canSwitch || pane.tab.active" @click="focusGroup(pane.tab)">
          {{ pane.tab.group === 'main' ? t('author.write.focusPrimaryGroup') : t('author.write.focusSecondaryGroup') }}
        </ElButton>
      </div>
      <details v-if="tab && (hasSecondaryGroup || activeGroupTabs.length > 1)" class="workspace-group-actions">
        <summary>{{ hasSecondaryGroup ? t('author.write.groupActions') : t('author.write.tabActions') }}</summary>
        <div>
          <template v-if="hasSecondaryGroup">
            <ElButton text native-type="button" :disabled="!canArrangeGroups || tab.group === 'main'"
              @click="arrangeGroups('main')">{{ t('author.write.moveToPrimaryGroup') }}</ElButton>
            <ElButton text native-type="button" :disabled="!canArrangeGroups || tab.group === 'secondary'"
              @click="arrangeGroups('secondary')">{{ t('author.write.moveToSecondaryGroup') }}</ElButton>
            <ElButton text native-type="button" :disabled="!canArrangeGroups" @click="arrangeGroups()">{{ t('author.write.mergeGroups') }}</ElButton>
            <ElButton v-if="showComparison" text native-type="button" @click="resizePrimary(50)">{{ t('author.write.equalizeGroupWidths') }}</ElButton>
          </template>
          <template v-if="activeGroupTabs.length > 1">
            <ElButton text native-type="button" :disabled="!canCloseGroupTabs"
              @click="closeGroupTabs($event, false)">{{ t('author.write.closeOtherTabs') }}</ElButton>
            <ElButton text native-type="button" :disabled="!canCloseGroupTabs || activeGroupIndex === activeGroupTabs.length - 1"
              @click="closeGroupTabs($event, true)">{{ t('author.write.closeTabsToTheRight') }}</ElButton>
          </template>
        </div>
      </details>
      <ArticleQuickSwitcher :disabled="!canSwitch || revisionComparisonActive" :other-group="otherGroup" :activate="activateQuickResult"
        :article-href="quickResultHref" @activated="focusQuickResult" />
      <ArticleLibraryRail :article-id="tab?.articleId" :article-revision="original?.revision" :recent-opens-version="recentOpensVersion"
        :disabled="!canSwitch" :activate="navigateTo" />
      <details v-if="recentlyClosed.length">
        <summary>{{ t('author.write.recentlyClosed') }}</summary>
        <ul>
          <li v-for="item in recentlyClosed" :key="item.articleId">
            <ElButton text native-type="button" :disabled="!canSwitch" @click="reopenRecent(item, $event)">
              {{ t('author.write.reopenTitle', { title: item.title }) }}
            </ElButton>
          </li>
        </ul>
      </details>
      <p v-if="opening" role="status">{{ t('author.write.openingArticle') }}</p>
      <p v-if="groupNotice" role="status">{{ groupNotice }}</p>
      <p v-if="navigationNotice" role="alert">{{ navigationNotice }}</p>
      <p v-if="layoutNotice" role="status">{{ layoutNotice }}</p>
      <p v-if="hasSecondaryGroup && persistentWorkspace && !supportsSavedGroups" role="status">{{ t('author.write.theSecondGroupStaysOpenInThisBrowser') }}</p>
      <p v-if="recentOpensNotice" role="status">{{ recentOpensNotice }}</p>
    </section>
    <p v-if="!authorizationReady || loading" role="status">{{ t('author.write.openingTheEditor') }}</p>
    <template v-else-if="!currentSession?.canAuthor">
      <ElAlert :title="failure || t('author.write.logInWithAnAuthorAccountToWrite')" type="info" :closable="false" />
      <p><RouterLink :to="{ name: 'login' }">{{ t('author.write.logIn') }}</RouterLink></p>
    </template>
    <p v-else-if="id === undefined" role="status">{{ t('author.write.openAnArticleOrStartANewDraft') }}</p>
    <template v-else-if="!editable">
      <ElAlert :title="failure" type="error" :closable="false" />
      <ElButton class="retry" @click="reload++">{{ t('author.write.retry') }}</ElButton>
    </template>
    <section v-if="authorizationReady && currentSession?.canAuthor && sourcePanes.length" v-show="editable"
      id="workspace-editor" class="editor-document" role="tabpanel" :aria-label="selectedPanelTitle">
      <div ref="editorArea" class="editor-source" :class="{ 'editor-source--split': showComparison }"
        :style="{ gridTemplateColumns: splitColumns }">
        <WorkspaceSourcePane v-for="pane in sourcePanes" :key="pane.tab.sessionId" :pane="pane" :focus="paneFocused(pane)"
          :concealed="!pane.selected || (!pane.tab.active && !showComparison)"
          :blocked="closingTabs || pending || metadataDirty || recoveryBlocked" :split="hasSecondaryGroup" :can-switch="canSwitch"
          :source-target="!summarySeek && sourceSeek?.sessionId === pane.tab.sessionId ? sourceSeek : undefined" @source-revealed="finishSourceSeek"
          @edit="(field, value, edits) => edit(pane, field, value, edits)" @activate="focusGroup(pane.tab)" @compose="changeComposition(pane, $event)">
          <template #before>
            <template v-if="paneFocused(pane)">
              <p v-if="notice" class="write-notice" role="status">
                {{ notice }} <RouterLink v-if="publishedPath" :to="publishedPath">{{ t('author.write.readThePublishedArticle') }}</RouterLink>
              </p>
              <ElAlert v-if="failure" :title="failure" type="error" :closable="false" show-icon />
              <ElButton v-if="hasConflict" class="retry" @click="reloadDraft">{{ t('author.write.loadLatestRevision') }}</ElButton>
              <p v-if="recoveryChecking" role="status">{{ t('author.write.checkingLocalDraftRecovery') }}</p>
              <DraftMarkdownImport v-if="canImportDraft" :key="credentialEpoch"
                @load="loadImportedDraft(pane, $event)" />
            </template>
          </template>
          <template #after>
            <template v-if="paneFocused(pane)">
              <p v-if="recoveryFailure" role="status">{{ t('author.write.localDraftRecoveryIsUnavailableSaveToKeep') }}</p>
              <section v-if="recoveryItems.length" aria-labelledby="draft-recovery-title">
                <h2 id="draft-recovery-title">{{ t('author.write.recoverAnUnsavedDraft') }}</h2>
                <p>{{ t('author.write.unsavedTextIsStoredInThisBrowserFor') }}</p>
                <div v-for="item in recoveryItems" :key="`${item.writer}-${item.editSequence}`">
                  <h3>{{ item.title || t('author.write.untitledDraft') }}</h3>
                  <p v-if="item.relationship === 'compare'">{{ t('author.write.thisRecoveryCopyAndTheServerDraftHave') }}</p>
                  <details>
                    <summary>{{ t('author.write.compareDrafts') }}</summary>
                    <h4>{{ t('author.write.serverDraft') }}</h4><pre>{{ original?.body }}</pre>
                    <h4>{{ t('author.write.recoveryCopy') }}</h4><pre>{{ item.body }}</pre>
                  </details>
                  <ElButton native-type="button" :disabled="pending || recoveryWorking || articleDirty" @click="restoreDraft(item)">{{ t('author.write.restoreDraft') }}</ElButton>
                  <ElButton native-type="button" :disabled="pending || recoveryWorking" @click="recovery.remove(item)">{{ t('author.write.discardRecoveryCopy') }}</ElButton>
                </div>
              </section>
              <p v-if="!validBody" role="alert">{{ t('author.write.theArticleExceedsTheSizeLimit') }}</p>
            </template>
          </template>
        </WorkspaceSourcePane>
        <div v-if="showComparison && primaryPane" ref="splitter" class="workspace-splitter" role="separator" tabindex="0"
          :aria-label="t('author.write.resizeArticleGroups')" aria-orientation="vertical" :aria-controls="`workspace-source-${primaryPane.sessionId}`"
          :aria-valuemin="minimumShare" :aria-valuemax="100 - minimumShare" :aria-valuenow="primaryWidth"
          :aria-valuetext="t('author.write.primaryWidth', { width: primaryWidth })"
          @pointerdown="startResize" @pointermove="dragResize" @pointerup="endResize" @pointercancel="endResize"
          @lostpointercapture="endResize" @keydown="keyboardResize" />
      </div>
      <EditorInspector v-if="original && original.id > 0" v-slot="{ ready: inspectorReady }" :nested-modal-active="revisionComparisonActive"
        :opened="persistentWorkspace ? !sourceInspectorPending && inspectorOpen : undefined" @update:opened="setInspectorOpen">
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
        <DocumentExportTasks :article="original.id" :revision="original.revision" :selected="original.revision"
          :active="inspectorReady && !revisionComparisonActive" :disabled="pending || hasConflict" />
        <AuthorPluginPreview :article="original.id" :revision="original.revision"
          :active="inspectorReady && !revisionComparisonActive" :disabled="!canPreviewPlugin" />
        <ArticleMedia :article-id="original.id" :revision="original.revision"
          :credential="credential" :can-publish="canPublishImages"
          :can-change="!!currentSession?.siteSessionId && !dirty && !pending && !recoveryBlocked && !retry && !hasConflict"
          @save="submit('save-attachment', undefined, undefined, undefined, undefined, $event)" @publish-images="publishSelectedImages" />
        <ArticleTaxonomy ref="taxonomyEditor"
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
          :source-target="propertySeek" :inspector-ready="inspectorReady && !recoveryBlocked"
          @pending="propertyPending = $event" @source-revealed="finishPropertySeek"
        />
        <RevisionHistory
          :key="identityEpoch"
          :article-id="original.id"
          :revision="original.revision"
          :historical-seek="historicalSeek" :inspector-ready="inspectorReady && !recoveryBlocked"
          :editor-draft="editable && !pending && !hasConflict && !recoveryBlocked ? original : undefined"
          :editor-summary="summaryEditor?.comparisonSummary"
          :editor-taxonomy="taxonomyEditor?.comparisonTaxonomy"
          :can-rollback="editable && !dirty && !pending && !recoveryBlocked && !retry && !hasConflict"
          @restore="submit('rollback-history', undefined, $event)"
          @comparison-modal="revisionComparisonActive = $event"
          @historical-revealed="finishHistoricalSeek" @historical-closed="closeHistoricalSeek"
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
        <ArticleSummary ref="summaryEditor" :article-id="original.id" :revision="original.revision" :credential="credential"
          :can-change="canChangeSummary" :saving="articlePending && summaryDirty"
          :source-target="summarySeek" :inspector-ready="inspectorReady" @source-revealed="finishSourceSeek"
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
.editor-source--split { align-items: start; column-gap: 0; }
.editor-source--split :deep(.workspace-source__heading) { min-block-size: var(--fsus-control-height-action); }
.editor-source--split > .workspace-source { grid-row: 1; grid-column: 1; }
.editor-source--split > .workspace-source--secondary { grid-column: 3; }
.workspace-splitter {
  position: relative;
  grid-row: 1;
  grid-column: 2;
  align-self: stretch;
  cursor: col-resize;
  touch-action: none;
  user-select: none;
}
.workspace-splitter::before {
  position: absolute;
  inset-block: 0;
  inset-inline-start: 50%;
  inline-size: 1px;
  border-inline-start: 1px solid var(--fsus-border);
  content: '';
}
.workspace-splitter:hover::before, .workspace-splitter:focus-visible::before {
  border-inline-start-color: var(--fsus-color-action-primary);
}
.workspace-splitter:focus-visible { outline: 2px solid var(--fsus-color-action-primary); outline-offset: -2px; }
@media (min-width: 1024px) {
  .editor-document:has(> .inspector-launcher[aria-expanded="true"]) {
    grid-template-columns: minmax(0, 1fr) minmax(18rem, 36%);
    grid-template-areas: "source pane" "launcher pane";
    align-items: start;
    column-gap: var(--fsus-space-4);
  }
}
</style>
