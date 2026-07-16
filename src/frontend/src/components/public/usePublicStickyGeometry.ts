import { nextTick, onBeforeUnmount, onMounted, type Ref } from 'vue'
import { createCspStyleBinding, type CspStyleBinding } from '@/services/cspStyleRuntime'

export const publicStickyHeaderSelector = '[data-public-shell-header]'
export const publicStickyGeometryOwnerSelector = '[data-public-sticky-geometry-owner]'
const anchorGap = '0.75rem'

export const publicStickyGeometryTokens = {
  headerHeight: '--fsusblog-public-header-height-current',
  stickyTop: '--fsusblog-public-sticky-top',
  anchorOffset: '--fsusblog-public-anchor-offset'
} as const

export function usePublicStickyGeometry(rootRef: Ref<HTMLElement | undefined>): void {
  let resizeObserver: ResizeObserver | null = null
  let observedHeader: HTMLElement | null = null
  let lastPublishedHeight = ''
  let rootStyleBinding: CspStyleBinding | null = null

  const resolveHeader = (): HTMLElement | null =>
    rootRef.value?.querySelector<HTMLElement>(publicStickyHeaderSelector) ?? null

  const resolveGeometryOwner = (root: HTMLElement): HTMLElement =>
    root.querySelector<HTMLElement>(publicStickyGeometryOwnerSelector) ?? root

  const publish = (): void => {
    const root = rootRef.value
    const header = resolveHeader()
    if (!root || !header) {
      return
    }

    const height = Math.ceil(header.getBoundingClientRect().height)
    if (!Number.isFinite(height) || height <= 0) {
      return
    }

    const headerHeight = `${height}px`
    if (headerHeight === lastPublishedHeight) {
      return
    }

    rootStyleBinding ??= createCspStyleBinding(
      resolveGeometryOwner(root),
      {},
      'public-sticky-geometry'
    )
    rootStyleBinding.update({
      [publicStickyGeometryTokens.headerHeight]: headerHeight,
      [publicStickyGeometryTokens.stickyTop]: headerHeight,
      [publicStickyGeometryTokens.anchorOffset]: `calc(${headerHeight} + ${anchorGap})`
    })
    lastPublishedHeight = headerHeight
  }

  const observe = (): void => {
    const header = resolveHeader()
    if (!header) {
      return
    }

    if (observedHeader !== header) {
      resizeObserver?.disconnect()
      resizeObserver = null
      observedHeader = header
      lastPublishedHeight = ''

      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(publish)
        resizeObserver.observe(header)
      }
    }

    publish()
  }

  const handleViewportResize = (): void => {
    observe()
  }

  onMounted(() => {
    void nextTick().then(() => {
      observe()
      window.addEventListener('resize', handleViewportResize)
    })
  })

  onBeforeUnmount(() => {
    resizeObserver?.disconnect()
    resizeObserver = null
    observedHeader = null
    rootStyleBinding?.dispose()
    rootStyleBinding = null
    window.removeEventListener('resize', handleViewportResize)
  })
}
