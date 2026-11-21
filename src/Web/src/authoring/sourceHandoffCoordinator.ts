import type {
  EditorSourceSeek,
  EditorSourceTarget,
  HistoricalSearchSeek,
  PropertySearchSeek,
} from './canvasEditorHandoff.ts'
import type { Activation } from './workspaceRegistry.ts'

export type SourceHandoffNoticeKey =
  | 'author.write.theSearchPositionIsNoLongerAvailableReturn'
  | 'author.write.theCanvasSourcePositionCouldNotBeOpened'
  | 'author.write.openedTheSearchResultAtItsVerifiedPosition'
  | 'author.write.openedTheSearchResultAtItsSavedPosition'
  | 'author.write.openedTheSearchResultInItsEarlierSaved'
  | 'author.write.openedTheSearchResultAtItsSavedProperty'

export type SourceHandoffFailureKind = 'search-unavailable' | 'stale-reference' | 'activation'

export type SourceHandoffSnapshot = Readonly<{
  sourceInspectorPending: boolean
  sourceSeek: EditorSourceSeek | undefined
  historicalSeek: HistoricalSearchSeek | undefined
  propertySeek: PropertySearchSeek | undefined
  summarySeek: Extract<EditorSourceSeek, { kind: 'search' }> | undefined
}>

export type SourceHandoffArrivalResolution =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'expired' }>
  | Readonly<{ kind: 'ready'; source: EditorSourceTarget; requiredRevision: bigint }>

export type SourceHandoffLiveState = Readonly<{
  activeSessionId: number | undefined
  activeRisk: string | undefined
  recoveryBlocked: boolean
  canSwitch: boolean
  editable: boolean
  pending: boolean
  revisionComparisonActive: boolean
  activeEditSequence: number
  originalId: number | undefined
  originalRevision: bigint | undefined
  inspectorOpen: boolean
  sessionExpiresAt: number
}>

export type SourceHandoffActivationInput = Readonly<{
  source: EditorSourceTarget
  sessionId: number
  witnessedRevision: bigint | undefined
  handle: string | undefined
  persistentWorkspace: boolean
  recoveryItemsCount: number
  recoveryWorking: boolean
  revisionComparisonActive: boolean
  activeEditSequence: number
  isRouteCurrent: () => boolean
  readLiveState: () => SourceHandoffLiveState
  setInspectorOpen: (open: boolean) => void
}>

export type SourceHandoffFinishResult = Readonly<{
  handled: boolean
  recordRecent?: Readonly<{ articleId: number; revision: bigint }>
  noticeKey?: SourceHandoffNoticeKey
}>

export interface SourceHandoffCoordinatorOptions {
  initialToken: unknown
  initialArticleId: number | undefined
  accept(token: unknown, articleId: number, credentialEpoch: number, handle?: string): EditorSourceTarget | undefined
  now?: () => number
  nowMs?: () => number
}

const searchPositionUnavailable: SourceHandoffNoticeKey = 'author.write.theSearchPositionIsNoLongerAvailableReturn'
const revealBudgetMs = 6_000

type SourceArrival = {
  articleId: number | undefined
  source?: EditorSourceTarget
  epoch?: number
}

export function createSourceHandoffCoordinator(options: SourceHandoffCoordinatorOptions) {
  const now = options.now ?? (() => performance.now())
  const nowMs = options.nowMs ?? Date.now
  const listeners = new Set<() => void>()

  let sourceArrival: SourceArrival | undefined =
    options.initialToken === undefined ? undefined : { articleId: options.initialArticleId }
  let sourceSessionVerified = false
  let sourceInspectorPending = options.initialToken !== undefined
  let sourceSeek: EditorSourceSeek | undefined
  let historicalSeek: HistoricalSearchSeek | undefined
  let propertySeek: PropertySearchSeek | undefined

  function emit(): void {
    for (const listener of listeners) listener()
  }

  function snapshot(): SourceHandoffSnapshot {
    const summarySeek = sourceSeek?.kind === 'search' && sourceSeek.target.field === 'summary' ? sourceSeek : undefined
    return {
      sourceInspectorPending,
      sourceSeek,
      historicalSeek,
      propertySeek,
      summarySeek,
    }
  }

  function finishSourceSeek(seek: EditorSourceSeek, success: boolean): SourceHandoffFinishResult {
    if (sourceSeek !== seek) return { handled: false }
    sourceSeek = undefined
    emit()
    if (seek.kind === 'canvas') {
      return success
        ? { handled: true }
        : { handled: true, noticeKey: 'author.write.theCanvasSourcePositionCouldNotBeOpened' }
    }
    if (!success || !seek.current()) {
      return { handled: true, noticeKey: searchPositionUnavailable }
    }
    return {
      handled: true,
      recordRecent: { articleId: seek.target.articleId, revision: seek.target.revision },
      noticeKey: seek.target.precision === 'rebased'
        ? 'author.write.openedTheSearchResultAtItsVerifiedPosition'
        : 'author.write.openedTheSearchResultAtItsSavedPosition',
    }
  }

  function finishHistoricalSeek(seek: HistoricalSearchSeek, success: boolean): SourceHandoffFinishResult {
    if (historicalSeek !== seek) return { handled: false }
    if (!success || !seek.current()) {
      historicalSeek = undefined
      emit()
      return { handled: true, noticeKey: searchPositionUnavailable }
    }
    return {
      handled: true,
      recordRecent: { articleId: seek.target.articleId, revision: seek.currentRevision },
      noticeKey: 'author.write.openedTheSearchResultInItsEarlierSaved',
    }
  }

  function closeHistoricalSeek(seek: HistoricalSearchSeek): boolean {
    if (historicalSeek !== seek) return false
    historicalSeek = undefined
    emit()
    return true
  }

  function finishPropertySeek(seek: PropertySearchSeek, success: boolean): SourceHandoffFinishResult {
    if (propertySeek !== seek) return { handled: false }
    const revealed = success && seek.current()
    propertySeek = undefined
    emit()
    if (!revealed) {
      return { handled: true, noticeKey: searchPositionUnavailable }
    }
    return {
      handled: true,
      recordRecent: { articleId: seek.target.articleId, revision: seek.target.revision },
      noticeKey: 'author.write.openedTheSearchResultAtItsSavedProperty',
    }
  }

  return {
    snapshot,

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    hasArrival(): boolean {
      return sourceArrival !== undefined
    },

    markSessionVerified(): void {
      sourceSessionVerified = true
    },

    clearPending(): void {
      if (!sourceInspectorPending) return
      sourceInspectorPending = false
      emit()
    },

    resolveArrival(articleId: number, credentialEpoch: number, handle: string | undefined): SourceHandoffArrivalResolution {
      if (sourceArrival?.articleId !== articleId) return { kind: 'none' }
      if (!sourceArrival.source && sourceSessionVerified) {
        sourceArrival.source = options.accept(options.initialToken, articleId, credentialEpoch, handle)
        sourceArrival.epoch = credentialEpoch
      }
      const source = sourceArrival.epoch === credentialEpoch ? sourceArrival.source : undefined
      if (!source) {
        sourceInspectorPending = false
        emit()
        return { kind: 'expired' }
      }
      const requiredRevision = source.kind === 'search-history' ? source.currentRevision : source.target.revision
      return { kind: 'ready', source, requiredRevision }
    },

    handleActivationFailure(source: EditorSourceTarget | undefined, result: Exclude<Activation, { kind: 'ready' }>): SourceHandoffFailureKind {
      sourceInspectorPending = false
      emit()
      if (source && source.kind !== 'canvas') {
        if (sourceArrival) sourceArrival.source = undefined
        return result.kind === 'superseded' || (result.kind === 'blocked' && result.reason === 'stale-reference')
          ? 'search-unavailable'
          : 'activation'
      }
      return source && result.kind === 'superseded' ? 'stale-reference' : 'activation'
    },

    activateTarget(input: SourceHandoffActivationInput): Readonly<{ kind: 'activated' | 'unavailable'; noticeKey?: SourceHandoffNoticeKey }> {
      sourceArrival = undefined
      const { source, sessionId, isRouteCurrent, readLiveState, setInspectorOpen } = input
      const revealBy = now() + revealBudgetMs
      const held = () => {
        const live = readLiveState()
        return isRouteCurrent() && live.activeSessionId === sessionId && live.activeRisk === 'clean' &&
          !live.recoveryBlocked && now() < revealBy
      }

      if (source.kind === 'canvas' && source.target.sourceOffset !== null) {
        sourceSeek = {
          kind: 'canvas',
          sessionId,
          revision: source.target.revision,
          offset: source.target.sourceOffset,
          current: held,
        }
      } else if (source.kind === 'search') {
        if (input.witnessedRevision !== source.target.revision || input.recoveryItemsCount > 0) {
          sourceInspectorPending = false
          emit()
          return { kind: 'unavailable', noticeKey: searchPositionUnavailable }
        }
        const edit = input.activeEditSequence
        const target = source.target
        // A restored mobile drawer must never open before the source caret receives focus.
        setInspectorOpen(target.field === 'summary')
        sourceSeek = {
          kind: 'search',
          sessionId,
          target,
          current: () => {
            const live = readLiveState()
            return held() && live.canSwitch && live.editable && !live.pending &&
              !live.revisionComparisonActive && live.activeEditSequence === edit &&
              live.originalRevision === target.revision && live.sessionExpiresAt > nowMs()
          },
        }
      } else if (source.kind === 'search-history') {
        const { currentRevision, target } = source
        if (!input.handle || !input.persistentWorkspace || input.witnessedRevision !== currentRevision ||
          input.recoveryItemsCount > 0 || input.recoveryWorking || input.revisionComparisonActive) {
          sourceInspectorPending = false
          emit()
          return { kind: 'unavailable', noticeKey: searchPositionUnavailable }
        }
        const edit = input.activeEditSequence
        historicalSeek = {
          target,
          currentRevision,
          credential: input.handle,
          current: () => {
            const live = readLiveState()
            return isRouteCurrent() && live.activeSessionId === sessionId && live.activeRisk === 'clean' &&
              !live.recoveryBlocked && live.canSwitch && live.editable && !live.pending &&
              live.activeEditSequence === edit && live.originalRevision === currentRevision &&
              live.sessionExpiresAt > nowMs()
          },
        }
        setInspectorOpen(true)
      } else if (source.kind === 'property-search') {
        const { target } = source
        if (!input.handle || !input.persistentWorkspace || input.witnessedRevision !== target.revision ||
          input.recoveryItemsCount > 0 || input.recoveryWorking || input.revisionComparisonActive) {
          sourceInspectorPending = false
          emit()
          return { kind: 'unavailable', noticeKey: searchPositionUnavailable }
        }
        const edit = input.activeEditSequence
        const seek: PropertySearchSeek = {
          target,
          credential: input.handle,
          current: () => {
            const live = readLiveState()
            return propertySeek === seek && live.inspectorOpen && held() && live.canSwitch && live.editable &&
              !live.pending && !live.revisionComparisonActive && live.activeEditSequence === edit &&
              live.originalId === target.articleId && live.originalRevision === target.revision &&
              live.sessionExpiresAt > nowMs()
          },
        }
        propertySeek = seek
        setInspectorOpen(true)
      }

      sourceInspectorPending = false
      emit()
      return { kind: 'activated' }
    },

    finishSourceSeek,
    finishHistoricalSeek,
    closeHistoricalSeek,
    finishPropertySeek,

    onCredentialEpochChange(): void {
      const changed = sourceSeek !== undefined || historicalSeek !== undefined || propertySeek !== undefined
      sourceSeek = undefined
      historicalSeek = undefined
      propertySeek = undefined
      if (sourceArrival?.source && sourceArrival.source.kind !== 'canvas') sourceArrival.source = undefined
      if (changed) emit()
    },

    onArticleIdChange(): void {
      sourceArrival = undefined
      const changed = sourceInspectorPending || sourceSeek !== undefined || historicalSeek !== undefined || propertySeek !== undefined
      sourceInspectorPending = false
      sourceSeek = undefined
      historicalSeek = undefined
      propertySeek = undefined
      if (changed) emit()
    },

    onActivityChange(input: Readonly<{ busy: boolean; comparing: boolean }>): Readonly<{ noticeKey?: SourceHandoffNoticeKey }> {
      let noticeKey: SourceHandoffNoticeKey | undefined
      let changed = false
      if (sourceSeek?.kind === 'search' && (input.busy || input.comparing)) {
        sourceSeek = undefined
        noticeKey = searchPositionUnavailable
        changed = true
      }
      if (propertySeek && (input.busy || input.comparing)) {
        const result = finishPropertySeek(propertySeek, false)
        if (result.noticeKey) noticeKey = result.noticeKey
      }
      if (historicalSeek && input.busy) {
        historicalSeek = undefined
        noticeKey = searchPositionUnavailable
        changed = true
      }
      if (changed) emit()
      return noticeKey ? { noticeKey } : {}
    },

    onInspectorClosed(): Readonly<{ noticeKey?: SourceHandoffNoticeKey }> {
      let noticeKey: SourceHandoffNoticeKey | undefined
      const currentSummary = sourceSeek?.kind === 'search' && sourceSeek.target.field === 'summary' ? sourceSeek : undefined
      if (currentSummary) {
        const result = finishSourceSeek(currentSummary, false)
        if (result.noticeKey) noticeKey = result.noticeKey
      }
      if (propertySeek) {
        const result = finishPropertySeek(propertySeek, false)
        if (result.noticeKey) noticeKey = result.noticeKey
      }
      if (historicalSeek !== undefined) {
        historicalSeek = undefined
        emit()
      }
      return noticeKey ? { noticeKey } : {}
    },
  }
}

export type SourceHandoffCoordinator = ReturnType<typeof createSourceHandoffCoordinator>
