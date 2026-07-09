import { nextTick, onBeforeUnmount, onMounted, type Ref } from 'vue'

const headerSelector = '.el-public-shell__header'
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

  const resolveHeader = (): HTMLElement | null =>
    rootRef.value?.querySelector<HTMLElement>(headerSelector) ?? null

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

    root.style.setProperty(publicStickyGeometryTokens.headerHeight, headerHeight)
    root.style.setProperty(publicStickyGeometryTokens.stickyTop, headerHeight)
    root.style.setProperty(publicStickyGeometryTokens.anchorOffset, `calc(${headerHeight} + ${anchorGap})`)
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
    window.removeEventListener('resize', handleViewportResize)
  })
}
