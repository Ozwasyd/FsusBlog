import { onMounted, onUnmounted } from 'vue'

type PublicShellActionDetail = {
  action?: string
}

type UsePublicShellActionBridgeOptions = {
  onPageNext?: () => void
  onPagePrev?: () => void
}

export function usePublicShellActionBridge(options: UsePublicShellActionBridgeOptions): void {
  const onAotAction = (event: Event) => {
    const detail = (event as CustomEvent<PublicShellActionDetail>).detail
    const action = detail?.action ?? ''

    if (action === 'page-next') {
      options.onPageNext?.()
      return
    }

    if (action === 'page-prev') {
      options.onPagePrev?.()
    }
  }

  onMounted(() => {
    window.addEventListener('fsus:aot:event', onAotAction)
  })

  onUnmounted(() => {
    window.removeEventListener('fsus:aot:event', onAotAction)
  })
}
