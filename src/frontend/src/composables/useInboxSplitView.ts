import { computed, ref, watch, type Ref } from 'vue'
import { useMediaQuery } from '@/composables/useMediaQuery'

const MOBILE_BREAKPOINT = 1024

export function useInboxSplitView(selectedConversationId: Readonly<Ref<string>>) {
  const isMobile = useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
  const mobilePane = ref<'list' | 'detail'>('list')

  watch(isMobile, (nextIsMobile) => {
    if (!nextIsMobile) {
      mobilePane.value = 'detail'
      return
    }

    if (!selectedConversationId.value) {
      mobilePane.value = 'list'
    }
  }, { immediate: true })

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

  return {
    isMobile,
    mobilePane,
    showListPane: computed(() => !isMobile.value || mobilePane.value === 'list'),
    showDetailPane: computed(() => !isMobile.value || mobilePane.value === 'detail'),
    openListPane,
    openDetailPane
  }
}
