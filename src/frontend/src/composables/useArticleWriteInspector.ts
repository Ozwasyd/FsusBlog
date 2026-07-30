import { nextTick, ref, shallowReactive } from 'vue'

export const articleWriteInspectorRegistry = [
  { id: 'publish', label: '发布' },
  { id: 'rights', label: '版权' },
  { id: 'check', label: '检查' },
  { id: 'preview', label: '预览' },
  { id: 'versions', label: '版本' },
  { id: 'resources', label: '资源' }
] as const

export type ArticleWriteInspectorView = typeof articleWriteInspectorRegistry[number]['id']

type ArticleWriteInspectorLoader = () => void | Promise<void>

interface ArticleWriteInspectorOptions {
  initialInspector?: ArticleWriteInspectorView | null
  loadView?: Partial<Record<ArticleWriteInspectorView, ArticleWriteInspectorLoader>>
}

export function useArticleWriteInspector(options: ArticleWriteInspectorOptions = {}) {
  const activeInspector = ref<ArticleWriteInspectorView | null>(options.initialInspector ?? null)
  const requestedViews = shallowReactive(new Set<ArticleWriteInspectorView>())
  const scrollPositions = shallowReactive(new Map<ArticleWriteInspectorView, number>())
  const scrollContainers = new Map<ArticleWriteInspectorView, HTMLElement>()
  const railTriggers = new Map<ArticleWriteInspectorView, HTMLElement>()
  const pendingLoads = new Map<ArticleWriteInspectorView, Promise<void>>()
  let focusReturnTarget: HTMLElement | null = null
  let closingInspector: ArticleWriteInspectorView | null = null

  const rememberScroll = (view: ArticleWriteInspectorView | null): void => {
    if (!view) {
      return
    }

    const container = scrollContainers.get(view)
    if (container) {
      scrollPositions.set(view, container.scrollTop)
    }
  }

  const restoreScroll = async (view: ArticleWriteInspectorView): Promise<void> => {
    await nextTick()
    const container = scrollContainers.get(view)
    if (container) {
      container.scrollTop = scrollPositions.get(view) ?? 0
    }
  }

  const ensureLoaded = (view: ArticleWriteInspectorView): Promise<void> => {
    const pending = pendingLoads.get(view)
    if (pending) {
      return pending
    }
    if (requestedViews.has(view)) {
      return Promise.resolve()
    }

    requestedViews.add(view)
    const loader = options.loadView?.[view]
    const request = Promise.resolve(loader?.())
      .finally(() => {
        pendingLoads.delete(view)
      })
    pendingLoads.set(view, request)
    return request
  }

  const open = (
    view: ArticleWriteInspectorView,
    trigger?: HTMLElement | null
  ): Promise<void> => {
    if (activeInspector.value !== view) {
      rememberScroll(activeInspector.value)
    }

    focusReturnTarget = trigger ?? railTriggers.get(view) ?? focusReturnTarget
    activeInspector.value = view
    const loading = ensureLoaded(view)
    void restoreScroll(view)
    return loading
  }

  const switchTo = (view: ArticleWriteInspectorView): Promise<void> => {
    if (activeInspector.value !== view) {
      rememberScroll(activeInspector.value)
    }

    activeInspector.value = view
    const loading = ensureLoaded(view)
    void restoreScroll(view)
    return loading
  }

  const close = (): void => {
    closingInspector = activeInspector.value
    rememberScroll(closingInspector)
    activeInspector.value = null
  }

  const toggle = (
    view: ArticleWriteInspectorView,
    trigger?: HTMLElement | null
  ): Promise<void> => {
    if (activeInspector.value === view) {
      close()
      return Promise.resolve()
    }

    return open(view, trigger)
  }

  const registerTrigger = (
    view: ArticleWriteInspectorView,
    element: HTMLElement | null
  ): void => {
    if (element) {
      railTriggers.set(view, element)
      return
    }
    railTriggers.delete(view)
  }

  const registerScrollContainer = (
    view: ArticleWriteInspectorView,
    element: HTMLElement | null
  ): void => {
    if (!element) {
      scrollContainers.delete(view)
      return
    }

    scrollContainers.set(view, element)
    if (view === activeInspector.value) {
      element.scrollTop = scrollPositions.get(view) ?? 0
    }
  }

  const updateScroll = (view: ArticleWriteInspectorView, scrollTop: number): void => {
    scrollPositions.set(view, scrollTop)
  }

  const restoreFocus = async (): Promise<void> => {
    await nextTick()
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve())
      })
    }
    const target = focusReturnTarget
      ?? (closingInspector ? railTriggers.get(closingInspector) ?? null : null)
    target?.focus({ preventScroll: true })
    focusReturnTarget = null
    closingInspector = null
  }

  if (activeInspector.value) {
    void ensureLoaded(activeInspector.value)
  }

  return {
    activeInspector,
    requestedViews,
    scrollPositions,
    open,
    switchTo,
    close,
    toggle,
    ensureLoaded,
    registerTrigger,
    registerScrollContainer,
    updateScroll,
    restoreFocus
  }
}
