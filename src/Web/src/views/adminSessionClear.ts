import { onScopeDispose, watch } from 'vue'

export function watchAdminSessionClear(source: () => AbortSignal | readonly [unknown, AbortSignal],
  clear: () => void, dispose = clear) {
  watch(source, (value, _, cleanup) => {
    const signal = 'aborted' in value ? value : value[1]
    clear()
    signal.addEventListener('abort', clear, { once: true })
    cleanup(() => signal.removeEventListener('abort', clear))
  }, { flush: 'sync', immediate: true })
  onScopeDispose(dispose)
}
