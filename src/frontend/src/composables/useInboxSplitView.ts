import { computed, ref, type Ref } from 'vue'
import { useMediaQuery } from '@/composables/useMediaQuery'

const MOBILE_BREAKPOINT = 1024

export function useInboxSplitView(selectedConversationId: Readonly<Ref<string>>) {
  const isMobile = useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
  const requestedMobilePane = ref<'list' | 'detail'>('list')
  const mobilePane = computed<'list' | 'detail'>(() => {
    if (!isMobile.value) {
      return 'detail'
    }

    return selectedConversationId.value ? requestedMobilePane.value : 'list'
  })

  const openListPane = (): void => {
    requestedMobilePane.value = 'list'
  }

  const openDetailPane = (): void => {
    requestedMobilePane.value = 'detail'
  }

  return {
    isMobile,
    mobilePane,
    showListPane: computed(() => !isMobile.value || mobilePane.value === 'list'),
    showDetailPane: computed(() => !isMobile.value || mobilePane.value === 'detail'),
    openListPane,
    openDetailPane
  }
}
