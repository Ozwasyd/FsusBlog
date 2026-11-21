import type { BodyEdit } from '../../../Contracts/article-body-insertion.ts'
import type { AttachmentEdit } from '../../../Contracts/article-media.ts'
import type { RightsEdit } from '../../../Contracts/article-rights.ts'
import type { DraftSummaryEdit } from '../../../Contracts/article-summary-client.ts'
import type { Session } from '../../../Contracts/client.ts'
import type { PublishImagesSelection } from '../../../Contracts/published-media.ts'
import type { TaxonomySelection } from '../../../Contracts/taxonomy-client.ts'
import type { Draft } from '../../../Contracts/wire.generated.ts'
import type { RecoveryCandidate } from './draftJournal.ts'
import { validDraftBody, validDraftTitle, type DraftMarkdown } from './draftMarkdownImport.ts'
import type { SourceHandoffCoordinator, SourceHandoffNoticeKey } from './sourceHandoffCoordinator.ts'
import {
  closeRiskMessageKey,
  failureMessageKeyByReason,
  savedMessageKeyByAction,
  type ArticleAction,
  type RestoreSelection,
  type WriteAction,
  type WriteCommandAdapter,
} from './writeCommandAdapter.ts'
import {
  WorkspaceRegistry,
  type Activation,
  type ClosePlan,
  type CloseReservation,
  type EditorTransport,
  type RecentlyClosed,
  type RecoverableCloseDraft,
  type SavedWorkspaceLayout,
  type WorkspaceGroup,
  type WorkspaceSource,
  type WorkspaceTab,
} from './workspaceRegistry.ts'

export const workspaceHistoryState = Object.freeze({ articleWorkspace: true })

export type WriteMessageKey =
  | SourceHandoffNoticeKey
  | (typeof failureMessageKeyByReason)[keyof typeof failureMessageKeyByReason]
  | (typeof savedMessageKeyByAction)[keyof typeof savedMessageKeyByAction]
  | (typeof closeRiskMessageKey)[keyof typeof closeRiskMessageKey]
  | 'author.write.couldNotVerifyYourSession'
  | 'author.write.thisEditorLinkHasExpiredReturnToIts'
  | 'author.write.thisWorkspaceHas100OpenArticlesCloseA'
  | 'author.write.applyOrCancelThePendingChangesBeforeSwitching'
  | 'author.write.theServerHasANewerRevisionCopyYour'
  | 'author.write.enterAValidArticleId'
  | 'author.write.movedTitlePrimary'
  | 'author.write.movedTitleSecondary'
  | 'author.write.movedPrimary'
  | 'author.write.movedSecondary'
  | 'author.write.mergedBothGroupsIntoThePrimaryGroup'
  | 'author.write.saveChangesAndCloseTheCurrentPreviewBefore'
  | 'author.write.changedOnServer'
  | 'author.write.cleanupUnconfirmed'
  | 'author.write.rejectedTitle'
  | 'author.write.saveBlocked'
  | 'author.write.saveUnconfirmed'
  | 'author.write.tabsStillOpenFailure'
  | 'author.write.savedTitlesPrefix'
  | 'author.write.savedTitlesOpen'
  | 'author.write.closeBlocked'
  | 'author.write.couldNotVerifyRecoveryCopiesSaveTheDrafts'
  | 'author.write.couldNotDiscardTheRecoveryCopiesTheTabs'
  | 'author.write.tabsChangedBeforeClosingTryAgain'
  | 'author.write.closed1Tab'
  | 'author.write.closedTabs'
  | 'author.write.applyOrCancelThePendingChangesBeforeClosing'
  | 'author.write.resolveThePendingChangesBeforeClosingThisTab'
  | 'author.write.markdownLoadedSaveToKeepThisDraft'
  | 'author.write.draftSavedRecoveryCleanupIsUnfinishedTryAgain'
  | 'author.write.theServerRejectedThisChangeCheckTheDraft'

export type MessageFormatter = (key: WriteMessageKey, params?: Record<string, string | number>) => string

export type ArticleRouteDestination =
  | Readonly<{ name: 'write' }>
  | Readonly<{ name: 'edit'; params: Readonly<{ id: number }> }>

export type ArticleSelection = Readonly<{
  revision: bigint
  current: () => boolean
}>

type NavigationIntent = {
  path: string
  restore?: RecentlyClosed
  targetGroup?: WorkspaceGroup
  selection?: ArticleSelection
  witness?: Readonly<{ sessionId: number; articleRevision: bigint }>
}

export type ProtectedCloseChoice = 'keep' | 'discard' | 'save' | 'cancelled'

export type ProtectedCloseOutcome =
  | 'closed'
  | 'cancelled'
  | 'protected'
  | 'stale'
  | 'copies-unavailable'
  | 'discard-unavailable'
  | Readonly<{ message: string }>

export type CloseGroupResult = Readonly<{
  outcome: ProtectedCloseOutcome | 'noop'
  focusAction: 'none' | 'restore-trigger' | 'focus-active-tab'
}>

export type CloseTabResult = Readonly<{
  outcome: ProtectedCloseOutcome | 'blocked' | 'noop'
  focusAction: 'none' | 'restore-trigger' | 'focus-active-tab' | 'focus-article-input'
}>

export interface WorkspaceSessionPort {
  current(): Session | null
  identityEpoch(): number
  credentialEpoch(): number
  refreshSession(signal: AbortSignal, reuseInFlight: boolean): Promise<void>
}

export interface WorkspaceRecoveryPort {
  candidates(): readonly RecoveryCandidate[]
  guarded(): boolean
  setCurrent(tab: WorkspaceTab | undefined, draft: Draft | undefined, edit: number): void
  persist(draft: Draft, edit: number): void
  confirmed: NonNullable<EditorTransport<Draft>['confirmed']>
  remove(candidate: RecoveryCandidate, keep?: { draft: Draft; edit: number }): Promise<boolean>
  discardArticle(id: number, sessionId: number, edit: number): Promise<unknown> | void
  verifyCloseCopies(drafts: readonly RecoverableCloseDraft<Draft>[]): Promise<boolean>
  discardCloseCopies(reservation: CloseReservation<Draft>): Promise<boolean>
  dismissCandidates(): void
  close(): void
}

export interface WorkspacePersistencePort {
  reset(): void
  restore(
    handle: string,
    restoreLayout: (layout: SavedWorkspaceLayout, signal: AbortSignal) => Promise<number | undefined>,
  ): Promise<void>
  rebind(handle: string): void
  changed(): void
  flush(): Promise<void>
}

export interface WorkspaceRouterPort {
  articleId(): number | undefined
  path(): string
  resolveArticlePath(articleId: number): string
  pushArticle(articleId: number, persistentWorkspace: boolean): Promise<boolean>
  replaceArticle(articleId: number, persistentWorkspace: boolean): Promise<boolean>
  replaceWorkspace(persistentWorkspace: boolean): Promise<boolean>
}

export interface WorkspaceConfirmPort {
  confirmProtectedClose(input: Readonly<{
    plan: ClosePlan
    hasKeepCopies: boolean
    canSave: boolean
    canDiscard: boolean
    current: () => boolean
  }>): Promise<ProtectedCloseChoice>
  confirmDiscardTab(title: string): Promise<boolean>
  confirmLeave(candidates: readonly WorkspaceTab[]): Promise<boolean>
}

export interface WriteWorkspaceControllerPorts {
  origin: string
  initialPersistentWorkspace: boolean
  initialAuthorizationReady: boolean
  commands: WriteCommandAdapter
  handoff: SourceHandoffCoordinator
  session: WorkspaceSessionPort
  recovery: WorkspaceRecoveryPort
  persistence: WorkspacePersistencePort
  router: WorkspaceRouterPort
  confirm: WorkspaceConfirmPort
  format: MessageFormatter
  recordRecentOpen(articleId: number, revision: bigint): void
  scheduleTick(callback: () => void): void
  nowMs?: () => number
  limit?: number
  newRequestKey?: ConstructorParameters<typeof WorkspaceRegistry<Draft>>[3]
}

export type WriteWorkspaceState = Readonly<{
  original: Draft | undefined
  tab: WorkspaceTab | undefined
  workspaceTabs: readonly WorkspaceTab[]
  workspaceRevision: number
  sourcePanes: readonly WorkspaceSource<Draft>[]
  hasSecondaryGroup: boolean
  recentlyClosed: readonly RecentlyClosed[]
  inspectorOpen: boolean
  persistentWorkspace: boolean
  authorizationReady: boolean
  layoutRestoring: boolean
  loading: boolean
  opening: boolean
  closingTabs: boolean
  recoveryWorking: boolean
  composing: number | undefined
  taxonomyDirty: boolean
  summaryDirty: boolean
  taxonomyStale: boolean
  propertyPending: boolean
  revisionComparisonActive: boolean
  taxonomyModalActive: boolean
  notice: string
  failure: string
  navigationNotice: string
  groupNotice: string
  openInput: string
}>

export type DeriveWorkspaceFlagsInput = Readonly<{
  state: WriteWorkspaceState
  articleId: number | undefined
  session: Session | null
  recoveryItemsCount: number
  recoveryChecking: boolean
}>

export type WriteWorkspaceFlags = Readonly<{
  metadataDirty: boolean
  recoveryBlocked: boolean
  articleDirty: boolean
  dirty: boolean
  hasConflict: boolean
  articlePending: boolean
  pending: boolean
  canSwitch: boolean
  retry: WorkspaceTab['retry']
  validTitle: boolean
  validBody: boolean
  editable: boolean
  cannotWrite: boolean
  credential: string | undefined
  canImportDraft: boolean
  canPreviewPlugin: boolean
  canChangeSummary: boolean
  canArrangeGroups: boolean
  otherGroup: WorkspaceGroup | undefined
  activeGroupTabs: readonly WorkspaceTab[]
  activeGroupIndex: number
  canCloseGroupTabs: boolean
  canPublishImages: boolean
  inputArticle: number | undefined
}>

export function articleRouteId(name: unknown, idParam: unknown): number | undefined {
  if (name === 'write') return 0
  if (name === 'edit') return Number(idParam)
  return undefined
}

export function articleRouteDestination(articleId: number): ArticleRouteDestination {
  return articleId === 0 ? { name: 'write' } : { name: 'edit', params: { id: articleId } }
}

export function parseArticleIdInput(raw: string): number | undefined {
  const input = raw.trim()
  const articleId = Number(input)
  return /^[1-9][0-9]{0,9}$/.test(input) && articleId <= 2_147_483_647 ? articleId : undefined
}

export function deriveWorkspaceFlags(input: DeriveWorkspaceFlagsInput): WriteWorkspaceFlags {
  const { state, articleId, session, recoveryItemsCount, recoveryChecking } = input
  const { tab, original } = state
  const metadataDirty = state.taxonomyDirty || state.summaryDirty
  const recoveryBlocked = state.recoveryWorking || recoveryChecking || recoveryItemsCount > 0
  const articleDirty = tab?.risk === 'dirty' || tab?.risk === 'conflict'
  const dirty = articleDirty || metadataDirty
  const hasConflict = state.taxonomyStale || tab?.risk === 'conflict'
  const articlePending = tab?.risk === 'saving'
  const pending = articlePending || state.propertyPending
  const canSwitch = !state.layoutRestoring && !state.propertyPending && !metadataDirty && !state.recoveryWorking &&
    !state.closingTabs && !state.taxonomyModalActive && state.composing === undefined &&
    !(articlePending && tab?.articleId === 0)
  const retry = tab?.retry
  const validTitle = validDraftTitle(original?.title ?? '')
  const validBody = validDraftBody(original?.body ?? '')
  const editable = Boolean(session?.canAuthor && original?.id === articleId && !state.loading)
  const cannotWrite = state.closingTabs || pending || recoveryBlocked || hasConflict || metadataDirty ||
    !validBody || !validTitle
  const credential = session?.siteSessionId
  const canImportDraft = !!credential && editable && canSwitch && !state.opening && !pending && !recoveryBlocked &&
    !hasConflict && !retry && tab?.risk === 'clean' && original?.id === 0 && original.title === '' && original.body === ''
  const canPreviewPlugin = !!credential && editable && canSwitch && !state.opening && !pending && !recoveryBlocked &&
    !hasConflict && !retry && tab?.risk === 'clean' && original !== undefined && original.id > 0 && original.revision > 0n
  const canChangeSummary = !!credential && editable && tab?.risk === 'clean' && !state.closingTabs && !pending &&
    !recoveryBlocked && !hasConflict && !state.taxonomyDirty && validBody && validTitle
  const canArrangeGroups = !!credential && editable && !state.opening && !state.layoutRestoring && !state.closingTabs &&
    state.composing === undefined && !state.revisionComparisonActive
  const otherGroup: WorkspaceGroup | undefined = tab && (tab.group === 'main' ? 'secondary' : 'main')
  const activeGroupTabs = state.workspaceTabs.filter(candidate => candidate.group === tab?.group)
  const activeGroupIndex = activeGroupTabs.findIndex(candidate => candidate.active)
  const canCloseGroupTabs = editable && canSwitch && !state.opening && !state.revisionComparisonActive
  const canPublishImages = !!credential && editable && tab?.risk === 'clean' && !cannotWrite && !dirty && !retry &&
    !!original?.body.trim()
  const inputArticle = parseArticleIdInput(state.openInput)

  return {
    metadataDirty,
    recoveryBlocked,
    articleDirty,
    dirty,
    hasConflict,
    articlePending,
    pending,
    canSwitch,
    retry,
    validTitle,
    validBody,
    editable,
    cannotWrite,
    credential,
    canImportDraft,
    canPreviewPlugin,
    canChangeSummary,
    canArrangeGroups,
    otherGroup,
    activeGroupTabs,
    activeGroupIndex,
    canCloseGroupTabs,
    canPublishImages,
    inputArticle,
  }
}

export function createWriteWorkspaceController(ports: WriteWorkspaceControllerPorts) {
  const {
    commands,
    handoff,
    session,
    recovery,
    persistence,
    router,
    confirm,
    format,
    recordRecentOpen,
    scheduleTick,
  } = ports
  const nowMs = ports.nowMs ?? Date.now
  const lifetime = new AbortController()
  const listeners = new Set<() => void>()

  const registry = new WorkspaceRegistry<Draft>({
    load: commands.loadDraft,
    save: commands.articleCommand('save'),
    confirmed: recovery.confirmed,
  }, ports.limit, nowMs, ports.newRequestKey)

  let state: WriteWorkspaceState = {
    original: undefined,
    tab: undefined,
    workspaceTabs: [],
    workspaceRevision: 0,
    sourcePanes: [],
    hasSecondaryGroup: false,
    recentlyClosed: [],
    inspectorOpen: false,
    persistentWorkspace: ports.initialPersistentWorkspace,
    authorizationReady: ports.initialAuthorizationReady,
    layoutRestoring: false,
    loading: false,
    opening: false,
    closingTabs: false,
    recoveryWorking: false,
    composing: undefined,
    taxonomyDirty: false,
    summaryDirty: false,
    taxonomyStale: false,
    propertyPending: false,
    revisionComparisonActive: false,
    taxonomyModalActive: false,
    notice: '',
    failure: '',
    navigationNotice: '',
    groupNotice: '',
    openInput: '',
  }

  let layoutStarted = false
  let workspaceIdentity: number | undefined
  let persistedSession: string | undefined
  let navigation = 0
  let explicitNavigation: NavigationIntent | undefined
  let disposed = false

  function emit(): void {
    for (const listener of listeners) listener()
  }

  function patch(partial: Partial<WriteWorkspaceState>): void {
    state = { ...state, ...partial }
    emit()
  }

  function flags(): WriteWorkspaceFlags {
    return deriveWorkspaceFlags({
      state,
      articleId: router.articleId(),
      session: session.current(),
      recoveryItemsCount: recovery.candidates().length,
      recoveryChecking: recovery.guarded(),
    })
  }

  const unsubscribeRegistry = registry.subscribe(() => {
    const next = registry.activeDraft
    const draftChanged = next?.id !== state.original?.id || next?.revision !== state.original?.revision
    state = {
      ...state,
      ...(draftChanged ? { taxonomyDirty: false, summaryDirty: false, taxonomyStale: false } : {}),
      original: next,
      tab: registry.activeTab,
      workspaceTabs: registry.tabs,
      workspaceRevision: registry.revision,
      sourcePanes: registry.sourcePanes,
      hasSecondaryGroup: registry.hasSecondaryGroup,
      recentlyClosed: registry.recentlyClosed,
      inspectorOpen: registry.inspectorOpen,
    }
    recovery.setCurrent(state.tab, next, registry.activeEditSequence)
    persistence.changed()
    emit()
  })

  function paneFocused(pane: WorkspaceSource<Draft>): boolean {
    return flags().editable && pane.selected && pane.tab.active && state.tab?.sessionId === pane.tab.sessionId
  }

  function activationFailure(receipt: Activation): string {
    if (receipt.kind === 'blocked') return format(failureMessageKeyByReason[receipt.reason])
    if (receipt.kind === 'capacity') return format('author.write.thisWorkspaceHas100OpenArticlesCloseA')
    return ''
  }

  function activateArticle(
    articleId: number,
    targetGroup?: WorkspaceGroup,
    mode?: WorkspaceTab['mode'],
    ready?: () => boolean,
    requiredRevision?: bigint,
    allowRetainedEdits = false,
  ): Promise<Activation> {
    return articleId === 0
      ? registry.startDraft({ id: 0, revision: 0n, title: '', body: '', published: false })
      : registry.openOrActivate(articleId, targetGroup, mode, ready, requiredRevision, allowRetainedEdits)
  }

  function setInspectorOpen(open: boolean): void {
    if (state.persistentWorkspace && state.tab) registry.setInspectorOpen(state.tab, open)
    if (!open) {
      const closed = handoff.onInspectorClosed()
      if (closed.noticeKey) patch({ notice: format(closed.noticeKey) })
    }
  }

  async function saveAndCloseTabs(plan: ClosePlan, current: () => boolean): Promise<ProtectedCloseOutcome> {
    const reservation = registry.reserveClose(plan, 'save')
    if (!reservation) return 'stale'
    const saved: string[] = []
    try {
      for (const { draft } of reservation.drafts) {
        const target = plan.tabs.find(candidate => candidate.articleId === draft.id)
        if (!target || !current() || !reservation.current()) return 'stale'
        const result = await registry.saveReserved(target, reservation)
        if (result.kind === 'saved') saved.push(target.title)
        if (result.kind === 'saved' && result.recoverySettled) continue
        const failure = result.kind === 'conflict'
          ? format('author.write.changedOnServer', { title: target.title })
          : result.kind === 'saved'
            ? format('author.write.cleanupUnconfirmed', { title: target.title })
            : result.kind === 'rejected'
              ? format('author.write.rejectedTitle', { title: target.title })
              : result.kind === 'blocked' && result.reason !== 'unavailable'
                ? format('author.write.saveBlocked', {
                    title: target.title,
                    reason: format(failureMessageKeyByReason[result.reason]),
                  })
                : format('author.write.saveUnconfirmed', { title: target.title })
        return {
          message: format('author.write.tabsStillOpenFailure', {
            saved: saved.length ? format('author.write.savedTitlesPrefix', { titles: saved.join(', ') }) : '',
            failure,
          }),
        }
      }
      if (!current()) return 'stale'
      const result = registry.completeClose(reservation, true)
      if (result.kind === 'protected') {
        return { message: format('author.write.savedTitlesOpen', { titles: saved.join(', ') }) }
      }
      return result.kind
    } finally {
      if (reservation.current()) registry.completeClose(reservation, false)
    }
  }

  async function confirmProtectedClose(plan: ClosePlan, current: () => boolean): Promise<ProtectedCloseOutcome> {
    const drafts = registry.recoveryDraftsForClose(plan)
    const saveDrafts = drafts ?? registry.recoveryDraftsForClose(plan, true)
    const allSaved = plan.tabs.every(candidate => candidate.articleId > 0)
    const canSave = allSaved && !!saveDrafts?.length && plan.tabs.every(candidate => candidate.risk !== 'conflict') &&
      saveDrafts.every(({ draft }) => validDraftTitle(draft.title) && validDraftBody(draft.body))
    if (!drafts?.length && !canSave) return 'protected'

    patch({ closingTabs: true })
    try {
      const choice = await confirm.confirmProtectedClose({
        plan,
        hasKeepCopies: !!drafts?.length,
        canSave,
        canDiscard: allSaved && !!drafts?.length,
        current,
      })
      if (choice === 'cancelled') return 'cancelled'
      if (!current() || registry.revision !== plan.revision) return 'stale'
      if (choice === 'save') return canSave ? await saveAndCloseTabs(plan, current) : 'protected'
      if (choice === 'discard') {
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
      patch({ closingTabs: false })
    }
  }

  function failedCloseNotice(outcome: ProtectedCloseOutcome, plan?: ClosePlan): string {
    const blocked = plan?.tabs.flatMap(({ title, risk }) =>
      risk === 'clean' ? [] : [`${title} (${format(closeRiskMessageKey[risk])})`]) ?? []
    return typeof outcome === 'object' ? outcome.message
      : outcome === 'protected' ? format('author.write.closeBlocked', { tabs: blocked.join(', ') })
      : outcome === 'copies-unavailable' ? format('author.write.couldNotVerifyRecoveryCopiesSaveTheDrafts')
      : outcome === 'discard-unavailable' ? format('author.write.couldNotDiscardTheRecoveryCopiesTheTabs')
      : outcome === 'stale' ? format('author.write.tabsChangedBeforeClosingTryAgain') : ''
  }

  async function allowLeave(allTabs = false): Promise<boolean> {
    const currentFlags = flags()
    if (state.propertyPending || state.closingTabs) return false
    const candidates = (allTabs ? state.workspaceTabs : state.tab ? [state.tab] : [])
      .filter(item => item.risk !== 'clean' || (item.active && currentFlags.metadataDirty))
    if (!candidates.length) return true
    if (candidates.some(item => item.risk === 'saving' || item.risk === 'pending' || item.retry)) return false
    const plan = registry.planClose(candidates)
    if (!plan) return false
    const edits = candidates.map(item => ({ item, sequence: registry.editSequence(item) }))
    try {
      const confirmed = await confirm.confirmLeave(candidates)
      if (!confirmed || registry.discardMany(plan).kind !== 'closed') return false
      await Promise.all(edits.map(({ item, sequence }) => sequence === undefined
        ? undefined
        : recovery.discardArticle(item.articleId, item.sessionId, sequence)))
      return true
    } catch {
      return false
    }
  }

  async function finishSubmission(
    action: WriteAction,
    current: WorkspaceTab,
    document: Draft,
    identity: number,
    requested: ReturnType<typeof registry.retry>,
  ): Promise<void> {
    const result = await requested
    if (lifetime.signal.aborted || identity !== session.identityEpoch() || router.articleId() !== current.articleId) {
      return
    }
    if (result.kind === 'saved') {
      if (result.recoverySettled === false) {
        patch({ failure: format('author.write.draftSavedRecoveryCleanupIsUnfinishedTryAgain') })
        return
      }
      patch({ notice: format(savedMessageKeyByAction[action]) })
      if (!document.id) {
        await router.replaceArticle(result.articleId, state.persistentWorkspace)
      }
    } else if (result.kind === 'conflict') {
      patch({ failure: format('author.write.theServerHasANewerRevisionCopyYour') })
    } else if (result.kind === 'blocked') {
      patch({ failure: format(failureMessageKeyByReason[result.reason]) })
    } else if (result.kind === 'rejected') {
      patch({ failure: format('author.write.theServerRejectedThisChangeCheckTheDraft') })
    }
  }

  async function navigateTo(
    articleId: number,
    restore?: RecentlyClosed,
    targetGroup?: WorkspaceGroup,
    selection?: ArticleSelection,
  ): Promise<boolean> {
    const currentFlags = flags()
    if (!currentFlags.canSwitch || (selection && (state.opening || !selection.current()))) return false
    if (registry.activeTab?.articleId === articleId && router.articleId() === articleId) {
      if (!selection) return true
      const result = await activateArticle(
        articleId,
        undefined,
        undefined,
        () => selection.current() && flags().canSwitch && !lifetime.signal.aborted,
        selection.revision,
        true,
      )
      if (result.kind !== 'ready' || !selection.current() || registry.activeTab?.sessionId !== result.tab.sessionId ||
          router.articleId() !== articleId) return false
      recordRecentOpen(articleId, selection.revision)
      return true
    }
    const intent: NavigationIntent = {
      restore,
      targetGroup,
      selection,
      path: router.resolveArticlePath(articleId),
    }
    const epoch = session.identityEpoch()
    const handle = session.current()?.siteSessionId
    explicitNavigation = intent
    try {
      const failed = await router.pushArticle(articleId, state.persistentWorkspace)
      const active = registry.activeTab
      if (failed || active?.articleId !== articleId || router.articleId() !== articleId) return false
      if (explicitNavigation === intent && intent.witness && intent.witness.sessionId === active.sessionId &&
          epoch === session.identityEpoch() && handle === session.current()?.siteSessionId) {
        recordRecentOpen(articleId, intent.witness.articleRevision)
      }
      return true
    } finally {
      if (explicitNavigation === intent) explicitNavigation = undefined
    }
  }

  return {
    registry,
    lifetime,

    snapshot(): WriteWorkspaceState {
      return state
    },

    flags,

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    setNotice(value: string): void {
      if (state.notice !== value) patch({ notice: value })
    },

    setOpenInput(value: string): void {
      if (state.openInput !== value) patch({ openInput: value })
    },

    setTaxonomyDirty(value: boolean): void {
      if (state.taxonomyDirty !== value) patch({ taxonomyDirty: value })
    },

    setSummaryDirty(value: boolean): void {
      if (state.summaryDirty !== value) patch({ summaryDirty: value })
    },

    markTaxonomyStale(): void {
      if (!state.taxonomyStale) patch({ taxonomyStale: true })
    },

    setPropertyPending(value: boolean): void {
      if (state.propertyPending !== value) patch({ propertyPending: value })
    },

    setRevisionComparisonActive(value: boolean): void {
      if (state.revisionComparisonActive !== value) patch({ revisionComparisonActive: value })
    },

    setTaxonomyModalActive(value: boolean): void {
      if (state.taxonomyModalActive !== value) patch({ taxonomyModalActive: value })
    },

    syncIdentity(current: Session | null, epoch: number): void {
      const handle = current?.siteSessionId
      if (workspaceIdentity !== epoch || !current?.canAuthor) {
        persistence.reset()
        layoutStarted = false
        if (state.layoutRestoring) patch({ layoutRestoring: false })
        persistedSession = handle
        workspaceIdentity = epoch
        registry.setIdentity(current?.canAuthor
          ? { site: ports.origin, principalId: String(epoch), generation: current.generation, expiresAt: current.expiresAt }
          : null)
        return
      }
      registry.updateIdentityExpiry(current.expiresAt)
      if (handle && handle !== persistedSession) persistence.rebind(handle)
      persistedSession = handle
    },

    onIdentityEpochChanged(): void {
      ++navigation
      patch({
        opening: false,
        composing: undefined,
        navigationNotice: '',
        groupNotice: '',
      })
    },

    mountSessionCheck(preloadedAuth: boolean): Promise<void> {
      if (preloadedAuth) {
        handoff.markSessionVerified()
        return Promise.resolve()
      }
      return session.refreshSession(lifetime.signal, !handoff.hasArrival()).then(() => {
        handoff.markSessionVerified()
      }).catch(() => {
        if (!lifetime.signal.aborted) patch({ failure: format('author.write.couldNotVerifyYourSession') })
      }).finally(() => {
        if (!lifetime.signal.aborted) patch({ authorizationReady: true })
      })
    },

    async syncRoute(params: Readonly<{
      articleId: number | undefined
      identity: number
      isValid: () => boolean
    }>): Promise<void> {
      const { articleId, identity, isValid } = params
      const activeSession = session.current()
      if (!state.authorizationReady || !activeSession?.canAuthor) {
        patch({ opening: false, loading: false })
        return
      }
      const handle = activeSession.siteSessionId
      if (state.persistentWorkspace && !layoutStarted && handle) {
        layoutStarted = true
        patch({ layoutRestoring: true, loading: true })
        await persistence.restore(handle, (layout, signal) => registry.restoreLayout(layout, signal))
        if (identity === session.identityEpoch()) patch({ layoutRestoring: false })
        if (!isValid() || identity !== session.identityEpoch()) return
        if (articleId === undefined && state.tab) {
          await router.replaceArticle(state.tab.articleId, true)
          if (!isValid() || identity !== session.identityEpoch()) return
        }
      }
      if (articleId === undefined) {
        registry.idle()
        patch({ loading: false })
        return
      }

      const epoch = session.credentialEpoch()
      const arrival = handoff.resolveArrival(articleId, epoch, handle)
      if (arrival.kind === 'expired') {
        patch({ failure: format('author.write.thisEditorLinkHasExpiredReturnToIts'), loading: false })
        return
      }
      const source = arrival.kind === 'ready' ? arrival.source : undefined
      const requiredRevision = arrival.kind === 'ready' ? arrival.requiredRevision : undefined

      if (!source && state.original?.id === articleId) {
        patch({ loading: false })
        return
      }

      patch({ loading: true, failure: '', notice: '' })
      const routeIntent = navigation
      const current = () => isValid() && !lifetime.signal.aborted && epoch === session.credentialEpoch() &&
        routeIntent === navigation && session.current()?.siteSessionId === handle
      const result = await activateArticle(articleId, undefined, undefined, source ? current : undefined, requiredRevision)
      if (!isValid() || identity !== session.identityEpoch()) return
      patch({ loading: false })

      if (result.kind !== 'ready') {
        const failureKind = handoff.handleActivationFailure(source, result)
        const message = failureKind === 'search-unavailable'
          ? format('author.write.theSearchPositionIsNoLongerAvailableReturn')
          : failureKind === 'stale-reference'
            ? format(failureMessageKeyByReason['stale-reference'])
            : activationFailure(result)
        patch({ failure: message })
        return
      }
      if (!source) {
        handoff.clearPending()
        return
      }
      const activated = handoff.activateTarget({
        source,
        sessionId: result.tab.sessionId,
        witnessedRevision: result.witnessedRevision,
        handle,
        persistentWorkspace: state.persistentWorkspace,
        recoveryItemsCount: recovery.candidates().length,
        recoveryWorking: state.recoveryWorking,
        revisionComparisonActive: state.revisionComparisonActive,
        activeEditSequence: registry.activeEditSequence,
        isRouteCurrent: current,
        readLiveState: () => {
          const liveFlags = flags()
          return {
            activeSessionId: state.tab?.sessionId,
            activeRisk: state.tab?.risk,
            recoveryBlocked: liveFlags.recoveryBlocked,
            canSwitch: liveFlags.canSwitch,
            editable: liveFlags.editable,
            pending: liveFlags.pending,
            revisionComparisonActive: state.revisionComparisonActive,
            activeEditSequence: registry.activeEditSequence,
            originalId: state.original?.id,
            originalRevision: state.original?.revision,
            inspectorOpen: state.inspectorOpen,
            sessionExpiresAt: session.current()?.expiresAt ?? 0,
          }
        },
        setInspectorOpen,
      })
      if (activated.kind === 'unavailable' && activated.noticeKey) {
        patch({ notice: format(activated.noticeKey) })
      }
    },

    async beforeRouteUpdate(params: Readonly<{
      toPath: string
      fromPath: string
      toArticleId: number | undefined
    }>): Promise<boolean> {
      const { toPath, fromPath, toArticleId } = params
      if (toPath === fromPath || !state.authorizationReady || !session.current()?.canAuthor) return true
      const intent = ++navigation
      registry.cancelOpening()
      patch({ opening: false })
      if (!flags().canSwitch) {
        patch({ navigationNotice: format('author.write.applyOrCancelThePendingChangesBeforeSwitching') })
        return false
      }
      patch({ navigationNotice: '', groupNotice: '' })
      if (toArticleId === undefined) return true
      // A successful creation already has a verified persisted revision in the same session.
      if (toArticleId === state.tab?.articleId) return true
      const epoch = session.identityEpoch()
      patch({ opening: true })
      const explicit = explicitNavigation?.path === toPath ? explicitNavigation : undefined
      const selection = explicit?.selection
      const result = await activateArticle(
        toArticleId,
        explicit?.targetGroup ?? explicit?.restore?.group,
        explicit?.restore?.mode,
        () => intent === navigation && epoch === session.identityEpoch() && flags().canSwitch &&
          !lifetime.signal.aborted && (!selection || selection.current()),
        selection?.revision,
        !!selection,
      )
      if (intent !== navigation || epoch !== session.identityEpoch() || lifetime.signal.aborted) return false
      patch({ opening: false })
      if (!selection) {
        const message = result.kind === 'superseded' && !flags().canSwitch
          ? format('author.write.applyOrCancelThePendingChangesBeforeSwitching')
          : activationFailure(result)
        patch({ navigationNotice: message })
      }
      if (result.kind === 'ready') {
        if (explicit && result.witnessedRevision !== undefined) {
          explicit.witness = { sessionId: result.tab.sessionId, articleRevision: result.witnessedRevision }
        }
        patch({
          notice: '',
          failure: result.tab.risk === 'conflict' ? format('author.write.theServerHasANewerRevisionCopyYour') : '',
        })
      }
      return result.kind === 'ready'
    },

    async beforeRouteLeave(): Promise<boolean> {
      ++navigation
      registry.cancelOpening()
      patch({ opening: false })
      if (!await allowLeave(true)) return false
      await persistence.flush()
      return true
    },

    allowLeave,

    async openSavedWorkspace(): Promise<void> {
      const identity = session.identityEpoch()
      if (!await allowLeave(true) || lifetime.signal.aborted || identity !== session.identityEpoch()) return
      if (await router.replaceWorkspace(true)) return
      if (lifetime.signal.aborted || identity !== session.identityEpoch()) return
      registry.setIdentity(null)
      const activeSession = session.current()
      if (!activeSession?.canAuthor) return
      registry.setIdentity({
        site: ports.origin,
        principalId: String(identity),
        generation: activeSession.generation,
        expiresAt: activeSession.expiresAt,
      })
      patch({ persistentWorkspace: true })
    },

    navigateTo,

    openArticle(splitGroup = false): void {
      const currentFlags = flags()
      if (currentFlags.inputArticle === undefined) {
        patch({ navigationNotice: format('author.write.enterAValidArticleId') })
        return
      }
      void navigateTo(currentFlags.inputArticle, undefined, splitGroup ? currentFlags.otherGroup : undefined)
    },

    paneFocused,

    changeComposition(pane: WorkspaceSource<Draft>, active: boolean): void {
      if (active) {
        if (paneFocused(pane)) patch({ composing: pane.tab.sessionId })
      } else if (state.composing === pane.tab.sessionId) {
        scheduleTick(() => {
          if (state.composing === pane.tab.sessionId) patch({ composing: undefined })
        })
      }
    },

    canMoveBackgroundTab(target: WorkspaceTab): boolean {
      return flags().canArrangeGroups && registry.canMoveBackgroundTab(target)
    },

    moveBackgroundTab(target: WorkspaceTab, revision: number): void {
      if (!flags().canArrangeGroups) return
      const destination: WorkspaceGroup = target.group === 'main' ? 'secondary' : 'main'
      const receipt = registry.moveBackgroundTab(target, destination, revision)
      if (receipt.kind === 'changed') {
        patch({
          groupNotice: format(
            destination === 'main' ? 'author.write.movedTitlePrimary' : 'author.write.movedTitleSecondary',
            { title: receipt.tab.title },
          ),
        })
      }
    },

    arrangeGroups(destination?: WorkspaceGroup): WorkspaceTab | undefined {
      const current = state.tab
      if (!current || !flags().canArrangeGroups) return undefined
      const receipt = destination
        ? registry.moveActiveTab(current, destination, registry.revision)
        : registry.mergeGroups(current, registry.revision)
      if (receipt.kind !== 'changed') return undefined
      patch({
        groupNotice: destination
          ? format(destination === 'main' ? 'author.write.movedPrimary' : 'author.write.movedSecondary')
          : format('author.write.mergedBothGroupsIntoThePrimaryGroup'),
      })
      return receipt.tab
    },

    setInspectorOpen,

    togglePin(target: WorkspaceTab): void {
      if (target.mode === 'preview') registry.pin(target)
      else if (!registry.unpin(target)) {
        patch({ navigationNotice: format('author.write.saveChangesAndCloseTheCurrentPreviewBefore') })
      }
    },

    async closeGroupTabs(onlyRight: boolean): Promise<CloseGroupResult> {
      const current = registry.activeTab
      const currentFlags = flags()
      const index = currentFlags.activeGroupIndex
      const groupTabs = currentFlags.activeGroupTabs
      if (!current || !currentFlags.canCloseGroupTabs || groupTabs[index]?.sessionId !== current.sessionId) {
        return { outcome: 'noop', focusAction: 'none' }
      }
      const targets = onlyRight ? groupTabs.slice(index + 1) : groupTabs.filter(candidate => !candidate.active)
      if (targets.length === 0) return { outcome: 'noop', focusAction: 'none' }
      const epoch = session.identityEpoch()
      const path = router.path()
      const isCurrent = () => epoch === session.identityEpoch() && !lifetime.signal.aborted &&
        router.path() === path && registry.activeTab?.sessionId === current.sessionId
      const plan = registry.planClose(targets)
      const result = plan ? registry.applyClose(plan).kind : 'stale'
      const outcome: ProtectedCloseOutcome = plan && result === 'protected'
        ? await confirmProtectedClose(plan, isCurrent)
        : result
      if (!isCurrent()) return { outcome, focusAction: 'none' }
      if (outcome !== 'closed') {
        patch({ groupNotice: '', navigationNotice: failedCloseNotice(outcome, plan) })
        return { outcome, focusAction: 'restore-trigger' }
      }
      patch({
        navigationNotice: '',
        groupNotice: targets.length === 1
          ? format('author.write.closed1Tab')
          : format('author.write.closedTabs', { count: targets.length }),
      })
      return { outcome, focusAction: 'focus-active-tab' }
    },

    async closeTab(target: WorkspaceTab): Promise<CloseTabResult> {
      if (state.closingTabs || (target.active && !flags().canSwitch)) {
        patch({ navigationNotice: format('author.write.applyOrCancelThePendingChangesBeforeClosing') })
        return { outcome: 'blocked', focusAction: 'none' }
      }
      const epoch = session.identityEpoch()
      const path = router.path()
      const active = registry.activeTab?.sessionId
      const samePage = () => epoch === session.identityEpoch() && !lifetime.signal.aborted && router.path() === path
      const isCurrent = () => samePage() && registry.activeTab?.sessionId === active

      patch({ navigationNotice: '' })
      const plan = registry.planClose([target])
      if (!plan) return { outcome: 'noop', focusAction: 'none' }
      const ready = registry.applyClose(plan)
      if (ready.kind === 'stale') return { outcome: 'stale', focusAction: 'none' }
      if (ready.kind === 'protected') {
        if (target.risk === 'saving' || target.risk === 'pending' || (target.risk === 'recovery' &&
            (target.articleId === 0 || target.retry !== 'save'))) {
          patch({ navigationNotice: format('author.write.resolveThePendingChangesBeforeClosingThisTab') })
          return { outcome: 'protected', focusAction: 'none' }
        }
        if (target.articleId > 0 && target.risk !== 'blocked') {
          const outcome = await confirmProtectedClose(plan, isCurrent)
          if (!samePage()) return { outcome, focusAction: 'none' }
          if (outcome !== 'closed') {
            patch({ navigationNotice: failedCloseNotice(outcome, plan) })
            return { outcome, focusAction: 'restore-trigger' }
          }
        } else {
          const edit = registry.editSequence(target)
          try {
            const confirmed = await confirm.confirmDiscardTab(target.title)
            if (!confirmed || !isCurrent() || registry.discard(target, plan.revision).kind !== 'closed') {
              return { outcome: 'cancelled', focusAction: 'restore-trigger' }
            }
            if (edit !== undefined) await recovery.discardArticle(target.articleId, target.sessionId, edit)
          } catch {
            return { outcome: 'cancelled', focusAction: 'restore-trigger' }
          }
        }
      }
      if (!samePage()) return { outcome: 'stale', focusAction: 'none' }
      if (target.active) {
        const next = state.workspaceTabs.find(candidate => candidate.risk !== 'blocked' && candidate.risk !== 'saving')
        const rejected = next
          ? await router.replaceArticle(next.articleId, state.persistentWorkspace)
          : await router.replaceWorkspace(state.persistentWorkspace)
        if (rejected && !registry.activeTab) {
          await router.replaceWorkspace(state.persistentWorkspace)
        }
      }
      return {
        outcome: 'closed',
        focusAction: registry.activeTab ? 'focus-active-tab' : 'focus-article-input',
      }
    },

    shouldPreventUnload(): boolean {
      const currentFlags = flags()
      return currentFlags.dirty || currentFlags.pending || Boolean(currentFlags.retry) ||
        state.workspaceTabs.some(item => item.risk !== 'clean' && item.risk !== 'blocked')
    },

    edit(pane: WorkspaceSource<Draft>, field: 'title' | 'body', value: string, edits?: readonly BodyEdit[]): boolean {
      const currentFlags = flags()
      const document = state.original
      const current = state.tab
      if (paneFocused(pane) && !state.closingTabs && !currentFlags.recoveryBlocked && !currentFlags.metadataDirty &&
          !state.propertyPending && current && document && document[field] !== value) {
        const next = { ...document, [field]: value }
        if (registry.updateDraft(current, next, field === 'body' ? edits : undefined)) {
          recovery.persist(next, registry.activeEditSequence)
          return true
        }
      }
      return false
    },

    loadImportedDraft(
      pane: WorkspaceSource<Draft>,
      imported: DraftMarkdown,
    ): Readonly<{ imported: true; handle: string; sessionId: number }> | Readonly<{ imported: false }> {
      const currentFlags = flags()
      const active = state.tab
      const draft = state.original
      const handle = currentFlags.credential
      if (!active || !draft || !handle || !currentFlags.canImportDraft || !paneFocused(pane) || lifetime.signal.aborted ||
          (session.current()?.expiresAt ?? 0) <= nowMs()) {
        return { imported: false }
      }
      const next = { ...draft, ...imported }
      if (!registry.updateDraft(active, next)) return { imported: false }
      recovery.persist(next, registry.activeEditSequence)
      patch({ notice: format('author.write.markdownLoadedSaveToKeepThisDraft') })
      return { imported: true, handle, sessionId: active.sessionId }
    },

    async restoreDraft(candidate: RecoveryCandidate): Promise<boolean> {
      const currentFlags = flags()
      const current = state.tab
      const document = state.original
      if (!current || !document || current.risk !== 'clean' || currentFlags.pending || state.recoveryWorking ||
          !recovery.candidates().includes(candidate)) return false
      const restored = { ...document, title: candidate.title, body: candidate.body }
      patch({ recoveryWorking: true })
      try {
        if (registry.updateDraft(current, restored)) {
          if (!await recovery.remove(candidate, { draft: restored, edit: registry.activeEditSequence })) {
            recovery.dismissCandidates()
          }
          return true
        }
        return false
      } finally {
        patch({ recoveryWorking: false })
      }
    },

    async submit(
      action: WriteAction,
      selection?: TaxonomySelection,
      restore?: RestoreSelection,
      due?: bigint,
      rights?: RightsEdit,
      media?: AttachmentEdit,
    ): Promise<void> {
      const currentFlags = flags()
      const current = state.tab
      const document = state.original
      const siteSession = session.current()?.siteSessionId
      if (!current || !document || !currentFlags.editable || state.closingTabs || currentFlags.pending ||
          currentFlags.recoveryBlocked) return
      if (current.retry) {
        if (action !== current.retry) return
      } else if (action === 'publish-images' || action === 'save-summary') {
        return
      } else if (action === 'assign-taxonomy') {
        if (!selection || current.risk !== 'clean' || state.taxonomyStale || !state.taxonomyDirty || state.summaryDirty) return
      } else if (action === 'rollback-history') {
        if (!restore || current.risk !== 'clean' || currentFlags.cannotWrite) return
      } else if (action === 'schedule-publication') {
        if (due === undefined || current.risk !== 'clean' || currentFlags.cannotWrite) return
      } else if (action === 'save-rights') {
        if (!rights || current.risk !== 'clean' || currentFlags.cannotWrite) return
      } else if (action === 'save-attachment') {
        if (!media || !siteSession || current.risk !== 'clean' || currentFlags.cannotWrite) return
      } else if (currentFlags.cannotWrite || (action === 'publish' && !document.body.trim())) {
        return
      }

      patch({ failure: '', notice: '' })
      const identity = session.identityEpoch()
      const requested = current.retry
        ? registry.retry(current)
        : action === 'save'
          ? registry.save(current)
          : action === 'publish' || action === 'retract'
            ? registry.commit(current, action, commands.articleCommand(action))
            : action === 'assign-taxonomy' && selection
              ? registry.commit(current, action, commands.saveTaxonomy(selection))
              : action === 'rollback-history' && restore
                ? registry.commit(current, action, commands.restoreRevision(restore))
                : action === 'schedule-publication' && due !== undefined
                  ? registry.commit(current, action, commands.updateSchedule(due))
                  : action === 'save-rights' && rights
                    ? registry.commit(current, action, commands.updateRights(rights))
                    : action === 'save-attachment' && media && siteSession
                      ? registry.commit(current, action, commands.updateAttachment(media))
                      : undefined
      if (!requested) return
      await finishSubmission(action, current, document, identity, requested)
    },

    async publishSelectedImages(selection: PublishImagesSelection): Promise<void> {
      const currentFlags = flags()
      const current = state.tab
      const document = state.original
      if (!current || !document || !currentFlags.canPublishImages || selection.articleId !== document.id ||
          selection.revision !== document.revision || selection.credential !== currentFlags.credential) return
      patch({ failure: '', notice: '' })
      const identity = session.identityEpoch()
      const requested = registry.commit(current, 'publish-images', commands.publishImages(selection.assets.slice()))
      await finishSubmission('publish-images', current, document, identity, requested)
    },

    async saveSummary(edit: DraftSummaryEdit): Promise<void> {
      const currentFlags = flags()
      const current = state.tab
      const document = state.original
      if (!current || !document || !currentFlags.canChangeSummary || !state.summaryDirty ||
          edit.articleId !== document.id || edit.revision !== document.revision || edit.credential !== currentFlags.credential) return
      patch({ failure: '', notice: '' })
      const identity = session.identityEpoch()
      const requested = registry.commit(current, 'save-summary', commands.updateSummary(edit.text))
      await finishSubmission('save-summary', current, document, identity, requested)
    },

    async reloadDraft(): Promise<boolean> {
      if (!await allowLeave()) return false
      const current = state.tab
      if (current) registry.requestClose(current)
      return true
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      lifetime.abort()
      recovery.close()
      persistence.reset()
      registry.setIdentity(null)
      unsubscribeRegistry()
    },
  }
}

export type WriteWorkspaceController = ReturnType<typeof createWriteWorkspaceController>
