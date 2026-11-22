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
import { snapshotFields } from './snapshotFields'
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
  const fields = {
    original: shallowRef<Draft | undefined>(initial.original),
    tab: shallowRef<WorkspaceTab | undefined>(initial.tab),
    workspaceTabs: shallowRef<readonly WorkspaceTab[]>(initial.workspaceTabs),
    workspaceRevision: ref(initial.workspaceRevision),
    sourcePanes: shallowRef<readonly WorkspaceSource<Draft>[]>(initial.sourcePanes),
    hasSecondaryGroup: ref(initial.hasSecondaryGroup),
    recentlyClosed: shallowRef<readonly RecentlyClosed[]>(initial.recentlyClosed),
    inspectorOpen: ref(initial.inspectorOpen),
    persistentWorkspace: ref(initial.persistentWorkspace),
    authorizationReady: ref(initial.authorizationReady),
    layoutRestoring: ref(initial.layoutRestoring),
    loading: ref(initial.loading),
    opening: ref(initial.opening),
    closingTabs: ref(initial.closingTabs),
    recoveryWorking: ref(initial.recoveryWorking),
    composing: ref<number | undefined>(initial.composing),
    taxonomyDirty: ref(initial.taxonomyDirty),
    summaryDirty: ref(initial.summaryDirty),
    taxonomyStale: ref(initial.taxonomyStale),
    propertyPending: ref(initial.propertyPending),
    revisionComparisonActive: ref(initial.revisionComparisonActive),
    taxonomyModalActive: ref(initial.taxonomyModalActive),
    notice: ref(initial.notice),
    failure: ref(initial.failure),
    navigationNotice: ref(initial.navigationNotice),
    groupNotice: ref(initial.groupNotice),
    openInput: ref(initial.openInput),
  }
  const { state, update } = snapshotFields(fields)
  const openInput = computed({
    get: () => fields.openInput.value,
    set: value => controller.setOpenInput(value),
  })
  const unsubscribeController = controller.subscribe(() => update(controller.snapshot()))

  const flags = computed(() => deriveWorkspaceFlags({
    state: { ...state },
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
  const selectedPanelTitle = computed(() => state.tab?.title
    ? t('author.write.contentTitle', { title: state.tab.title })
    : t('author.write.articleContent'))
  const configuredPublicOrigin = document.head.querySelector<HTMLMetaElement>('meta[name="fsus-public-origin"]')?.content ?? ''
  const publicBase = configuredPublicOrigin && configuredPublicOrigin !== globalThis.location?.origin ? configuredPublicOrigin : ''
  const publishedPath = computed(() => state.original?.published ? `${publicBase}/article/${state.original.id}` : '')

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
    recoveryWorking: fields.recoveryWorking,
    activeTab: fields.tab,
    propertyPending: fields.propertyPending,
    metadataDirty,
    composing: fields.composing,
    closingTabs: fields.closingTabs,
    revisionComparisonActive: fields.revisionComparisonActive,
  })

  watch([id, identityEpoch, fields.authorizationReady, reload, fields.persistentWorkspace], async ([articleId, identity], _, cleanup) => {
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
    if (epoch !== identityEpoch.value || state.tab?.sessionId !== target.sessionId || !editable.value) return
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
    if (document.activeElement === request.pane && state.tab?.sessionId === request.sessionId && editable.value) {
      document.getElementById('article-body')?.focus({ preventScroll: true })
    }
  })

  async function focusGroup(target: WorkspaceTab): Promise<void> {
    const epoch = identityEpoch.value
    deferredFocus = undefined
    if (!await controller.navigateTo(target.articleId) || state.tab?.sessionId !== target.sessionId) return
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
    original: fields.original,
    tab: fields.tab,
    workspaceTabs: fields.workspaceTabs,
    workspaceRevision: fields.workspaceRevision,
    sourcePanes: fields.sourcePanes,
    hasSecondaryGroup: fields.hasSecondaryGroup,
    recentlyClosed: fields.recentlyClosed,
    inspectorOpen: fields.inspectorOpen,
    persistentWorkspace: fields.persistentWorkspace,
    authorizationReady: fields.authorizationReady,
    loading: fields.loading,
    opening: fields.opening,
    closingTabs: fields.closingTabs,
    recovery,
    recoveryItems,
    recoveryFailure,
    recoveryChecking,
    recoveryWorking: fields.recoveryWorking,
    recoveryBlocked,
    notice: fields.notice,
    failure: fields.failure,
    navigationNotice: fields.navigationNotice,
    groupNotice: fields.groupNotice,
    layoutNotice: persistence.notice,
    supportsSavedGroups: persistence.supportsGroups,
    recentOpensVersion,
    recentOpensNotice,
    openInput,
    openAddress,
    inputArticle,
    selectedPanelTitle,
    articleDirty,
    summaryDirty: fields.summaryDirty,
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
    revisionComparisonActive: fields.revisionComparisonActive,
    taxonomyModalActive: fields.taxonomyModalActive,
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
