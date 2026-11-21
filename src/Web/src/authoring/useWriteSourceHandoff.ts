import { computed, onUnmounted, ref, shallowRef, watch, type Ref } from 'vue'
import { t } from '../siteLocale'
import {
  acceptEditorSourceHandoff,
  editorSourceHandoffKey,
  type EditorSourceSeek,
  type HistoricalSearchSeek,
  type PropertySearchSeek,
} from './canvasEditorHandoff'
import type { RecoveryCandidate } from './draftJournal'
import {
  createSourceHandoffCoordinator,
  type SourceHandoffFinishResult,
} from './sourceHandoffCoordinator'
import type { WorkspaceTab } from './workspaceRegistry'

export interface UseWriteSourceHandoffOptions {
  articleId: Readonly<Ref<number | undefined>>
  credentialEpoch: Readonly<Ref<number>>
  recordRecentOpen(articleId: number, revision: bigint): void
  setNotice(message: string): void
}

export interface WriteSourceActivitySources {
  recoveryItems: Readonly<Ref<readonly RecoveryCandidate[]>>
  recoveryWorking: Readonly<Ref<boolean>>
  activeTab: Readonly<Ref<WorkspaceTab | undefined>>
  propertyPending: Readonly<Ref<boolean>>
  metadataDirty: Readonly<Ref<boolean>>
  composing: Readonly<Ref<number | undefined>>
  closingTabs: Readonly<Ref<boolean>>
  revisionComparisonActive: Readonly<Ref<boolean>>
}

function consumeArrivalToken(): unknown {
  const arrivalState = history.state as Record<string, unknown> | null
  const token = arrivalState?.[editorSourceHandoffKey]
  if (token !== undefined && arrivalState) {
    const state = { ...arrivalState }
    delete state[editorSourceHandoffKey]
    history.replaceState(state, '')
  }
  return token
}

export function useWriteSourceHandoff(options: UseWriteSourceHandoffOptions) {
  const initialToken = consumeArrivalToken()
  const coordinator = createSourceHandoffCoordinator({
    initialToken,
    initialArticleId: options.articleId.value,
    accept: acceptEditorSourceHandoff,
  })

  const initial = coordinator.snapshot()
  const sourceInspectorPending = ref(initial.sourceInspectorPending)
  const sourceSeek = shallowRef<EditorSourceSeek | undefined>(initial.sourceSeek)
  const historicalSeek = shallowRef<HistoricalSearchSeek | undefined>(initial.historicalSeek)
  const propertySeek = shallowRef<PropertySearchSeek | undefined>(initial.propertySeek)
  const summarySeek = computed(() => {
    const seek = sourceSeek.value
    if (seek?.kind === 'search' && seek.target.field === 'summary') return seek
  })

  const unsubscribe = coordinator.subscribe(() => {
    const snap = coordinator.snapshot()
    if (sourceInspectorPending.value !== snap.sourceInspectorPending) {
      sourceInspectorPending.value = snap.sourceInspectorPending
    }
    if (sourceSeek.value !== snap.sourceSeek) sourceSeek.value = snap.sourceSeek
    if (historicalSeek.value !== snap.historicalSeek) historicalSeek.value = snap.historicalSeek
    if (propertySeek.value !== snap.propertySeek) propertySeek.value = snap.propertySeek
  })
  onUnmounted(unsubscribe)

  watch(options.credentialEpoch, () => {
    coordinator.onCredentialEpochChange()
  }, { flush: 'sync' })

  watch(options.articleId, () => {
    coordinator.onArticleIdChange()
  }, { flush: 'sync' })

  function bindActivity(sources: WriteSourceActivitySources): void {
    watch([
      sources.recoveryItems,
      sources.recoveryWorking,
      () => sources.activeTab.value?.risk,
      sources.propertyPending,
      sources.metadataDirty,
      sources.composing,
      sources.closingTabs,
      sources.revisionComparisonActive,
    ], ([items, recovering, risk, property, metadata, composition, closing, comparing]) => {
      const busy = items.length > 0 || recovering || risk !== 'clean' || property || metadata ||
        composition !== undefined || closing
      const result = coordinator.onActivityChange({ busy, comparing })
      if (result.noticeKey) options.setNotice(t(result.noticeKey))
    }, { flush: 'sync' })
  }

  function applyFinish(result: SourceHandoffFinishResult): void {
    if (!result.handled) return
    if (result.recordRecent) {
      options.recordRecentOpen(result.recordRecent.articleId, result.recordRecent.revision)
    }
    if (result.noticeKey) options.setNotice(t(result.noticeKey))
  }

  function finishSourceSeek(seek: EditorSourceSeek, success: boolean): void {
    applyFinish(coordinator.finishSourceSeek(seek, success))
  }

  function finishHistoricalSeek(seek: HistoricalSearchSeek, success: boolean): void {
    applyFinish(coordinator.finishHistoricalSeek(seek, success))
  }

  function closeHistoricalSeek(seek: HistoricalSearchSeek): void {
    coordinator.closeHistoricalSeek(seek)
  }

  function finishPropertySeek(seek: PropertySearchSeek, success: boolean): void {
    applyFinish(coordinator.finishPropertySeek(seek, success))
  }

  return {
    coordinator,
    sourceInspectorPending,
    sourceSeek,
    historicalSeek,
    propertySeek,
    summarySeek,
    bindActivity,
    finishSourceSeek,
    finishHistoricalSeek,
    closeHistoricalSeek,
    finishPropertySeek,
  }
}
