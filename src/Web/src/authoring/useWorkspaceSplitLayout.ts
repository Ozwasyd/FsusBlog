import { computed, nextTick, ref, shallowRef, watch, type Ref } from 'vue'
import type { Draft } from '../../../Contracts/client'
import {
  clampPrimaryWidth,
  computeSplitLayoutMetrics,
  createSplitResizeController,
  defaultPrimaryWidth,
  resolveKeyboardResize,
  type LayoutDirection,
  type SplitLayoutMeasure,
} from './splitLayoutModel'
import type { WorkspaceSource, WorkspaceTab } from './workspaceRegistry'

export interface UseWorkspaceSplitLayoutOptions {
  sourcePanes: Readonly<Ref<readonly WorkspaceSource<Draft>[]>>
  activeTab: Readonly<Ref<WorkspaceTab | undefined>>
  editable: Readonly<Ref<boolean>>
  credential: Readonly<Ref<string | undefined>>
  identityEpoch: Readonly<Ref<number>>
  recheckComparison(tab: WorkspaceTab, signal: AbortSignal): Promise<boolean>
  focusSource(target: WorkspaceTab, epoch: number): Promise<void>
}

export function useWorkspaceSplitLayout(options: UseWorkspaceSplitLayoutOptions) {
  const editorArea = ref<HTMLElement>()
  const splitter = ref<HTMLElement>()
  const editorMeasure = shallowRef<SplitLayoutMeasure>({ width: 0, rem: 16 })
  const preferredPrimaryWidth = ref(defaultPrimaryWidth)
  const comparisonReady = ref(false)
  const resizeController = createSplitResizeController()

  const selectedPanes = computed(() => options.sourcePanes.value.filter(pane => pane.selected))
  const twoSources = computed(() => selectedPanes.value.length === 2)
  const metrics = computed(() => computeSplitLayoutMetrics({
    width: editorMeasure.value.width,
    rem: editorMeasure.value.rem,
    preferredPrimaryWidth: preferredPrimaryWidth.value,
    twoSources: twoSources.value,
    comparisonReady: comparisonReady.value,
  }))
  const trackWidth = computed(() => metrics.value.trackWidth)
  const minimumShare = computed(() => metrics.value.minimumShare)
  const wideEditorArea = computed(() => metrics.value.wideEditorArea)
  const primaryWidth = computed(() => metrics.value.primaryWidth)
  const showComparison = computed(() => metrics.value.showComparison)
  const splitColumns = computed(() => metrics.value.splitColumns)
  const primaryPane = computed(() => selectedPanes.value.find(pane => pane.tab.group === 'main')?.tab)
  const comparisonTab = computed(() => selectedPanes.value.find(pane => !pane.tab.active)?.tab)
  const selectedLocations = computed(() =>
    selectedPanes.value.map(pane => `${pane.tab.sessionId}:${pane.tab.group}`).join(','))

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

  function direction(): LayoutDirection {
    return editorArea.value && getComputedStyle(editorArea.value).direction === 'rtl' ? -1 : 1
  }

  function resizePrimary(width: number): void {
    if (showComparison.value) {
      preferredPrimaryWidth.value = clampPrimaryWidth(width, minimumShare.value)
    }
  }

  function startResize(event: PointerEvent): void {
    const divider = splitter.value
    if (!divider) return
    if (!resizeController.start({
      pointerId: event.pointerId,
      isPrimary: event.isPrimary,
      button: event.button,
      clientX: event.clientX,
    }, {
      showComparison: showComparison.value,
      primaryWidth: primaryWidth.value,
      direction: direction(),
      trackWidth: trackWidth.value,
    })) return
    event.preventDefault()
    divider.setPointerCapture(event.pointerId)
    divider.focus({ preventScroll: true })
  }

  function dragResize(event: PointerEvent): void {
    const nextWidth = resizeController.move(
      { pointerId: event.pointerId, clientX: event.clientX },
      { showComparison: showComparison.value, minimumShare: minimumShare.value },
    )
    if (nextWidth !== undefined) preferredPrimaryWidth.value = nextWidth
  }

  function endResize(event: PointerEvent): void {
    resizeController.end(event.pointerId)
  }

  function keyboardResize(event: KeyboardEvent): void {
    const width = resolveKeyboardResize({
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    }, {
      showComparison: showComparison.value,
      primaryWidth: primaryWidth.value,
      minimumShare: minimumShare.value,
      direction: direction(),
    })
    if (width === undefined) return
    event.preventDefault()
    preferredPrimaryWidth.value = width
  }

  watch(options.identityEpoch, () => {
    preferredPrimaryWidth.value = defaultPrimaryWidth
    resizeController.cancel()
  }, { flush: 'sync' })

  watch(options.identityEpoch, () => {
    comparisonReady.value = false
  })

  watch([
    twoSources,
    wideEditorArea,
    options.editable,
    () => comparisonTab.value?.sessionId,
    options.credential,
    options.identityEpoch,
    selectedLocations,
  ], async ([two, wide, ready, sessionId, handle], _, cleanup) => {
    comparisonReady.value = false
    const candidate = comparisonTab.value
    if (!two || !wide || !ready || !candidate || candidate.sessionId !== sessionId || !handle) return
    const controller = new AbortController()
    cleanup(() => controller.abort())
    const checked = await options.recheckComparison(
      candidate,
      AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
    )
    if (!controller.signal.aborted && checked) comparisonReady.value = true
  })

  watch(showComparison, async (wide, previous) => {
    if (wide) return
    resizeController.cancel()
    const divider = splitter.value
    const current = options.activeTab.value
    const epoch = options.identityEpoch.value
    if (!previous || !divider || document.activeElement !== divider || !current) return
    await nextTick()
    if (!showComparison.value && (document.activeElement === document.body || document.activeElement === divider)) {
      await options.focusSource(current, epoch)
    }
  })

  return {
    editorArea,
    splitter,
    selectedPanes,
    twoSources,
    minimumShare,
    primaryWidth,
    showComparison,
    splitColumns,
    primaryPane,
    resizePrimary,
    startResize,
    dragResize,
    endResize,
    keyboardResize,
  }
}
