import { ref } from 'vue'
import { useWindowEvents } from '@/composables/useWindowEvents'

export function useViewportWidth(fallbackWidth = 1440) {
  const width = ref(typeof window !== 'undefined' ? window.innerWidth : fallbackWidth)

  const syncViewportWidth = (): void => {
    width.value = window.innerWidth
  }

  useWindowEvents([{ name: 'resize', handler: syncViewportWidth }])

  return width
}
