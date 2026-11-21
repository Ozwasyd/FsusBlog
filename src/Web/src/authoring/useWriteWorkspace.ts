import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
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
import { credentialEpoch, currentSession, identityEpoch, recheckCredential, refreshSession } from '../authorSession'
import { consumeAuthoringSessionPreload } from '../workspacePreload'
import type WorkspaceTabs from './WorkspaceTabs.vue'
import type { DraftMarkdown } from './draftMarkdownImport'
import { editorRecovery } from './editorRecovery'
import { recentArticleOpens } from './recentArticleOpens'
import { useWriteSourceHandoff } from './useWriteSourceHandoff'
import { confirmDiscardTabDialog, confirmLeaveDialog, confirmProtectedCloseDialog } from './writeCloseDialog'
import { createWriteCommandAdapter } from './writeCommandAdapter'
import { workspacePersistence } from './workspacePersistence'
import {
  articleRouteDestination,
  articleRouteId,
  createWriteWorkspaceController,
  deriveWorkspaceFlags,
  workspaceHistoryState,
  type WriteWorkspaceController,
} from './writeWorkspaceController'
import type { RecentlyClosed, WorkspaceGroup, WorkspaceSource, WorkspaceTab } from './workspaceRegistry'

export function useWriteWorkspace() {
  const route = useRoute()
  const router = useRouter()
  const id = computed(() => articleRouteId(route.name, route.params.id))

  const tabsControl = ref<InstanceType<typeof WorkspaceTabs>>()
  const articleInput = ref<InstanceType<typeof ElInput>>()
  const reload = ref(0)

  const recovery = editorRecovery()
  const recoveryItems = recovery.candidates
  const recoveryFailure = recovery.failure
  const recoveryChecking = recovery.guarded
  const { record: recordRecentOpen, changed: recentOpensVersion, notice: recentOpensNotice } = recentArticleOpens()

  let controller!: WriteWorkspaceController
  const handoff = useWriteSourceHandoff({
    articleId: id,
    credentialEpoch,
    recordRecentOpen,
    setNotice: message => controller.setNotice(message),
  })

  const preloadedAuth = consumeAuthoringSessionPreload() && !handoff.coordinator.hasArrival()
  const commands = createWriteCommandAdapter({
    session: {
      currentHandle: () => currentSession.value?.siteSessionId,
      hasSession: () => Boolean(currentSession.value),
      recheckCredential,
    },
    transport: {
      readDraft: (articleId, signal, handle) => api.draft(articleId, signal, handle),
      articleAction: (action, input, signal, handle) => api[action](input, signal, handle),
      saveWithBodyInsertion,
      saveWithBodyInsertions,
      saveWithBodyEdits,
      assignTaxonomy,
      rollbackDraft,
      setArticleSchedule,
      setDraftRights,
      editArticleMedia,
      saveDraftSummary,
      publishArticleImages,
    },
  })

  const persistence = workspacePersistence(
    () => controller.registry.savedLayout,
    () => controller.registry.hasSecondaryGroup,
  )

  controller = createWriteWorkspaceController({
    origin: location.origin,
    initialPersistentWorkspace: route.name === 'article-workspace' || history.state?.articleWorkspace === true,
    initialAuthorizationReady: preloadedAuth,
    commands,
    handoff: handoff.coordinator,
    session: {
      current: () => currentSession.value,
      identityEpoch: () => identityEpoch.value,
      credentialEpoch: () => credentialEpoch.value,
      refreshSession: (signal, reuseInFlight) => refreshSession(signal, reuseInFlight),
    },
    recovery: {
      candidates: () => recoveryItems.value,
      guarded: () => recoveryChecking.value,
      setCurrent: recovery.setCurrent,
      persist: recovery.persist,
      confirmed: recovery.confirmed,
      remove: recovery.remove,
      discardArticle: recovery.discardArticle,
      verifyCloseCopies: recovery.verifyCloseCopies,
      discardCloseCopies: recovery.discardCloseCopies,
      dismissCandidates: recovery.dismissCandidates,
      close: recovery.close,
    },
    persistence: {
      reset: persistence.reset,
      restore: persistence.restore,
      rebind: persistence.rebind,
      changed: persistence.changed,
      flush: persistence.flush,
    },
    router: {
      articleId: () => id.value,
      path: () => route.path,
      resolveArticlePath: articleId => router.resolve(articleRouteDestination(articleId)).path,
      pushArticle: async (articleId, persistent) => Boolean(await router.push({
        ...articleRouteDestination(articleId),
        state: persistent ? workspaceHistoryState : undefined,
      })),
      replaceArticle: async (articleId, persistent) => Boolean(await router.replace({
        ...articleRouteDestination(articleId),
        state: persistent ? workspaceHistoryState : undefined,
      })),
      replaceWorkspace: async persistent => Boolean(await router.replace({
        name: 'article-workspace',
        state: persistent ? workspaceHistoryState : undefined,
      })),
    },
    confirm: {
      confirmProtectedClose: confirmProtectedCloseDialog,
      confirmDiscardTab: confirmDiscardTabDialog,
      confirmLeave: confirmLeaveDialog,
    },
    format: (key, params) => t(key, params),
    recordRecentOpen,
    scheduleTick: callback => { void nextTick(callback) },
  })

  const initial = controller.snapshot()
  const original = shallowRef<Draft | undefined>(initial.original)
  const tab = shallowRef<WorkspaceTab | undefined>(initial.tab)
  const workspaceTabs = shallowRef<readonly WorkspaceTab[]>(initial.workspaceTabs)
  const workspaceRevision = ref(initial.workspaceRevision)
  const sourcePanes = shallowRef<readonly WorkspaceSource<Draft>[]>(initial.sourcePanes)
  const hasSecondaryGroup = ref(initial.hasSecondaryGroup)
  const recentlyClosed = shallowRef<readonly RecentlyClosed[]>(initial.recentlyClosed)
  const inspectorOpen = ref(initial.inspectorOpen)
  const persistentWorkspace = ref(initial.persistentWorkspace)
  const authorizationReady = ref(initial.authorizationReady)
  const layoutRestoring = ref(initial.layoutRestoring)
  const loading = ref(initial.loading)
  const opening = ref(initial.opening)
  const closingTabs = ref(initial.closingTabs)
  const recoveryWorking = ref(initial.recoveryWorking)
  const composing = ref<number | undefined>(initial.composing)
  const taxonomyDirty = ref(initial.taxonomyDirty)
  const summaryDirty = ref(initial.summaryDirty)
  const taxonomyStale = ref(initial.taxonomyStale)
  const propertyPending = ref(initial.propertyPending)
  const revisionComparisonActive = ref(initial.revisionComparisonActive)
  const taxonomyModalActive = ref(initial.taxonomyModalActive)
  const notice = ref(initial.notice)
  const failure = ref(initial.failure)
  const navigationNotice = ref(initial.navigationNotice)
  const groupNotice = ref(initial.groupNotice)
  const openInput = computed({
    get: () => openInputState.value,
    set: value => controller.setOpenInput(value),
  })
  const openInputState = ref(initial.openInput)

  const unsubscribeController = controller.subscribe(() => {
    const snap = controller.snapshot()
    if (original.value !== snap.original) original.value = snap.original
    if (tab.value !== snap.tab) tab.value = snap.tab
    if (workspaceTabs.value !== snap.workspaceTabs) workspaceTabs.value = snap.workspaceTabs
    if (workspaceRevision.value !== snap.workspaceRevision) workspaceRevision.value = snap.workspaceRevision
    if (sourcePanes.value !== snap.sourcePanes) sourcePanes.value = snap.sourcePanes
    if (hasSecondaryGroup.value !== snap.hasSecondaryGroup) hasSecondaryGroup.value = snap.hasSecondaryGroup
    if (recentlyClosed.value !== snap.recentlyClosed) recentlyClosed.value = snap.recentlyClosed
    if (inspectorOpen.value !== snap.inspectorOpen) inspectorOpen.value = snap.inspectorOpen
    if (persistentWorkspace.value !== snap.persistentWorkspace) persistentWorkspace.value = snap.persistentWorkspace
    if (authorizationReady.value !== snap.authorizationReady) authorizationReady.value = snap.authorizationReady
    if (layoutRestoring.value !== snap.layoutRestoring) layoutRestoring.value = snap.layoutRestoring
    if (loading.value !== snap.loading) loading.value = snap.loading
    if (opening.value !== snap.opening) opening.value = snap.opening
    if (closingTabs.value !== snap.closingTabs) closingTabs.value = snap.closingTabs
    if (recoveryWorking.value !== snap.recoveryWorking) recoveryWorking.value = snap.recoveryWorking
    if (composing.value !== snap.composing) composing.value = snap.composing
    if (taxonomyDirty.value !== snap.taxonomyDirty) taxonomyDirty.value = snap.taxonomyDirty
    if (summaryDirty.value !== snap.summaryDirty) summaryDirty.value = snap.summaryDirty
    if (taxonomyStale.value !== snap.taxonomyStale) taxonomyStale.value = snap.taxonomyStale
    if (propertyPending.value !== snap.propertyPending) propertyPending.value = snap.propertyPending
    if (revisionComparisonActive.value !== snap.revisionComparisonActive) {
      revisionComparisonActive.value = snap.revisionComparisonActive
    }
    if (taxonomyModalActive.value !== snap.taxonomyModalActive) taxonomyModalActive.value = snap.taxonomyModalActive
    if (notice.value !== snap.notice) notice.value = snap.notice
    if (failure.value !== snap.failure) failure.value = snap.failure
    if (navigationNotice.value !== snap.navigationNotice) navigationNotice.value = snap.navigationNotice
    if (groupNotice.value !== snap.groupNotice) groupNotice.value = snap.groupNotice
    if (openInputState.value !== snap.openInput) openInputState.value = snap.openInput
  })

  const flags = computed(() => deriveWorkspaceFlags({
    state: {
      original: original.value,
      tab: tab.value,
      workspaceTabs: workspaceTabs.value,
      workspaceRevision: workspaceRevision.value,
      sourcePanes: sourcePanes.value,
      hasSecondaryGroup: hasSecondaryGroup.value,
      recentlyClosed: recentlyClosed.value,
      inspectorOpen: inspectorOpen.value,
      persistentWorkspace: persistentWorkspace.value,
      authorizationReady: authorizationReady.value,
      layoutRestoring: layoutRestoring.value,
      loading: loading.value,
      opening: opening.value,
      closingTabs: closingTabs.value,
      recoveryWorking: recoveryWorking.value,
      composing: composing.value,
      taxonomyDirty: taxonomyDirty.value,
      summaryDirty: summaryDirty.value,
      taxonomyStale: taxonomyStale.value,
      propertyPending: propertyPending.value,
      revisionComparisonActive: revisionComparisonActive.value,
      taxonomyModalActive: taxonomyModalActive.value,
      notice: notice.value,
      failure: failure.value,
      navigationNotice: navigationNotice.value,
      groupNotice: groupNotice.value,
      openInput: openInputState.value,
    },
    articleId: id.value,
    session: currentSession.value,
    recoveryItemsCount: recoveryItems.value.length,
    recoveryChecking: recoveryChecking.value,
  }))

  const metadataDirty = computed(() => flags.value.metadataDirty)
  const recoveryBlocked = computed(() => flags.value.recoveryBlocked)
  const articleDirty = computed(() => flags.value.articleDirty)
  const dirty = computed(() => flags.value.dirty)
  const hasConflict = computed(() => flags.value.hasConflict)
  const articlePending = computed(() => flags.value.articlePending)
  const pending = computed(() => flags.value.pending)
  const canSwitch = computed(() => flags.value.canSwitch)
  const retry = computed(() => flags.value.retry)
  const validBody = computed(() => flags.value.validBody)
  const editable = computed(() => flags.value.editable)
  const cannotWrite = computed(() => flags.value.cannotWrite)
  const credential = computed(() => flags.value.credential)
  const canImportDraft = computed(() => flags.value.canImportDraft)
  const canPreviewPlugin = computed(() => flags.value.canPreviewPlugin)
  const canChangeSummary = computed(() => flags.value.canChangeSummary)
  const canArrangeGroups = computed(() => flags.value.canArrangeGroups)
  const otherGroup = computed(() => flags.value.otherGroup)
  const activeGroupTabs = computed(() => flags.value.activeGroupTabs)
  const activeGroupIndex = computed(() => flags.value.activeGroupIndex)
  const canCloseGroupTabs = computed(() => flags.value.canCloseGroupTabs)
  const canPublishImages = computed(() => flags.value.canPublishImages)
  const inputArticle = computed(() => flags.value.inputArticle)
  const openAddress = computed(() => {
    const articleId = inputArticle.value
    return articleId === undefined ? undefined : articleRouteDestination(articleId)
  })
  const selectedPanelTitle = computed(() => tab.value?.title
    ? t('author.write.contentTitle', { title: tab.value.title })
    : t('author.write.articleContent'))
  const configuredPublicOrigin = document.head.querySelector<HTMLMetaElement>('meta[name="fsus-public-origin"]')?.content ?? ''
  const publicBase = configuredPublicOrigin && configuredPublicOrigin !== globalThis.location?.origin ? configuredPublicOrigin : ''
  const publishedPath = computed(() => original.value?.published ? `${publicBase}/article/${original.value.id}` : '')

  let deferredFocus: Readonly<{ sessionId: number; epoch: number; pane: HTMLElement }> | undefined

  watch([currentSession, identityEpoch], ([session, epoch]) => {
    controller.syncIdentity(session, epoch)
  }, { immediate: true, flush: 'sync' })

  watch([identityEpoch, () => currentSession.value?.canAuthor], ([epoch, author]) => {
    if (!author) recovery.close()
    else {
      void recovery.attach(
        epoch,
        () => identityEpoch.value === epoch && currentSession.value?.canAuthor === true,
        () => currentSession.value?.siteSessionId,
      )
    }
  }, { immediate: true })

  watch(identityEpoch, () => {
    controller.onIdentityEpochChanged()
    deferredFocus = undefined
  })

  handoff.bindActivity({
    recoveryItems,
    recoveryWorking,
    activeTab: tab,
    propertyPending,
    metadataDirty,
    composing,
    closingTabs,
    revisionComparisonActive,
  })

  watch([id, identityEpoch, authorizationReady, reload, persistentWorkspace], async ([articleId, identity], _, cleanup) => {
    let valid = true
    cleanup(() => { valid = false })
    await controller.syncRoute({ articleId, identity, isValid: () => valid })
  }, { immediate: true })

  onBeforeRouteUpdate((to, from) => controller.beforeRouteUpdate({
    toPath: to.path,
    fromPath: from.path,
    toArticleId: articleRouteId(to.name, to.params.id),
  }))

  onBeforeRouteLeave(() => controller.beforeRouteLeave())

  function onUnload(event: BeforeUnloadEvent): void {
    if (controller.shouldPreventUnload()) event.preventDefault()
  }

  function flushWorkspace(): void {
    void persistence.flush()
  }

  function flushHiddenWorkspace(): void {
    if (document.visibilityState === 'hidden') flushWorkspace()
  }

  onMounted(() => {
    void controller.mountSessionCheck(preloadedAuth)
    window.addEventListener('beforeunload', onUnload)
    window.addEventListener('pagehide', flushWorkspace)
    window.addEventListener('offline', persistence.offline)
    document.addEventListener('visibilitychange', flushHiddenWorkspace)
  })

  onUnmounted(() => {
    controller.dispose()
    unsubscribeController()
    window.removeEventListener('beforeunload', onUnload)
    window.removeEventListener('pagehide', flushWorkspace)
    window.removeEventListener('offline', persistence.offline)
    document.removeEventListener('visibilitychange', flushHiddenWorkspace)
  })

  async function focusSource(target: WorkspaceTab, epoch: number): Promise<void> {
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
    if (document.activeElement === request.pane && tab.value?.sessionId === request.sessionId && editable.value) {
      document.getElementById('article-body')?.focus({ preventScroll: true })
    }
  })

  async function focusGroup(target: WorkspaceTab): Promise<void> {
    const epoch = identityEpoch.value
    deferredFocus = undefined
    if (!await controller.navigateTo(target.articleId) || tab.value?.sessionId !== target.sessionId) return
    await focusSource(target, epoch)
  }

  async function reopenRecent(item: RecentlyClosed, event: MouseEvent): Promise<void> {
    const opener = event.currentTarget
    const current = controller.registry.activeTab
    const epoch = identityEpoch.value
    if (await controller.navigateTo(item.articleId, item) || !current || !(opener instanceof HTMLElement)) return
    await nextTick()
    if (!opener.isConnected && document.activeElement === document.body) await focusSource(current, epoch)
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

  function arrangeGroups(destination?: WorkspaceGroup): void {
    const moved = controller.arrangeGroups(destination)
    if (!moved) return
    deferredFocus = undefined
    void focusSource(moved, identityEpoch.value)
  }

  async function loadImportedDraft(pane: WorkspaceSource<Draft>, imported: DraftMarkdown): Promise<void> {
    const outcome = controller.loadImportedDraft(pane, imported)
    if (!outcome.imported) return
    await nextTick()
    if (!controller.lifetime.signal.aborted && credential.value === outcome.handle &&
        tab.value?.sessionId === outcome.sessionId) {
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

  return {
    route,
    id,
    tabsControl,
    articleInput,
    reload,
    currentSession,
    identityEpoch,
    credentialEpoch,
    workspaceState: workspaceHistoryState,
    original,
    tab,
    workspaceTabs,
    workspaceRevision,
    sourcePanes,
    hasSecondaryGroup,
    recentlyClosed,
    inspectorOpen,
    persistentWorkspace,
    authorizationReady,
    loading,
    opening,
    closingTabs,
    recovery,
    recoveryItems,
    recoveryFailure,
    recoveryChecking,
    recoveryWorking,
    recoveryBlocked,
    notice,
    failure,
    navigationNotice,
    groupNotice,
    layoutNotice: persistence.notice,
    supportsSavedGroups: persistence.supportsGroups,
    recentOpensVersion,
    recentOpensNotice,
    openInput,
    openAddress,
    inputArticle,
    selectedPanelTitle,
    articleDirty,
    summaryDirty,
    metadataDirty,
    dirty,
    hasConflict,
    articlePending,
    pending,
    canSwitch,
    retry,
    validBody,
    editable,
    cannotWrite,
    credential,
    publishedPath,
    canImportDraft,
    canPreviewPlugin,
    canChangeSummary,
    canArrangeGroups,
    otherGroup,
    activeGroupTabs,
    activeGroupIndex,
    canCloseGroupTabs,
    canPublishImages,
    revisionComparisonActive,
    taxonomyModalActive,
    sourceInspectorPending: handoff.sourceInspectorPending,
    sourceSeek: handoff.sourceSeek,
    historicalSeek: handoff.historicalSeek,
    propertySeek: handoff.propertySeek,
    summarySeek: handoff.summarySeek,
    finishSourceSeek: handoff.finishSourceSeek,
    finishHistoricalSeek: handoff.finishHistoricalSeek,
    closeHistoricalSeek: handoff.closeHistoricalSeek,
    finishPropertySeek: handoff.finishPropertySeek,
    recheckComparison: (candidate: WorkspaceTab, signal: AbortSignal) =>
      controller.registry.recheckComparison(candidate, signal),
    focusSource,
    focusGroup,
    reopenRecent,
    activateQuickResult,
    focusQuickResult,
    quickResultHref,
    openArticle: controller.openArticle,
    openSavedWorkspace: controller.openSavedWorkspace,
    navigateTo: controller.navigateTo,
    paneFocused: controller.paneFocused,
    changeComposition: controller.changeComposition,
    canMoveBackgroundTab: controller.canMoveBackgroundTab,
    moveBackgroundTab: controller.moveBackgroundTab,
    arrangeGroups,
    setInspectorOpen: controller.setInspectorOpen,
    togglePin: controller.togglePin,
    closeGroupTabs,
    closeTab,
    edit: controller.edit,
    loadImportedDraft,
    restoreDraft: controller.restoreDraft,
    submit: controller.submit,
    publishSelectedImages: controller.publishSelectedImages,
    saveSummary: controller.saveSummary,
    reloadDraft,
    setTaxonomyDirty: controller.setTaxonomyDirty,
    setSummaryDirty: controller.setSummaryDirty,
    markTaxonomyStale: controller.markTaxonomyStale,
    setPropertyPending: controller.setPropertyPending,
    setRevisionComparisonActive: controller.setRevisionComparisonActive,
    setTaxonomyModalActive: controller.setTaxonomyModalActive,
  }
}
