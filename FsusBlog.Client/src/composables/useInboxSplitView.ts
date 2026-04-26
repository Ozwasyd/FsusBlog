import { computed, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'

const MOBILE_BREAKPOINT = 1024

export function useInboxSplitView(selectedConversationId: Readonly<Ref<string>>) {
  const isMobile = ref(false)
  const mobilePane = ref<'list' | 'detail'>('list')

  let resizeFrame: number | null = null

  const syncViewport = () => {
    const nextIsMobile = window.innerWidth < MOBILE_BREAKPOINT
    isMobile.value = nextIsMobile

    if (!nextIsMobile) {
      mobilePane.value = 'detail'
      return
    }

    if (!selectedConversationId.value) {
      mobilePane.value = 'list'
    }
  }

  const handleResize = () => {
    if (resizeFrame !== null) {
      return
    }

    resizeFrame = window.requestAnimationFrame(() => {
      syncViewport()
      resizeFrame = null
    })
  }

  const openListPane = (): void => {
    mobilePane.value = 'list'
  }

  const openDetailPane = (): void => {
    mobilePane.value = 'detail'
  }

  watch(selectedConversationId, (value) => {
    if (isMobile.value && !value) {
      mobilePane.value = 'list'
    }
  })

  onMounted(() => {
    syncViewport()
    window.addEventListener('resize', handleResize, { passive: true })
  })

  onUnmounted(() => {
    if (resizeFrame !== null) {
      window.cancelAnimationFrame(resizeFrame)
    }

    window.removeEventListener('resize', handleResize)
  })

  return {
    isMobile,
    mobilePane,
    showListPane: computed(() => !isMobile.value || mobilePane.value === 'list'),
    showDetailPane: computed(() => !isMobile.value || mobilePane.value === 'detail'),
    openListPane,
    openDetailPane
  }
}
