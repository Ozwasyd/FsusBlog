import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import type { ElInput } from '@ozwasyd/element-plus'
import { api, type Draft } from '../../../Contracts/client'
import { assignTaxonomy } from '../../../Contracts/taxonomy-client'
import { rollbackDraft } from '../../../Contracts/revision-history'
import { setArticleSchedule } from '../../../Contracts/article-schedule'
import { setDraftRights } from '../../../Contracts/article-rights'
import { saveDraftSummary } from '../../../Contracts/article-summary-client'
import { saveWithBodyEdits, saveWithBodyInsertion, saveWithBodyInsertions } from '../../../Contracts/article-body-insertion'
import { editArticleMedia } from '../../../Contracts/article-media'
import { publishArticleImages } from '../../../Contracts/published-media'
import { t } from '../siteLocale'
import { publicOriginBase } from '../siteBrand'
import { credentialEpoch, currentSession, identityEpoch, recheckCredential, refreshSession } from '../authorSession'
import { consumeAuthoringSessionPreload } from '../workspacePreload'
import type WorkspaceTabs from './WorkspaceTabs.vue'
import type { DraftMarkdown } from './draftMarkdownImport'
import { editorRecovery } from './editorRecovery'
import { recentArticleOpens } from './recentArticleOpens'
import { useWriteSourceHandoff } from './useWriteSourceHandoff'
import { confirmDiscardTabDialog, confirmLeaveDialog, confirmProtectedCloseDialog } from './writeCloseDialog'
import { createWriteCommandAdapter } from './writeCommandAdapter'
import { computedProps, createSnapshotRefs, snapshotFields } from './snapshotFields'
import { workspacePersistence } from './workspacePersistence'
import {
  articleRouteDestination, articleRouteId, createWriteWorkspaceController, deriveWorkspaceFlags,
  workspaceHistoryState, type WriteWorkspaceController,
} from './writeWorkspaceController'
import type { RecentlyClosed, WorkspaceGroup, WorkspaceSource, WorkspaceTab } from './workspaceRegistry'

export function useWriteWorkspace() {
  const route = useRoute(), router = useRouter()
  const id = computed(() => articleRouteId(route.name, route.params.id))
  const tabsControl = ref<InstanceType<typeof WorkspaceTabs>>(), articleInput = ref<InstanceType<typeof ElInput>>(), reload = ref(0)

  const recovery = editorRecovery()
  const { candidates: recoveryItems, failure: recoveryFailure, guarded: recoveryChecking } = recovery
  const { record: recordRecentOpen, changed: recentOpensVersion, notice: recentOpensNotice } = recentArticleOpens()

  let controller!: WriteWorkspaceController
  const handoff = useWriteSourceHandoff({
    articleId: id, credentialEpoch, recordRecentOpen, setNotice: message => controller.setNotice(message),
  })
  const preloadedAuth = consumeAuthoringSessionPreload() && !handoff.coordinator.hasArrival()
  const commands = createWriteCommandAdapter({
    session: { currentHandle: () => currentSession.value?.siteSessionId, hasSession: () => Boolean(currentSession.value), recheckCredential },
    transport: {
      readDraft: (articleId, signal, handle) => api.draft(articleId, signal, handle),
      articleAction: (action, input, signal, handle) => api[action](input, signal, handle),
      saveWithBodyInsertion, saveWithBodyInsertions, saveWithBodyEdits, assignTaxonomy, rollbackDraft,
      setArticleSchedule, setDraftRights, editArticleMedia, saveDraftSummary, publishArticleImages,
    },
  })
  const persistence = workspacePersistence(() => controller.registry.savedLayout, () => controller.registry.hasSecondaryGroup)
  const navigateRoute = async (
    method: 'push' | 'replace',
    target: ReturnType<typeof articleRouteDestination> | { name: 'article-workspace' },
    persistent: boolean,
  ) => Boolean(await router[method]({ ...target, state: persistent ? workspaceHistoryState : undefined }))

  controller = createWriteWorkspaceController({
    origin: location.origin,
    initialPersistentWorkspace: route.name === 'article-workspace' || history.state?.articleWorkspace === true,
    initialAuthorizationReady: preloadedAuth, commands, handoff: handoff.coordinator,
    session: {
      current: () => currentSession.value, identityEpoch: () => identityEpoch.value,
      credentialEpoch: () => credentialEpoch.value, refreshSession: (signal, reuseInFlight) => refreshSession(signal, reuseInFlight),
    },
    recovery: { ...recovery, candidates: () => recoveryItems.value, guarded: () => recoveryChecking.value },
    persistence,
    router: {
      articleId: () => id.value, path: () => route.path,
      resolveArticlePath: articleId => router.resolve(articleRouteDestination(articleId)).path,
      pushArticle: (articleId, persistent) => navigateRoute('push', articleRouteDestination(articleId), persistent),
      replaceArticle: (articleId, persistent) => navigateRoute('replace', articleRouteDestination(articleId), persistent),
      replaceWorkspace: persistent => navigateRoute('replace', { name: 'article-workspace' }, persistent),
    },
    confirm: { confirmProtectedClose: confirmProtectedCloseDialog, confirmDiscardTab: confirmDiscardTabDialog, confirmLeave: confirmLeaveDialog },
    format: (key, params) => t(key, params), recordRecentOpen, scheduleTick: callback => { void nextTick(callback) },
  })

  const fields = createSnapshotRefs(controller.snapshot(), ['original', 'tab', 'workspaceTabs', 'sourcePanes', 'recentlyClosed'])
  const { state, update } = snapshotFields(fields)
  const openInput = computed({ get: () => fields.openInput.value, set: value => controller.setOpenInput(value) })
  const unsubscribeController = controller.subscribe(() => update(controller.snapshot()))

  const flags = computed(() => deriveWorkspaceFlags({
    state: { ...state }, articleId: id.value, session: currentSession.value,
    recoveryItemsCount: recoveryItems.value.length, recoveryChecking: recoveryChecking.value,
  }))
  const flagRefs = computedProps(flags)
  const { metadataDirty, recoveryBlocked, pending, editable, credential, inputArticle } = flagRefs
  const openAddress = computed(() => inputArticle.value === undefined ? undefined : articleRouteDestination(inputArticle.value))
  const selectedPanelTitle = computed(() => state.tab?.title ? t('author.write.contentTitle', { title: state.tab.title }) : t('author.write.articleContent'))
  const publicBase = publicOriginBase()
  const publishedPath = computed(() => state.original?.published ? `${publicBase}/article/${state.original.id}` : '')

  let deferredFocus: Readonly<{ sessionId: number; epoch: number; pane: HTMLElement; current?: () => boolean }> | undefined

  watch([currentSession, identityEpoch], ([session, epoch]) => controller.syncIdentity(session, epoch), { immediate: true, flush: 'sync' })
  watch([identityEpoch, () => currentSession.value?.canAuthor], ([epoch, author]) => {
    if (!author) recovery.close()
    else void recovery.attach(epoch, () => identityEpoch.value === epoch && currentSession.value?.canAuthor === true, () => currentSession.value?.siteSessionId)
  }, { immediate: true })
  watch(identityEpoch, () => { controller.onIdentityEpochChanged(); deferredFocus = undefined })

  handoff.bindActivity({
    recoveryItems, recoveryWorking: fields.recoveryWorking, activeTab: fields.tab, propertyPending: fields.propertyPending,
    metadataDirty, composing: fields.composing, closingTabs: fields.closingTabs, revisionComparisonActive: fields.revisionComparisonActive,
  })

  watch([id, identityEpoch, fields.authorizationReady, reload, fields.persistentWorkspace], async ([articleId, identity], _, cleanup) => {
    let valid = true
    cleanup(() => { valid = false })
    await controller.syncRoute({ articleId, identity, isValid: () => valid })
  }, { immediate: true })

  onBeforeRouteUpdate((to, from) => controller.beforeRouteUpdate({ toPath: to.path, fromPath: from.path, toArticleId: articleRouteId(to.name, to.params.id) }))
  onBeforeRouteLeave(() => controller.beforeRouteLeave())

  const onUnload = (event: BeforeUnloadEvent) => { if (controller.shouldPreventUnload()) event.preventDefault() }
  const flushWorkspace = () => { void persistence.flush() }
  const flushHiddenWorkspace = () => { if (document.visibilityState === 'hidden') flushWorkspace() }
  const toggleListeners = (op: 'addEventListener' | 'removeEventListener') => {
    window[op]('beforeunload', onUnload)
    window[op]('pagehide', flushWorkspace)
    window[op]('offline', persistence.offline)
    document[op]('visibilitychange', flushHiddenWorkspace)
  }
  onMounted(() => { void controller.mountSessionCheck(preloadedAuth); toggleListeners('addEventListener') })
  onUnmounted(() => { controller.dispose(); unsubscribeController(); toggleListeners('removeEventListener') })

  async function focusSource(target: WorkspaceTab, epoch: number, whenFocusLost?: () => boolean): Promise<void> {
    await nextTick()
    if (epoch !== identityEpoch.value || state.tab?.sessionId !== target.sessionId || !editable.value) return
    if (whenFocusLost && (document.activeElement !== document.body || !whenFocusLost())) return
    if (!recoveryBlocked.value && !pending.value && !metadataDirty.value) {
      document.getElementById('article-body')?.focus({ preventScroll: true })
      return
    }
    const pane = document.getElementById(`workspace-source-${target.sessionId}`)
    if (pane) {
      pane.focus({ preventScroll: true })
      deferredFocus = { sessionId: target.sessionId, epoch, pane, current: whenFocusLost }
    }
  }

  watch([recoveryBlocked, pending, metadataDirty, () => state.tab?.sessionId, editable], async ([blocked, writing, editingMetadata, sessionId, ready]) => {
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
    if (document.activeElement === request.pane && state.tab?.sessionId === request.sessionId &&
        editable.value && request.current?.() !== false) {
      document.getElementById('article-body')?.focus({ preventScroll: true })
    }
  })

  async function focusGroup(target: WorkspaceTab): Promise<void> {
    const epoch = identityEpoch.value
    deferredFocus = undefined
    if (!await controller.navigateTo(target.articleId) || state.tab?.sessionId !== target.sessionId) return
    await focusSource(target, epoch)
  }

  async function reopenRecent(item: RecentlyClosed, event: MouseEvent,
    dialog?: Readonly<{ afterClose: (focus: () => void) => void; current: () => boolean }>): Promise<void> {
    const opener = event.currentTarget
    const current = controller.registry.activeTab
    const epoch = identityEpoch.value
    const path = route.path
    if (await controller.navigateTo(item.articleId, item) || !current || !(opener instanceof HTMLElement)) return
    if (controller.registry.recentlyClosed.some(entry => entry.articleId === item.articleId)) return
    const restore = () => {
      void focusSource(current, epoch, () => !controller.lifetime.signal.aborted && route.path === path &&
        dialog?.current() !== false && !opener.isConnected)
    }
    if (dialog) dialog.afterClose(restore)
    else restore()
  }

  function activateQuickResult(articleId: number, revision: bigint, current: () => boolean, targetGroup?: WorkspaceGroup) {
    return controller.navigateTo(articleId, undefined, targetGroup, { revision, current })
  }

  function focusQuickResult(articleId: number): void {
    const active = controller.registry.activeTab
    if (active?.articleId === articleId) void focusSource(active, identityEpoch.value)
  }

  function quickResultHref(articleId: number): string {
    return router.resolve(articleRouteDestination(articleId)).href
  }

  function arrangeGroups(destination?: WorkspaceGroup): (() => void) | undefined {
    const moved = controller.arrangeGroups(destination)
    if (!moved) return
    deferredFocus = undefined
    const epoch = identityEpoch.value
    return () => { void focusSource(moved, epoch) }
  }

  async function loadImportedDraft(pane: WorkspaceSource<Draft>, imported: DraftMarkdown): Promise<void> {
    const outcome = controller.loadImportedDraft(pane, imported)
    if (!outcome.imported) return
    await nextTick()
    if (!controller.lifetime.signal.aborted && credential.value === outcome.handle &&
        state.tab?.sessionId === outcome.sessionId) {
      document.getElementById('article-title')?.focus()
    }
  }

  async function closeGroupTabs(event: MouseEvent, onlyRight: boolean): Promise<void> {
    const current = controller.registry.activeTab
    if (!current) return
    const focused = event.currentTarget
    const epoch = identityEpoch.value
    const path = route.path
    const isCurrent = () => epoch === identityEpoch.value && !controller.lifetime.signal.aborted &&
      route.path === path && controller.registry.activeTab?.sessionId === current.sessionId
    const result = await controller.closeGroupTabs(onlyRight)
    if (result.focusAction === 'none') return
    await nextTick()
    if (!isCurrent()) return
    if (result.focusAction === 'restore-trigger') {
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true })
    } else if (result.focusAction === 'focus-active-tab') {
      tabsControl.value?.focusActive()
    }
  }

  async function closeTab(target: WorkspaceTab): Promise<void> {
    const focused = document.activeElement
    const epoch = identityEpoch.value
    const path = route.path
    const samePage = () => epoch === identityEpoch.value && !controller.lifetime.signal.aborted && route.path === path
    const result = await controller.closeTab(target)
    if (result.focusAction === 'none') return
    if (result.focusAction === 'restore-trigger') {
      await nextTick()
      if (!samePage()) return
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true })
      else tabsControl.value?.focusActive()
      return
    }
    await nextTick()
    if (controller.registry.activeTab) tabsControl.value?.focusActive()
    else articleInput.value?.focus()
  }

  async function reloadDraft(): Promise<void> {
    if (await controller.reloadDraft()) reload.value++
  }

  const { coordinator: _c, bindActivity: _b, ...handoffPublic } = handoff
  return {
    ...controller,
    ...fields,
    ...flagRefs,
    ...handoffPublic,
    route, id, tabsControl, articleInput, reload, currentSession, identityEpoch, credentialEpoch,
    workspaceState: workspaceHistoryState,
    recovery, recoveryItems, recoveryFailure, recoveryChecking,
    layoutNotice: persistence.notice,
    supportsSavedGroups: persistence.supportsGroups,
    recentOpensVersion, recentOpensNotice, openInput, openAddress, selectedPanelTitle, publishedPath,
    recheckComparison: (candidate: WorkspaceTab, signal: AbortSignal) =>
      controller.registry.recheckComparison(candidate, signal),
    focusSource, focusGroup, reopenRecent, activateQuickResult, focusQuickResult, quickResultHref,
    arrangeGroups, closeGroupTabs, closeTab, loadImportedDraft, reloadDraft,
  }
}
